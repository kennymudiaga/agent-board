import { describe, it, expect } from 'vitest';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token';

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

async function heartbeat(app: App, agentId: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return api(app, 'POST', '/v1/heartbeat', {
    headers,
    body: { agentId, roles: [], boards: ['sprint-8'], interval: 15, ...extra },
  });
}

async function mintToken(app: App, agentId: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await api(app, 'POST', '/v1/tokens', { headers, body: { agentId } });
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

function rpc(id: number, method: string, params: unknown) {
  return { jsonrpc: '2.0', id, method, params: params as Record<string, unknown> };
}

/** Sequential SSE read (mirrors the dashboard test): consumes the next chunk. */
async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

/** Bounded read used only where a chunk is EXPECTED NOT to arrive. */
async function readChunkTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<string> {
  const r = await Promise.race([
    reader.read().then(({ value }) => new TextDecoder().decode(value ?? undefined)),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), ms)),
  ]);
  return r;
}

describe('A2A tasks/query + SSE task events (sprint 10 T4 — docs/a2a.md)', () => {
  it('tasks/query lists and filters tasks by board/to/state', async () => {
    const { store, app } = (() => {
      const store = new Store(':memory:');
      return { store, app: createApp(store, { token: TOKEN }) };
    })();
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', {}, { boards: ['sprint-8'] });

    // Send the first task and COMPLETE it, then send the second task — that
    // way the states are unambiguous (a pickup claims every pending role:qa
    // message in one call, so both cannot hang in different claim states).
    const ids: string[] = [];
    const first = await a2a(app, 'a2a-1', relay, rpc(1, 'tasks/send', { message: { parts: [{ text: 'review PR #12' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } }));
    ids.push((await first.json()).result.id);
    await heartbeat(app, 'qa-1', {}, { roles: ['qa'], boards: ['sprint-8'] });
    await api(app, 'GET', '/v1/boards/sprint-8/messages?since=0&wait=0', { agent: 'qa-1' });
    await api(app, 'POST', `/v1/messages/${ids[0]}/ack`, { agent: 'qa-1', body: { status: 'done' } });
    const second = await a2a(app, 'a2a-1', relay, rpc(2, 'tasks/send', { message: { parts: [{ text: 'write release notes' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } }));
    ids.push((await second.json()).result.id);

    // Unfiltered -> both tasks with mapped states.
    const all = await (await a2a(app, 'a2a-1', relay, rpc(3, 'tasks/query', {}))).json();
    expect(all.error).toBeUndefined();
    const tasks = all.result.tasks as { id: string; status: { state: string } }[];
    expect(tasks).toHaveLength(2);
    const byId = new Map(tasks.map((t) => [t.id, t.status.state]));
    expect(byId.get(ids[0])).toBe('completed');
    expect(byId.get(ids[1])).toBe('submitted');

    // Filter by state.
    const completed = await (await a2a(app, 'a2a-1', relay, rpc(4, 'tasks/query', { state: 'completed' }))).json();
    expect(completed.result.tasks.map((t: { id: string }) => t.id)).toEqual([ids[0]]);
    const submitted = await (await a2a(app, 'a2a-1', relay, rpc(5, 'tasks/query', { state: 'submitted' }))).json();
    expect(submitted.result.tasks.map((t: { id: string }) => t.id)).toEqual([ids[1]]);

    // Filter by to / board / type.
    const byTo = await (await a2a(app, 'a2a-1', relay, rpc(6, 'tasks/query', { to: 'role:qa' }))).json();
    expect(byTo.result.tasks).toHaveLength(2);
    const byOther = await (await a2a(app, 'a2a-1', relay, rpc(7, 'tasks/query', { to: 'agent:nobody' }))).json();
    expect(byOther.result.tasks).toHaveLength(0);
    const byBoard = await (await a2a(app, 'a2a-1', relay, rpc(8, 'tasks/query', { board: 'sprint-8', type: 'request' }))).json();
    expect(byBoard.result.tasks).toHaveLength(2);

    // Validation errors.
    expect((await (await a2a(app, 'a2a-1', relay, rpc(9, 'tasks/query', { state: 'finished' }))).json()).error.code).toBe(-32602);
    expect((await (await a2a(app, 'a2a-1', relay, rpc(10, 'tasks/query', { to: 'broadcast' }))).json()).error.code).toBe(-32602);
    expect((await (await a2a(app, 'a2a-1', relay, rpc(11, 'tasks/query', { limit: 0 }))).json()).error.code).toBe(-32602);
    store.close();
  });

  it('streams task created/working/completed events on the SSE endpoint', async () => {
    const store = new Store(':memory:');
    const app = createApp(store, { token: TOKEN });
    const relay = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', {}, { boards: ['sprint-8'] });

    // Auth: wrong token -> 401; query-param token -> opens.
    expect((await app.request(`/a2a/a2a-1/events?token=wrong`)).status).toBe(401);
    const res = await app.request(`/a2a/a2a-1/events?token=${relay}`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    const hello = await readChunk(reader);
    expect(hello).toContain('event: hello');

    // Send a task -> created (submitted).
    const sent = await a2a(app, 'a2a-1', relay, rpc(1, 'tasks/send', { message: { parts: [{ text: 'review PR #12' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } }));
    const taskId = (await sent.json()).result.id;
    const created = await readChunk(reader);
    expect(created).toContain('event: task');
    expect(created).toContain(`"id":"${taskId}"`);
    expect(created).toContain('"state":"submitted"');

    // qa worker claims -> working.
    await heartbeat(app, 'qa-1', {}, { roles: ['qa'], boards: ['sprint-8'] });
    await api(app, 'GET', '/v1/boards/sprint-8/messages?since=0&wait=0', { agent: 'qa-1' });
    const working = await readChunk(reader);
    expect(working).toContain('event: task');
    expect(working).toContain('"state":"working"');

    // Ack done -> completed.
    await api(app, 'POST', `/v1/messages/${taskId}/ack`, { agent: 'qa-1', body: { status: 'done' } });
    const completed = await readChunk(reader);
    expect(completed).toContain('event: task');
    expect(completed).toContain('"state":"completed"');

    await reader.cancel();
    store.close();
  }, 10_000);

  it('cross-workspace isolation: tasks/query and the SSE stream never leak (sprint 8 W4 negative test)', async () => {
    const store = new Store(':memory:');
    const app = createApp(store, { token: TOKEN });

    // Workspace B (team-b): minted with the default admin token.
    const wsB = await api(app, 'POST', '/v1/workspaces', { body: { id: 'team-b' } });
    expect(wsB.status).toBe(201);
    const tokenB = (await wsB.json()).token as string;
    const hdrB = { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json' };
    await heartbeat(app, 'relay-b', hdrB, { boards: ['sprint-8'] });
    const relayB = await mintToken(app, 'relay-b', hdrB);

    // Workspace A: relay agent + a task it sends.
    const relayA = await mintToken(app, 'a2a-1');
    await heartbeat(app, 'a2a-1', {}, { boards: ['sprint-8'] });
    await a2a(app, 'a2a-1', relayA, rpc(1, 'tasks/send', { message: { parts: [{ text: 'top secret task' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } }));

    // B's tasks/query sees B's own (empty) task space — A's task is invisible.
    const qB = await (await a2a(app, 'relay-b', relayB, rpc(2, 'tasks/query', { board: 'sprint-8' }))).json();
    expect(qB.error).toBeUndefined();
    expect(qB.result.tasks).toHaveLength(0);

    // B's SSE stream never emits A's task events.
    const streamB = await app.request(`/a2a/relay-b/events?token=${relayB}`);
    expect(streamB.status).toBe(200);
    const readerB = streamB.body!.getReader();
    const helloB = await readChunk(readerB);
    expect(helloB).toContain('event: hello');
    // A emits a second task while B is subscribed to its own stream.
    await a2a(app, 'a2a-1', relayA, rpc(3, 'tasks/send', { message: { parts: [{ text: 'another secret' }] }, metadata: { board: 'sprint-8', to: 'role:qa' } }));
    // B's stream stays silent within the window — no cross-workspace leakage.
    const silence = await readChunkTimeout(readerB, 500);
    expect(silence).not.toContain('event: task');
    expect(silence).not.toContain('another secret');

    await readerB.cancel();
    store.close();
  }, 10_000);
});