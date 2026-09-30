/**
 * AgentBoard VS Code extension — thin shell over the `ab` CLI.
 *
 * - Board panel (webview): presence + board messages, live via SSE.
 * - Commands: Open board, Join board, Send note, Set token.
 * - Background heartbeat: shells out to `ab heartbeat --once` on a timer.
 *
 * The token lives in VS Code SecretStorage — never in settings or the webview.
 */
const vscode = require('vscode');
const { fetchBoardState, watchBoard } = require('./src/board.js');
const { abHeartbeat, abSendNote, findAb } = require('./src/heartbeat.js');

const TOKEN_KEY = 'agentboard.token';

/** @type {{ panel?: vscode.WebviewPanel, watcher?: { close(): void }, timer?: NodeJS.Timeout }} */
let state = {};

function cfg() {
  const s = vscode.workspace.getConfiguration('agentboard');
  return {
    server: s.get('server', 'http://localhost:8080').replace(/\/$/, ''),
    agentId: s.get('agentId', 'vscode-agent'),
    board: s.get('board', 'sprint-8'),
    heartbeatInterval: s.get('heartbeatInterval', 30),
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
}

function activate(context) {
  // The CLI is the client — warn early when it isn't installed.
  findAb().then((ab) => {
    if (!ab) {
      vscode.window.showWarningMessage('AgentBoard: `ab` CLI not found on PATH. Install it with `npm i -g @agentboard/cli`.');
    }
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('agentboard.setToken', () => setToken(context)),
    vscode.commands.registerCommand('agentboard.openBoard', () => openBoard(context)),
    vscode.commands.registerCommand('agentboard.joinBoard', () => joinBoard(context)),
    vscode.commands.registerCommand('agentboard.sendNote', () => sendNote(context)),
  );
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

  const refresh = async () => {
    try {
      const view = await fetchBoardState({ server: c.server, board: c.board, token });
      panel.webview.postMessage({ type: 'state', ...view });
      panel.webview.postMessage({ type: 'status', text: `listening on ${c.board} @ ${c.server}` });
    } catch (e) {
      panel.webview.postMessage({ type: 'status', text: `error: ${e.message}` });
    }
  };

  await refresh();
  state.watcher = watchBoard({ server: c.server, board: c.board, token }, () => refresh());
  startHeartbeat(context);

  panel.onDidDispose(() => {
    state.panel = undefined;
    if (state.watcher) {
      state.watcher.close();
      state.watcher = undefined;
    }
    // No zombie heartbeat timer after the panel closes (#21).
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
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
  if (state.panel) await refreshPanel(context);
}

async function refreshPanel(context) {
  const c = cfg();
  const token = await getToken(context);
  try {
    const view = await fetchBoardState({ server: c.server, board: c.board, token });
    state.panel?.webview.postMessage({ type: 'state', ...view });
  } catch {
    /* panel shows its own status line */
  }
}

function startHeartbeat(context) {
  if (state.timer) clearInterval(state.timer);
  const c = cfg();
  const tick = async () => {
    const token = await getToken(context);
    if (!token || !state.panel) return;
    const res = await abHeartbeat({ server: c.server, token, agentId: c.agentId, board: c.board, interval: c.heartbeatInterval });
    if (!res.ok && state.panel) {
      state.panel.webview.postMessage({ type: 'status', text: `heartbeat: ${res.error}` });
    }
  };
  tick();
  state.timer = setInterval(tick, c.heartbeatInterval * 1000);
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
  let view = { agents: [], messages: [] };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'state') { view = m; render(); }
    if (m.type === 'status') document.getElementById('status').textContent = m.text;
  });
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
}

module.exports = { activate, deactivate };