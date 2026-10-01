import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import { Store } from '../../server/src/db.ts';
import { createApp } from '../../server/src/app.ts';
import { tools, callTool, identity } from '../src/tools.js';

const TOKEN = 'mcp-test-token';

let server;
let baseUrl;
let store;

beforeAll(async () => {
  store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  const srv = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => srv.once('listening', r));
  server = srv;
  baseUrl = `http://127.0.0.1:${srv.address().port}`;

  process.env.AB_SERVER = baseUrl;
  process.env.AB_TOKEN = TOKEN;
  process.env.AB_AGENT_ID = 'mcp-agent';
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  store.close();
  delete process.env.AB_SERVER;
  delete process.env.AB_TOKEN;
  delete process.env.AB_AGENT_ID;
});

const out = (r) => JSON.parse(r.content[0].text);

describe('agentboard-mcp tools (T1)', () => {
  beforeEach(async () => {
    // Fresh identity each test. roles:'' pins an identity-less agent so the
    // ambient AB_ROLES / workspace config never leaks into the directory
    // (issue #46: list_agents/list_boards must be env-independent).
    await callTool('heartbeat', { interval: 15, status: 'idle', board: 'sprint-8', roles: '' });
  });
  afterEach(() => {
    // Clean the board between tests.
    for (const row of store.db.prepare('SELECT id FROM messages WHERE board = ?').all('sprint-8')) {
      store.deleteMessage(row.id, 'mcp-agent');
    }
    store.db.prepare('DELETE FROM agents').run();
    store.db.prepare('DELETE FROM boards').run();
  });

  it('whoami reports identity from env without a server call', async () => {
    const r = await callTool('whoami', {});
    expect(r.content[0].type).toBe('text');
    const info = out(r);
    expect(info.agentId).toBe('mcp-agent');
    expect(info.server).toBe(baseUrl);
    expect(info.env.token).toBe(true);
  });

  it('heartbeat registers the agent and returns presence', async () => {
    const r = await callTool('heartbeat', { interval: 15, status: 'busy', task: 'reviewing PR #12', board: 'sprint-8' });
    const info = out(r);
    expect(info.agent).toMatchObject({ agentId: 'mcp-agent', status: 'busy', currentTask: 'reviewing PR #12' });
    expect(info.presence.ttl).toBe(45);
  });

  it('send creates a message; read claims it; ack finalizes it', async () => {
    const sent = out(await callTool('send', { board: 'sprint-8', to: 'agent:mcp-agent', type: 'request', message: 'review PR #12' }));
    expect(sent).toMatchObject({ board: 'sprint-8', to: 'agent:mcp-agent', type: 'request', state: 'pending' });

    const read = out(await callTool('read', { board: 'sprint-8', wait: 0 }));
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0].id).toBe(sent.id);
    expect(read.messages[0].state).toBe('claimed');
    expect(typeof read.watermark).toBe('number');

    const acked = out(await callTool('ack', { id: sent.id, status: 'done' }));
    expect(acked.state).toBe('done');
  });

  it('send validates payload JSON and reports errors as text', async () => {
    const bad = out(await callTool('send', { board: 'sprint-8', to: 'agent:mcp-agent', payload: '{not json' }));
    expect(bad.error).toContain('valid JSON');

    const noAuth = await callTool('whoami', {});
    const saved = process.env.AB_TOKEN;
    process.env.AB_TOKEN = 'wrong';
    try {
      const r = await callTool('heartbeat', { interval: 15 });
      expect(out(r).error.message).toContain('bearer token');
    } finally {
      process.env.AB_TOKEN = saved;
    }
    void noAuth;
  });

  it('list_agents and list_boards are read-only and correct', async () => {
    const agents = out(await callTool('list_agents', { role: 'qa' }));
    expect(agents).toHaveLength(0); // mcp-agent has no roles in this run

    const boards = out(await callTool('list_boards', {}));
    expect(boards.map((b) => b.name)).toContain('sprint-8');
  });

  it('requeue and purge manage dead letters (sender-gated)', async () => {
    const sent = out(await callTool('send', { board: 'sprint-8', to: 'agent:mcp-agent', type: 'note', message: 'flaky' }));
    // Fail it to dead (3 attempts).
    for (let i = 0; i < 3; i++) {
      await callTool('read', { board: 'sprint-8', wait: 0 });
      await callTool('ack', { id: sent.id, status: 'failed', error: `boom ${i}` });
    }
    const requeued = out(await callTool('requeue', { id: sent.id }));
    expect(requeued.state).toBe('pending');
    expect(requeued.attempts).toBe(0);

    const purged = out(await callTool('purge', { id: sent.id }));
    expect(purged).toMatchObject({ ok: true });
    const gone = out(await callTool('requeue', { id: sent.id }));
    expect(gone.error.message).toContain('unknown message');
  });

  it('exposes exactly the nine planned tools with schemas', () => {
    expect(Object.keys(tools).sort()).toEqual([
      'ack', 'heartbeat', 'list_agents', 'list_boards', 'purge', 'read', 'requeue', 'send', 'whoami',
    ]);
    for (const t of Object.values(tools)) {
      expect(t.inputSchema).toBeDefined();
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('identity() never requires a config file (env-only)', () => {
    const cfg = identity();
    expect(cfg.agentId).toBe('mcp-agent');
    expect(cfg.token).toBe(TOKEN);
  });
});