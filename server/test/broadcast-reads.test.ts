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

async function join(app: App, agentId: string, board: string) {
  await api(app, 'POST', '/v1/heartbeat', { body: { agentId, roles: [], boards: [board], interval: 15 } });
}

describe('broadcast read-state aggregate (sprint 5 T6, spec §6.1)', () => {
  it('exposes per-reader reads counts in the observability view as members read', async () => {
    const { app } = makeCtx();
    await join(app, 'a-1', 'br-b1');
    await join(app, 'a-2', 'br-b1');
    await join(app, 'a-3', 'br-b1');

    const sent = await api(app, 'POST', '/v1/boards/br-b1/messages', { agent: 'producer-1', body: { to: 'broadcast', type: 'note', payload: { text: 'standup' } } });
    const msg = (await sent.json()).message;
    expect(msg.deliveries).toHaveLength(3);
    expect(msg.reads).toEqual({ total: 3, done: 0, pending: 3, claimed: 0, dead: 0, expired: 0 });

    // a-1 reads and finalizes its copy.
    await api(app, 'GET', '/v1/boards/br-b1/messages?since=0&wait=0', { agent: 'a-1' });
    await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'a-1', body: { status: 'done' } });

    const view = await api(app, 'GET', '/v1/boards/br-b1/messages?since=0', {});
    const observed = (await view.json()).messages.find((m: { id: string }) => m.id === msg.id);
    expect(observed.reads).toEqual({ total: 3, done: 1, pending: 2, claimed: 0, dead: 0, expired: 0 });
    expect(observed.deliveries.map((d: { readerId: string }) => d.readerId).sort()).toEqual(['a-1', 'a-2', 'a-3']);

    // Everyone reads -> aggregate done + reads done = total.
    for (const agent of ['a-2', 'a-3']) {
      await api(app, 'GET', '/v1/boards/br-b1/messages?since=0&wait=0', { agent });
      await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent, body: { status: 'done' } });
    }
    const doneView = await api(app, 'GET', '/v1/boards/br-b1/messages?since=0', {});
    const done = (await doneView.json()).messages.find((m: { id: string }) => m.id === msg.id);
    expect(done.state).toBe('done');
    expect(done.reads).toEqual({ total: 3, done: 3, pending: 0, claimed: 0, dead: 0, expired: 0 });
  });

  it('non-broadcast messages carry no reads aggregate', async () => {
    const { app } = makeCtx();
    await join(app, 'a-1', 'br-b2');
    const sent = await api(app, 'POST', '/v1/boards/br-b2/messages', { agent: 'producer-1', body: { to: 'agent:a-1', type: 'request', payload: { text: 'hi' } } });
    const msg = (await sent.json()).message;
    expect(msg.reads).toBeUndefined();
    expect(msg.deliveries).toBeUndefined();
  });
});