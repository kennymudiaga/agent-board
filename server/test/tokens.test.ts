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

async function mint(app: App, agentId: string, ttlDays?: number): Promise<{ token: string; expiresAt: string | null }> {
  const res = await api(app, 'POST', '/v1/tokens', { body: { agentId, ...(ttlDays !== undefined ? { ttlDays } : {}) } });
  expect(res.status).toBe(201);
  return res.json();
}

describe('per-agent token expiry + rotation (sprint 5 T5, spec §5.9)', () => {
  it('mint without ttlDays has no expiry (back-compat) and works', async () => {
    const { app } = makeCtx();
    const { token, expiresAt } = await mint(app, 'qa-1');
    expect(expiresAt).toBeNull();

    const hb = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(hb.status).toBe(200);
  });

  it('mint with ttlDays returns expiresAt; an expired token gets 401 token_expired', async () => {
    const { app, store } = makeCtx();
    const { token, expiresAt } = await mint(app, 'qa-1', 1);
    expect(expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const ok = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(ok.status).toBe(200);

    // Backdate the expiry (lazy check — no sweep needed).
    store.db.prepare('UPDATE agents SET token_expires_at = ? WHERE id = ?').run(Date.now() - 1000, 'qa-1');
    const expired = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(expired.status).toBe(401);
    expect((await expired.json()).error).toMatchObject({ code: 'token_expired' });
  });

  it('rotation: a second mint atomically kills the old token', async () => {
    const { app } = makeCtx();
    const first = await mint(app, 'qa-1');
    const second = await mint(app, 'qa-1');

    const old = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${first.token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(old.status).toBe(401);
    expect((await old.json()).error.code).toBe('unauthorized'); // wrong token, not expired

    const fresh = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${second.token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(fresh.status).toBe(200);
  });

  it('rotation with ttlDays applies the new token\'s own expiry', async () => {
    const { app, store } = makeCtx();
    const first = await mint(app, 'qa-1');
    const second = await mint(app, 'qa-1', 7);
    expect(second.expiresAt).not.toBeNull();

    // The old token is dead; the new one is alive, then expires on its own clock.
    const old = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${first.token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(old.status).toBe(401);
    store.db.prepare('UPDATE agents SET token_expires_at = ? WHERE id = ?').run(Date.now() - 1, 'qa-1');
    const dead = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${second.token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect((await dead.json()).error.code).toBe('token_expired');
  });

  it('rejects invalid ttlDays and unknown agents on revoke', async () => {
    const { app } = makeCtx();
    const bad = await api(app, 'POST', '/v1/tokens', { body: { agentId: 'qa-1', ttlDays: 0 } });
    expect(bad.status).toBe(422);
    const bad2 = await api(app, 'POST', '/v1/tokens', { body: { agentId: 'qa-1', ttlDays: 'soon' } });
    expect(bad2.status).toBe(422);
  });

  it('the A2A relay rejects an expired token too', async () => {
    const { app, store } = makeCtx();
    const { token } = await mint(app, 'a2a-1');
    store.db.prepare('UPDATE agents SET token_expires_at = ? WHERE id = ?').run(Date.now() - 1, 'a2a-1');
    const res = await app.request('/a2a/a2a-1', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'msg_x' } }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error.message).toContain('expired');
  });
});