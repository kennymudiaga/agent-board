import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Store } from '../../server/src/db.ts';
import { createApp } from '../../server/src/app.ts';

const TOKEN = 'mcp-e2e-token';
const SERVER = fileURLToPath(new URL('../bin/server.js', import.meta.url));

let boardServer;
let baseUrl;
let store;
let mcp;
let rl;

function send(obj) {
  mcp.stdin.write(`${JSON.stringify(obj)}\n`);
}

function waitFor(id) {
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      const msg = JSON.parse(line);
      if (msg.id === id) {
        rl.off('line', onLine);
        resolve(msg);
      }
    };
    rl.on('line', onLine);
    setTimeout(() => {
      rl.off('line', onLine);
      reject(new Error(`timeout waiting for id ${id}`));
    }, 10_000);
  });
}

beforeAll(async () => {
  store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  const srv = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => srv.once('listening', r));
  boardServer = srv;
  baseUrl = `http://127.0.0.1:${srv.address().port}`;

  mcp = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AB_SERVER: baseUrl, AB_TOKEN: TOKEN, AB_AGENT_ID: 'e2e-agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
  rl = createInterface({ input: mcp.stdout });

  // MCP handshake.
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } } });
  const init = await waitFor(1);
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
});

afterAll(async () => {
  mcp.kill();
  await new Promise((r) => boardServer.close(r));
  store.close();
});

describe('agentboard-mcp end-to-end over stdio (T1)', () => {
  it('lists the nine tools', async () => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await waitFor(2);
    expect(res.result.tools.map((t) => t.name).sort()).toEqual([
      'ack', 'heartbeat', 'list_agents', 'list_boards', 'purge', 'read', 'requeue', 'send', 'whoami',
    ]);
  });

  it('drives the full board lifecycle through tools/call', async () => {
    send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'heartbeat', arguments: { interval: 15, status: 'busy', task: 'e2e', board: 'sprint-8', roles: 'qa' } },
    });
    const hb = await waitFor(3);
    expect(JSON.parse(hb.result.content[0].text).agent.agentId).toBe('e2e-agent');

    send({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'send', arguments: { board: 'sprint-8', to: 'role:qa', type: 'request', message: 'review via MCP' } },
    });
    const sent = await waitFor(4);
    const msg = JSON.parse(sent.result.content[0].text);
    expect(msg.state).toBe('pending');

    send({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'read', arguments: { board: 'sprint-8', wait: 0 } },
    });
    const read = await waitFor(5);
    const view = JSON.parse(read.result.content[0].text);
    expect(view.messages[0].id).toBe(msg.id);
    expect(view.messages[0].state).toBe('claimed');

    send({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'ack', arguments: { id: msg.id, status: 'done' } },
    });
    const acked = await waitFor(6);
    expect(JSON.parse(acked.result.content[0].text).state).toBe('done');

    send({
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });
    const who = await waitFor(7);
    expect(JSON.parse(who.result.content[0].text).agentId).toBe('e2e-agent');
  });

  it('returns tool errors as text without dying', async () => {
    send({
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'send', arguments: { board: 'sprint-8', to: 'nonsense', message: 'x' } },
    });
    const res = await waitFor(8);
    expect(JSON.parse(res.result.content[0].text).error.message).toContain('to must be');

    // Server still alive for the next call.
    send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const who = await waitFor(9);
    expect(who.result).toBeDefined();
  });
});