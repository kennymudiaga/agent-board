import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token';

function makeCtx(opts: { workspaceId?: string } = {}) {
  const store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN, ...opts });
  return { store, app };
}

type App = ReturnType<typeof createApp>;

function sha256(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

function api(app: App, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; agent?: string } = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
    ...(opts.headers ?? {}),
  };
  return app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function mintAgent(app: App, agentId: string): Promise<string> {
  const res = await api(app, 'POST', '/v1/tokens', { body: { agentId } });
  expect(res.status).toBe(201);
  return (await res.json()).token as string;
}

async function mintWorkspace(app: App, id: string, name?: string): Promise<{ id: string; token: string }> {
  const res = await api(app, 'POST', '/v1/workspaces', { body: { id, ...(name !== undefined ? { name } : {}) } });
  expect(res.status).toBe(201);
  return res.json();
}

describe('workspace middleware resolution + admin endpoints (sprint 8 T2, issue #84)', () => {
  it('createApp bootstraps the configured workspace; its token resolves via hash lookup', async () => {
    const { store, app } = makeCtx();
    const res = await api(app, 'POST', '/v1/heartbeat', { agent: 'qa-1', body: { agentId: 'qa-1', interval: 15 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workspaceId).toBe('default');
    const row = store.db.prepare('SELECT token_hash FROM workspaces WHERE id = ?').get('default') as { token_hash: string };
    expect(row.token_hash).toBe(sha256(TOKEN)); // hashed at rest
    expect(row.token_hash).not.toBe(TOKEN); // plaintext never stored
  });

  it('a custom workspaceId bootstraps that workspace instead of default', async () => {
    const { app } = makeCtx({ workspaceId: 'acme' });
    const res = await api(app, 'POST', '/v1/heartbeat', { agent: 'qa-1', body: { agentId: 'qa-1', interval: 15 } });
    expect((await res.json()).workspaceId).toBe('acme');
  });

  it('401 semantics unchanged: missing/invalid bearer rejected', async () => {
    const { app } = makeCtx();
    expect((await app.request('/v1/boards')).status).toBe(401);
    expect((await app.request('/v1/boards', { headers: { authorization: 'Bearer wrong-token' } })).status).toBe(401);
    // Read-only GET with a valid workspace token but no identity stays open.
    expect((await app.request('/v1/boards', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it('agent tokens resolve via the agent row (default until W3) and never pass admin paths', async () => {
    const { app } = makeCtx();
    const token = await mintAgent(app, 'qa-1');
    const hb = await api(app, 'POST', '/v1/heartbeat', { headers: { authorization: `Bearer ${token}` }, body: { agentId: 'qa-1', interval: 15 } });
    expect(hb.status).toBe(200);
    expect((await hb.json()).workspaceId).toBe('default');

    // Admin endpoints reject agent tokens (no admin escalation).
    const wsAdmin = await app.request('/v1/workspaces', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x' }),
    });
    expect(wsAdmin.status).toBe(401);
    const mint = await app.request('/v1/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'y' }),
    });
    expect(mint.status).toBe(401);
  });

  it('cross-workspace resolution: each workspace token resolves to its own workspace', async () => {
    const { app } = makeCtx();
    const alpha = await mintWorkspace(app, 'alpha');
    const beta = await mintWorkspace(app, 'beta');

    const hbA = await api(app, 'POST', '/v1/heartbeat', {
      headers: { authorization: `Bearer ${alpha.token}` },
      body: { agentId: 'qa-1', interval: 15 },
    });
    const hbB = await api(app, 'POST', '/v1/heartbeat', {
      headers: { authorization: `Bearer ${beta.token}` },
      body: { agentId: 'qa-1', interval: 15 },
    });
    expect((await hbA.json()).workspaceId).toBe('alpha');
    expect((await hbB.json()).workspaceId).toBe('beta');

    // alpha's token administers alpha's workspace only: creating alpha again
    // is a duplicate (its admin scope is alpha), and it cannot mint beta.
    const dup = await api(app, 'POST', '/v1/workspaces', {
      headers: { authorization: `Bearer ${alpha.token}` },
      body: { id: 'alpha' },
    });
    expect(dup.status).toBe(409);
    const cross = await api(app, 'POST', '/v1/workspaces', {
      headers: { authorization: `Bearer ${alpha.token}` },
      body: { id: 'beta' },
    });
    expect(cross.status).toBe(409); // beta already exists — no cross-workspace admin reach
  });

  it('POST /v1/workspaces mints a workspace token: 201, shown once, hashed at rest', async () => {
    const { app, store } = makeCtx();
    const res = await api(app, 'POST', '/v1/workspaces', { body: { id: 'acme', name: 'Acme' } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: 'acme' });
    expect(body.token).toMatch(/^abw_[0-9a-f]{48}$/);
    const row = store.db.prepare('SELECT token_hash FROM workspaces WHERE id = ?').get('acme') as { token_hash: string };
    expect(row.token_hash).toBe(sha256(body.token));
    expect(row.token_hash).not.toBe(body.token);
    // The minted token works as a workspace credential.
    const hb = await api(app, 'POST', '/v1/heartbeat', {
      headers: { authorization: `Bearer ${body.token}` },
      body: { agentId: 'qa-1', interval: 15 },
    });
    expect(hb.status).toBe(200);
  });

  it('POST /v1/workspaces validates input and rejects duplicates with 409', async () => {
    const { app } = makeCtx();
    expect((await api(app, 'POST', '/v1/workspaces', { body: {} })).status).toBe(422);
    expect((await api(app, 'POST', '/v1/workspaces', { body: { id: 'BAD!' } })).status).toBe(422);
    expect((await api(app, 'POST', '/v1/workspaces', { body: { id: 'ok', name: '' } })).status).toBe(422);
    expect((await api(app, 'POST', '/v1/workspaces', { body: { id: 'ok', name: 'x'.repeat(129) } })).status).toBe(422);

    await mintWorkspace(app, 'acme');
    const dup = await api(app, 'POST', '/v1/workspaces', { body: { id: 'acme' } });
    expect(dup.status).toBe(409);
  });

  it('DELETE /v1/workspaces/:id revokes the token; the row (data) remains untouched', async () => {
    const { app, store } = makeCtx();
    const ws = await mintWorkspace(app, 'acme');

    const del = await api(app, 'DELETE', '/v1/workspaces/acme');
    expect(del.status).toBe(200);
    expect((await del.json()).ok).toBe(true);

    // Token revoked: the minted credential now 401s.
    const hb = await api(app, 'POST', '/v1/heartbeat', {
      headers: { authorization: `Bearer ${ws.token}` },
      body: { agentId: 'qa-1', interval: 15 },
    });
    expect(hb.status).toBe(401);

    // Row remains (revocation only clears the hash).
    const row = store.db.prepare('SELECT token_hash FROM workspaces WHERE id = ?').get('acme') as { token_hash: string | null };
    expect(row.token_hash).toBeNull();

    // Unknown workspace -> 404; invalid id -> 422.
    expect((await api(app, 'DELETE', '/v1/workspaces/nope')).status).toBe(404);
    expect((await api(app, 'DELETE', '/v1/workspaces/BAD!')).status).toBe(422);
  });

  it('SSE /v1/events authenticates via the workspace-token hash lookup', async () => {
    const { app } = makeCtx();
    expect((await app.request('/v1/events')).status).toBe(401);
    expect((await app.request('/v1/events?token=wrong')).status).toBe(401);
    expect((await app.request(`/v1/events?token=${TOKEN}`)).status).toBe(200);
  });
});