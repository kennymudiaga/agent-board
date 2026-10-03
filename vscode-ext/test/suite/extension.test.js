/**
 * Host-wiring tests (sprint-3 T4): exercise the extension's VS Code
 * integration — activation, settings + SecretStorage, the join command's
 * heartbeat, the sidebar tree, and SSE-driven refresh — against a real board
 * server spawned from the built server dist.
 */
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const vscode = require('vscode');

const EXT_ID = 'kennymudiaga.agentboard-vscode';
const TOKEN = 'ui-test-token';
// Inside the extension host, process.execPath is Electron — spawn plain Node
// from PATH (overridable for odd environments).
const NODE = process.env.AGENTBOARD_TEST_NODE ?? 'node';

function waitForPort(proc, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no port logged. output=${buf.slice(0, 500)}`)), timeoutMs);
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const m = /listening on :(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    proc.stderr.on('data', (d) => {
      buf += `[stderr] ${d}`;
    });
  });
}

function waitFor(fn, what, { timeout = 20_000, interval = 300 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = async () => {
      try {
        const v = await fn();
        if (v) return resolve(v);
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

suite('AgentBoard extension host wiring', function () {
  this.timeout(60_000);

  let server;
  let baseUrl;
  let ext;

  suiteSetup(async () => {
    // Board server on an ephemeral port (in-memory DB).
    server = spawn(NODE, [path.resolve(__dirname, '../../../server/dist/index.js')], {
      env: { ...process.env, AB_TOKEN: TOKEN, AB_DB_PATH: ':memory:', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    baseUrl = await waitForPort(server);
    assert.ok(baseUrl, 'server did not report a port');

    ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found`);
    await ext.activate();

    // Configure + credential.
    const cfg = vscode.workspace.getConfiguration('agentboard');
    await cfg.update('server', baseUrl, vscode.ConfigurationTarget.Global);
    await cfg.update('agentId', 'ui-agent', vscode.ConfigurationTarget.Global);
    await cfg.update('board', 'sprint-8', vscode.ConfigurationTarget.Global);
    await cfg.update('heartbeatInterval', 5, vscode.ConfigurationTarget.Global);
    await cfg.update('wake.pollSeconds', 1, vscode.ConfigurationTarget.Global);
    await ext.exports.setToken(TOKEN);
  });

  suiteTeardown(async () => {
    server.kill();
  });

  test('activation exposes the test API', () => {
    assert.ok(ext.exports.setToken);
    assert.ok(ext.exports.treeProvider);
  });

  test('join board registers the agent via heartbeat', async () => {
    await vscode.commands.executeCommand('agentboard.joinBoard');

    await waitFor(async () => {
      const { agents } = await fetchJson(`${baseUrl}/v1/agents`);
      return agents.some((a) => a.agentId === 'ui-agent');
    }, 'ui-agent in the directory');
  });

  test('sidebar tree shows the agent', async () => {
    const provider = ext.exports.treeProvider;
    await waitFor(async () => {
      const children = await provider.getChildren(undefined);
      if (!children || !children.some((c) => c.label === 'Agents')) return false;
      const agents = await provider.getChildren(children.find((c) => c.label === 'Agents'));
      return agents.some((a) => a.label.includes('ui-agent'));
    }, 'ui-agent in the sidebar tree');
  });

  test('a posted message reaches the tree via SSE', async () => {
    // Post through the server (as another agent), then wait for the SSE-driven
    // refresh to surface it in the tree.
    const post = await fetch(`${baseUrl}/v1/boards/sprint-8/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-agent-id': 'producer-1' },
      body: JSON.stringify({ to: 'broadcast', type: 'note', payload: { text: 'hello from the UI test' } }),
    });
    assert.strictEqual(post.status, 201);

    const provider = ext.exports.treeProvider;
    await waitFor(async () => {
      const children = await provider.getChildren(undefined);
      const messages = children.find((c) => c.label === 'Messages');
      if (!messages) return false;
      const items = await provider.getChildren(messages);
      return items.some((i) => (i.description || '').includes('hello from the UI test'));
    }, 'message in the sidebar tree');
  });

  test('a message for the agent triggers the wake notification + sidebar bump (sprint 5 T3)', async () => {
    // Notification seam: capture instead of popping a real toast.
    const notifications = [];
    ext.exports._test.setWakeNotifier((m) => notifications.push(m));
    ext.exports._test.startWake();
    // Let the watcher's priming refresh complete — mail seen during the prime
    // is treated as pre-existing (by design, no backlog notifications).
    await new Promise((r) => setTimeout(r, 1500));

    // A request addressed to the user's agent (ui-agent) — not a broadcast.
    const post = await fetch(`${baseUrl}/v1/boards/sprint-8/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-agent-id': 'producer-1' },
      body: JSON.stringify({ to: 'agent:ui-agent', type: 'request', payload: { text: 'wake me for the review' } }),
    });
    assert.strictEqual(post.status, 201);

    await waitFor(() => notifications.some((m) => m.payload.text === 'wake me for the review'), 'wake notification fired');
    // The message is NOT claimed by the watcher — still pending for a real agent.
    const view = await fetchJson(`${baseUrl}/v1/boards/sprint-8/messages`);
    const req = view.messages.find((m) => m.payload.text === 'wake me for the review');
    assert.strictEqual(req.state, 'pending');

    // Sidebar bump: the message surfaced in the tree via the wake refresh.
    const provider = ext.exports.treeProvider;
    await waitFor(async () => {
      const children = await provider.getChildren(undefined);
      const messages = children.find((c) => c.label === 'Messages');
      if (!messages) return false;
      const items = await provider.getChildren(messages);
      return items.some((i) => (i.description || '').includes('wake me for the review'));
    }, 'woken message in the sidebar tree');
  });
});