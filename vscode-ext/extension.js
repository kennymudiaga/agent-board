/**
 * AgentBoard VS Code extension — thin shell over the `ab` CLI.
 *
 * - Board panel (webview): presence + board messages, live via SSE.
 * - Sidebar view (tree): agents + board messages, same live data.
 * - Commands: Open board, Join board, Send note, Set token, Refresh.
 * - Background heartbeat: shells out to `ab heartbeat --once` on a timer.
 *
 * The token lives in VS Code SecretStorage — never in settings or the webview.
 * `activate` returns a small API used by the host-wiring UI tests.
 */
const vscode = require('vscode');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { fetchBoardState, watchBoard } = require('./src/board.js');
const { watchMail, mailText } = require('./src/wake.js');
const { abHeartbeat, abSendNote, findAb } = require('./src/heartbeat.js');

const TOKEN_KEY = 'agentboard.token';

/** @type {{ panel?: vscode.WebviewPanel, watcher?: { close(): void }, wakeWatcher?: { close(): void }, timer?: NodeJS.Timeout, tree?: vscode.TreeView<any> }} */
let state = {};
let treeProvider = null;
/** Notification seam (overridable by the host-wiring tests). */
let wakeNotifier = (m, context) =>
  vscode.window.showInformationMessage(`AgentBoard: ${mailText(m)}`, 'Open board').then((choice) => {
    if (choice === 'Open board') openBoard(context);
  });

function cfg() {
  const s = vscode.workspace.getConfiguration('agentboard');
  return {
    server: s.get('server', 'http://localhost:8080').replace(/\/$/, ''),
    agentId: s.get('agentId', 'vscode-agent'),
    board: s.get('board', 'sprint-8'),
    heartbeatInterval: s.get('heartbeatInterval', 30),
    wakePollSeconds: s.get('wake.pollSeconds', 10),
    wakeAutoHandle: s.get('wake.autoHandle', false),
  };
}

async function getToken(context) {
  return (await context.secrets.get(TOKEN_KEY)) ?? '';
}

async function setToken(context) {
  const token = await vscode.window.showInputBox({
    prompt: 'AgentBoard workspace token (stored in VS Code SecretStorage)',
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) return;
  await context.secrets.store(TOKEN_KEY, token);
  vscode.window.showInformationMessage('AgentBoard token stored (SecretStorage).');
  startWakeWatcher(context);
}

// ---------------------------------------------------------------- wake-on-mail

/** Wake capabilities the heartbeat declares (docs/conventions.md §9). */
function wakeCapabilities() {
  const caps = ['wake:vscode-notify'];
  if (cfg().wakeAutoHandle) caps.push('wake:vscode-headless');
  return caps;
}

function startWakeWatcher(context) {
  if (state.wakeWatcher) return;
  const c = cfg();
  getToken(context).then((token) => {
    if (!token || state.wakeWatcher) return;
    state.wakeWatcher = watchMail(
      { server: c.server, board: c.board, token, forId: c.agentId },
      (m) => {
        refreshAll(context); // sidebar bump + panel refresh
        wakeNotifier(m, context);
        if (cfg().wakeAutoHandle) handleMailHeadless(context, m);
      },
      { pollMs: c.wakePollSeconds * 1000 },
    );
  });
}

function stopWakeWatcher() {
  if (state.wakeWatcher) {
    state.wakeWatcher.close();
    state.wakeWatcher = undefined;
  }
}

/**
 * Opt-in headless handling (agentboard.wake.autoHandle): a consent-gated
 * `vscode.lm` turn answers the board directly; falls back to `opencode run`
 * in the integrated terminal when no chat model is available/consented
 * (LanguageModelError). Best-effort — the notification already fired.
 */
async function handleMailHeadless(context, m) {
  const prompt = `${mailText(m)}\n\nHandle this board message as the agent ${cfg().agentId}: if it is a request/question, pick it up with the ab CLI, act on it, reply with a response (--reply-to ${m.id}), and ack. Per docs/conventions.md §5.`;
  try {
    const models = await vscode.lm.selectChatModels();
    if (!models?.length) throw new Error('no chat models available');
    await models[0].sendRequest(
      [{ role: 'user', content: prompt }],
      { justification: `AgentBoard wake: handle ${m.id} from ${m.from}` },
      new vscode.CancellationTokenSource().token,
    );
    return;
  } catch (e) {
    // LanguageModelError (no consent/quota) or no models — terminal fallback.
    try {
      const brief = path.join(os.tmpdir(), `agentboard-wake-${m.id}.md`);
      fs.writeFileSync(brief, prompt);
      const term = vscode.window.createTerminal({ name: 'AgentBoard wake' });
      term.show();
      term.sendText(`opencode run --agent board-worker -f "${brief}"`);
    } catch (err) {
      vscode.window.showWarningMessage(`AgentBoard: wake auto-handle failed (${e.message ?? err.message}) — mail is in the board.`);
    }
  }
}

function activate(context) {
  // The CLI is the client — warn early when it isn't installed.
  findAb().then((ab) => {
    if (!ab) {
      vscode.window.showWarningMessage('AgentBoard: `ab` CLI not found on PATH. Install it with `npm i -g @agent_board/cli`.');
    }
  });

  treeProvider = new BoardTreeProvider(context);
  state.tree = vscode.window.createTreeView('agentboard.boardView', { treeDataProvider: treeProvider, showCollapseAll: true });
  state.tree.onDidChangeVisibility((e) => {
    if (e.visible) startSession(context);
    else maybeStopSession();
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('agentboard.setToken', () => setToken(context)),
    vscode.commands.registerCommand('agentboard.openBoard', () => openBoard(context)),
    vscode.commands.registerCommand('agentboard.joinBoard', () => joinBoard(context)),
    vscode.commands.registerCommand('agentboard.sendNote', () => sendNote(context)),
    vscode.commands.registerCommand('agentboard.refresh', () => refreshAll(context)),
  );

  // Wake-on-mail (sprint 5 T3): while VS Code is open, watch for mail
  // addressed to the user's agent — notify + sidebar bump, opt-in headless
  // handling. Runs regardless of panel/tree visibility.
  startWakeWatcher(context);

  // Exposed for the UI tests (and advanced users).
  return {
    setToken: (token) => context.secrets.store(TOKEN_KEY, token),
    getToken: () => getToken(context),
    treeProvider,
    refresh: () => refreshAll(context),
    _test: {
      setWakeNotifier: (fn) => {
        wakeNotifier = fn;
      },
      startWake: () => startWakeWatcher(context),
    },
  };
}

// ---------------------------------------------------------------- sidebar tree

class BoardTreeProvider {
  constructor(context) {
    this.context = context;
    this.view = { agents: [], messages: [] };
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  setView(view) {
    this.view = view;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (!element) {
      return [
        new vscode.TreeItem('Agents', vscode.TreeItemCollapsibleState.Collapsed),
        new vscode.TreeItem('Messages', vscode.TreeItemCollapsibleState.Collapsed),
      ];
    }
    if (element.label === 'Agents') {
      return this.view.agents.map((a) => {
        const item = new vscode.TreeItem(`${a.presence === 'online' ? '●' : '○'} ${a.agentId} — ${a.status}`, vscode.TreeItemCollapsibleState.None);
        item.description = a.currentTask || (a.roles || []).join(',') || '';
        return item;
      });
    }
    if (element.label === 'Messages') {
      return this.view.messages.map((m) => {
        const payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
        const item = new vscode.TreeItem(`${m.from} → ${m.to} [${m.type}]`, vscode.TreeItemCollapsibleState.None);
        item.description = `${m.state} · ${payload}`;
        item.tooltip = `${m.id} #${m.seq}\n${payload}\n${m.createdAt}`;
        return item;
      });
    }
    return [];
  }
}

// ---------------------------------------------------------------- sessions

async function refreshAll(context) {
  const c = cfg();
  const token = await getToken(context);
  if (!token) return;
  try {
    const view = await fetchBoardState({ server: c.server, board: c.board, token });
    treeProvider?.setView(view);
    state.panel?.webview.postMessage({ type: 'state', ...view });
    state.panel?.webview.postMessage({ type: 'status', text: `listening on ${c.board} @ ${c.server}` });
  } catch (e) {
    state.panel?.webview.postMessage({ type: 'status', text: `error: ${e.message}` });
  }
}

async function openBoard(context) {
  const c = cfg();
  const token = await getToken(context);
  if (!token) {
    const ok = await vscode.window.showWarningMessage('AgentBoard: no workspace token yet. Store one first.', 'Set token');
    if (ok === 'Set token') await setToken(context);
    return;
  }

  const panel = vscode.window.createWebviewPanel('agentboard.board', `AgentBoard: ${c.board}`, vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = webviewHtml();
  state.panel = panel;

  await refreshAll(context);
  startSession(context);

  panel.onDidDispose(() => {
    state.panel = undefined;
    maybeStopSession();
  });
}

async function joinBoard(context) {
  const c = cfg();
  const token = await getToken(context);
  if (!token) {
    vscode.window.showErrorMessage('AgentBoard: store a workspace token first (AgentBoard: Set token).');
    return;
  }
  // Membership is registered by the heartbeat; `ab join` needs a config file,
  // which the extension deliberately doesn't use (env-only CLI).
  const res = await abHeartbeat({ server: c.server, token, agentId: c.agentId, board: c.board, interval: c.heartbeatInterval });
  if (!res.ok) {
    vscode.window.showErrorMessage(`AgentBoard: join failed — ${res.error}`);
    return;
  }
  vscode.window.showInformationMessage(`AgentBoard: joined ${c.board} as ${c.agentId}.`);
  await openBoard(context);
}

async function sendNote(context) {
  const c = cfg();
  const token = await getToken(context);
  if (!token) {
    vscode.window.showErrorMessage('AgentBoard: store a workspace token first (AgentBoard: Set token).');
    return;
  }
  const text = await vscode.window.showInputBox({ prompt: `Broadcast note to ${c.board}:`, ignoreFocusOut: true });
  if (!text) return;
  const res = await abSendNote({ server: c.server, token, agentId: c.agentId, board: c.board, text });
  if (!res.ok) {
    vscode.window.showErrorMessage(`AgentBoard: send failed — ${res.error}`);
    return;
  }
  vscode.window.showInformationMessage(`AgentBoard: note broadcast to ${c.board}.`);
  await refreshAll(context);
}

async function startSession(context) {
  if (state.watcher) return;
  const c = cfg();
  const token = await getToken(context);
  if (!token) return;
  state.watcher = watchBoard({ server: c.server, board: c.board, token }, () => refreshAll(context));

  if (state.timer) clearInterval(state.timer);
  const tick = async () => {
    const token = await getToken(context);
    if (!token || !(state.panel || state.tree?.visible)) return;
    const res = await abHeartbeat({ server: c.server, token, agentId: c.agentId, board: c.board, interval: c.heartbeatInterval, capabilities: wakeCapabilities() });
    if (!res.ok && state.panel) {
      state.panel.webview.postMessage({ type: 'status', text: `heartbeat: ${res.error}` });
    }
  };
  tick();
  state.timer = setInterval(tick, c.heartbeatInterval * 1000);
}

function maybeStopSession() {
  if (state.panel || state.tree?.visible) return;
  if (state.watcher) {
    state.watcher.close();
    state.watcher = undefined;
  }
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}

function webviewHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  body { font: 13px/1.5 ui-monospace, Consolas, monospace; background: #1e1e1e; color: #d4d4d4; padding: 12px; }
  #status { color: #808080; font-size: 11px; margin-bottom: 12px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #808080; }
  .agent, .msg { background: #252526; border: 1px solid #333; border-radius: 6px; padding: 6px 10px; margin-bottom: 6px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .online { background: #4caf7d; } .offline { background: #444; }
  .badge { font-size: 10px; border: 1px solid #555; border-radius: 8px; padding: 0 6px; margin-left: 6px; color: #9cdcfe; }
  .meta { color: #808080; }
</style>
</head>
<body>
  <div id="status">connecting…</div>
  <h2>Presence</h2>
  <div id="agents"><p class="meta">no agents yet</p></div>
  <h2>Board</h2>
  <div id="messages"><p class="meta">no messages yet</p></div>
<script>
  const vscode = acquireVsCodeApi();
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { view = m; render(); }
    if (m.type === 'status') document.getElementById('status').textContent = m.text;
  });
  let view = { agents: [], messages: [] };
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function render() {
    document.getElementById('agents').innerHTML = view.agents.length
      ? view.agents.map((a) =>
          '<div class="agent"><span class="dot ' + a.presence + '"></span><b>' + esc(a.agentId) + '</b> ' +
          '<span class="meta">' + esc(a.status) + ' · ' + esc((a.roles || []).join(',') || 'no roles') + '</span>' +
          (a.currentTask ? ' <span class="meta">— ' + esc(a.currentTask) + '</span>' : '') + '</div>').join('')
      : '<p class="meta">no agents yet</p>';
    document.getElementById('messages').innerHTML = view.messages.length
      ? view.messages.map((m) =>
          '<div class="msg"><b>' + esc(m.from) + '</b> → ' + esc(m.to) +
          ' <span class="badge">' + m.state + '</span>' +
          '<div class="meta">' + esc(typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload)) + '</div></div>').join('')
      : '<p class="meta">no messages yet</p>';
  }
</script>
</body>
</html>`;
}

function deactivate() {
  if (state.timer) clearInterval(state.timer);
  if (state.watcher) state.watcher.close();
  stopWakeWatcher();
}

module.exports = { activate, deactivate };