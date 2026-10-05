import { describe, it, expect } from 'vitest';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token';

function makeCtx() {
  const store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  return { store, app };
}

type App = ReturnType<typeof createApp>;

function api(app: App, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; agent?: string } = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
    ...(opts.headers ?? {}),
  };
  return app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function heartbeat(app: App, agentId: string, extra: Record<string, unknown> = {}) {
  return api(app, 'POST', '/v1/heartbeat', { body: { agentId, roles: [], boards: ['sprint-8'], interval: 15, ...extra } });
}

async function mintToken(app: App, agentId: string): Promise<string> {
  const res = await api(app, 'POST', '/v1/tokens', { body: { agentId } });
  expect(res.status).toBe(201);
  return (await res.json()).token as string;
}

function a2a(app: App, agentId: string, token: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(`/a2a/${agentId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('A2A relay (sprint 4 — docs/a2a.md)', () => {
  it('serves the Agent Card at /.well-known/agent.json?agent=<id> and /a2a/<id>', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'a2a-1', { roles: ['qa'], boards: ['sprint-8'] });

    const res = await app.request('/.well-known/agent.json?agent=a2a-1');
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card['@type']).toBe('AgentCard');
    expect(card.name).toBe('agentboard:a2a-1');
    expect(card.endpoints[0]).toMatchObject({ protocol: 'a2a', url: expect.stringContaining('/a2a/a2a-1') });
    expect(card.skills.map((s: { id: string }) => s.id)).toContain('role:qa');
    expect(card.boards).toEqual(['sprint-8']);

    // The endpoint URL itself serves the card (A2A discovery convention).
    const direct = await app.request('/a2a/a2a-1');
    expect(direct.status).toBe(200);
    expect((await direct.json()).url).toBe(card.url);

    // Discovery without an agent is a clear error.
    const none = await app.request('/.well-known/agent.json');
    expect(none.status).toBe(400);
    expect((await none.json()).error.message).toContain('?agent=');
  });

  it('requires the agent\'s own per-agent token — workspace token is not enough (no admin escalation)', async () => {
    const { app } = makeCtx();
    const t1 = await mintToken(app, 'a2a-1');
    const t2 = await mintToken(app, 'a2a-2');
    const body = { jsonrpc: '2.0', id: 1, method: 'tasks/send', params: { message: { role: 'user', parts: [{ text: 'hi' }] } } };

    // Workspace token -> 401.
    const ws = await a2a(app, 'a2a-1', TOKEN, body);
    expect(ws.status).toBe(401);
    expect((await ws.json()).error.code).toBe(-32001);

    // Another agent's token -> 401.
    const other = await a2a(app, 'a2a-1', t2, body);
    expect(other.status).toBe(401);

    // The agent's own token -> 200.
    const own = await a2a(app, 'a2a-1', t1, body);
    expect(own.status).toBe(200);
  });

  it('tasks/send drops a board request; tasks/get tracks the thread to completed with the response as result', async () => {
    const { app } = makeCtx();
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', { boards: ['sprint-8'] });

    const sent = await a2a(app, 'a2a-1', relay, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/send',
      params: {
        message: { role: 'user', parts: [{ text: 'review PR #12' }] },
        metadata: { board: 'sprint-8', to: 'role:qa' },
      },
    });
    expect(sent.status).toBe(200);
    const task = (await sent.json()).result;
    expect(task.id).toMatch(/^msg_/);
    expect(task.status.state).toBe('submitted');
    expect(task.metadata).toEqual({ board: 'sprint-8', to: 'role:qa' });

    // The request is on the board as a request to role:qa from a2a-1.
    const view = await api(app, 'GET', '/v1/boards/sprint-8/messages?since=0', {});
    const msgs = (await view.json()).messages;
    expect(msgs).toContainEqual(expect.objectContaining({ id: task.id, from: 'a2a-1', to: 'role:qa', type: 'request', state: 'pending' }));

    // A qa worker picks it up, answers, and acks (the normal `ab` flow).
    await heartbeat(app, 'qa-1', { roles: ['qa'], boards: ['sprint-8'] });
    const pickup = await api(app, 'GET', `/v1/boards/sprint-8/messages?since=0&wait=0`, { agent: 'qa-1' });
    const picked = (await pickup.json()).messages.find((m: { id: string }) => m.id === task.id);
    expect(picked.state).toBe('claimed');

    await api(app, 'POST', '/v1/boards/sprint-8/messages', {
      agent: 'qa-1',
      body: { to: 'agent:a2a-1', type: 'response', replyTo: task.id, payload: { text: 'approved — LGTM' } },
    });
    const acked = await api(app, 'POST', `/v1/messages/${task.id}/ack`, { agent: 'qa-1', body: { status: 'done' } });
    expect(acked.status).toBe(200);

    // The client polls to completed with the response as the artifact.
    const got = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: task.id } });
    const done = (await got.json()).result;
    expect(done.status.state).toBe('completed');
    expect(done.artifacts[0].parts[0].text).toBe('approved — LGTM');
    expect(done.history.map((h: { role: string }) => h.role)).toEqual(['user', 'agent']);
  });

  it('tasks/get maps dead and expired threads to failed', async () => {
    const { app } = makeCtx();
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', { boards: ['sprint-8'] });
    await heartbeat(app, 'qa-1', { roles: ['qa'], boards: ['sprint-8'] });

    // Dead: fail the request 3 times.
    const sent = await a2a(app, 'a2a-1', relay, {
      jsonrpc: '2.0', id: 1, method: 'tasks/send',
      params: { message: { role: 'user', parts: [{ text: 'flaky' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } },
    });
    const task = (await sent.json()).result;
    for (let i = 0; i < 3; i++) {
      await api(app, 'GET', '/v1/boards/sprint-8/messages?since=0&wait=0', { agent: 'qa-1' }); // claim
      await api(app, 'POST', `/v1/messages/${task.id}/ack`, { agent: 'qa-1', body: { status: 'failed', error: `boom ${i}` } });
    }
    const dead = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: task.id } });
    expect((await dead.json()).result.status).toMatchObject({ state: 'failed', message: expect.stringContaining('dead-lettered') });

    // Expired: a question with a past deadline.
    const past = new Date(Date.now() - 60_000).toISOString();
    const q = await a2a(app, 'a2a-1', relay, {
      jsonrpc: '2.0', id: 3, method: 'tasks/send',
      params: {
        message: { role: 'user', parts: [{ text: 'ship today?' }] },
        metadata: { board: 'sprint-8', to: 'role:qa', type: 'question', deadline: past },
      },
    });
    const qt = (await q.json()).result;
    const expired = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: qt.id } });
    expect((await expired.json()).result.status).toMatchObject({ state: 'failed', message: expect.stringContaining('deadline') });
  });

  it('tasks/cancel purges a pending request; claimed tasks are not cancelable', async () => {
    const { app } = makeCtx();
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', { boards: ['sprint-8'] });
    await heartbeat(app, 'qa-1', { roles: ['qa'], boards: ['sprint-8'] });

    // Pending -> canceled (message purged; tasks/get -> not found).
    const sent = await a2a(app, 'a2a-1', relay, {
      jsonrpc: '2.0', id: 1, method: 'tasks/send',
      params: { message: { role: 'user', parts: [{ text: 'never mind' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } },
    });
    const task = (await sent.json()).result;
    const canceled = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: task.id } });
    expect((await canceled.json()).result.status.state).toBe('canceled');
    const gone = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: task.id } });
    expect((await gone.json()).error.code).toBe(-32002);

    // Claimed -> -32003.
    const sent2 = await a2a(app, 'a2a-1', relay, {
      jsonrpc: '2.0', id: 4, method: 'tasks/send',
      params: { message: { role: 'user', parts: [{ text: 'too late' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } },
    });
    const task2 = (await sent2.json()).result;
    await api(app, 'GET', '/v1/boards/sprint-8/messages?since=0&wait=0', { agent: 'qa-1' });
    const noCancel = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { id: task2.id } });
    expect((await noCancel.json()).error.code).toBe(-32003);
  });

  it('rejects broadcasts and malformed params with JSON-RPC errors', async () => {
    const { app } = makeCtx();
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', { boards: ['sprint-8'] });

    const broadcast = await a2a(app, 'a2a-1', relay, {
      jsonrpc: '2.0', id: 1, method: 'tasks/send',
      params: { message: { role: 'user', parts: [{ text: 'hi all' }] }, metadata: { board: 'sprint-8', to: 'broadcast' } },
    });
    const bErr = (await broadcast.json()).error;
    expect(bErr.code).toBe(-32602);
    expect(bErr.message).toContain('broadcast');

    const noParts = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 2, method: 'tasks/send', params: { message: { role: 'user', parts: [] } } });
    expect((await noParts.json()).error.code).toBe(-32602);

    const unknown = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 3, method: 'tasks/unknown', params: {} });
    expect((await unknown.json()).error.code).toBe(-32601);

    const badJson = await app.request('/a2a/a2a-1', {
      method: 'POST',
      headers: { authorization: `Bearer ${relay}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect((await badJson.json()).error.code).toBe(-32700);
  });

  it('idempotent tasks/send: same idempotencyKey returns a duplicate error, not a second message', async () => {
    const { app, store } = makeCtx();
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', { boards: ['sprint-8'] });
    const params = {
      message: { role: 'user', parts: [{ text: 'once only' }] },
      metadata: { board: 'sprint-8', to: 'role:qa', idempotencyKey: 'k-1' },
    };
    const first = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 1, method: 'tasks/send', params });
    expect((await first.json()).result.status.state).toBe('submitted');
    const second = await a2a(app, 'a2a-1', relay, { jsonrpc: '2.0', id: 2, method: 'tasks/send', params });
    const dup = (await second.json()).error;
    expect(dup).toBeDefined();
    expect(dup.message).toContain('duplicate');
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(count.n).toBe(1);
  });
});