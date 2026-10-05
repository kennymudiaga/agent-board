import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { makePayloadCipher, AB_ENC_MAGIC } from '../src/crypto.js';

const TOKEN = 'test-token';
const KEY = 'sprint-10-encryption-spike-secret';

type App = ReturnType<typeof createApp>;

function api(app: App, method: string, path: string, opts: { body?: unknown; agent?: string } = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
  };
  return app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function seedBoard(app: App, agentId: string = 'enc-1') {
  await api(app, 'POST', '/v1/heartbeat', { body: { agentId, roles: ['dev'], boards: ['enc-board'], interval: 15 } });
  return api(app, 'POST', '/v1/boards/enc-board/messages', {
    agent: agentId,
    body: {
      to: 'role:dev',
      type: 'request',
      payload: { task: 'secret review payload', marker: 'S3CR3T-MARKER-ALPHA' },
    },
  });
}

// On-disk DB helper for cross-store lifecycle tests (reopen with/without key).
function tmpDb(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ab-enc-'));
  return { dir, path: join(dir, 'agentboard.db') };
}

describe('at-rest encryption (sprint 10 T3 — docs/spec.md 10.7, #111)', () => {
  it('no key: payloads stored as plaintext — byte-identical transport-only default', async () => {
    const store = new Store(':memory:');
    const app = createApp(store, { token: TOKEN });
    const res = await seedBoard(app);
    expect(res.status).toBe(201);
    const msg = (await res.json()).message;

    // The payload cell on disk is exactly the plaintext JSON — no encryption,
    // no schema change, no envelope.
    const row = store.db.prepare('SELECT payload FROM messages WHERE id = ?').get(msg.id) as { payload: string };
    expect(row.payload).toBe(JSON.stringify({ task: 'secret review payload', marker: 'S3CR3T-MARKER-ALPHA' }));

    const view = await api(app, 'GET', '/v1/boards/enc-board/messages?since=0', {});
    expect((await view.json()).messages[0].payload).toMatchObject({ task: 'secret review payload' });
    store.close();
  });

  it('with key: payloads encrypted at rest, round-trip transparent, no plaintext on disk', async () => {
    const store = new Store(':memory:', makePayloadCipher(KEY));
    const app = createApp(store, { token: TOKEN });
    const res = await seedBoard(app);
    expect(res.status).toBe(201);
    const msg = (await res.json()).message;
    expect(msg.payload).toMatchObject({ task: 'secret review payload' });

    // Disk: the cell is an envelope and leaks no plaintext.
    const row = store.db.prepare('SELECT payload FROM messages WHERE id = ?').get(msg.id) as { payload: string };
    expect(row.payload.startsWith(AB_ENC_MAGIC)).toBe(true);
    expect(row.payload).not.toContain('S3CR3T-MARKER-ALPHA');
    expect(row.payload).not.toContain('secret review payload');

    // Read-back via the API (pickup/observability paths decrypt transparently).
    const view = await api(app, 'GET', '/v1/boards/enc-board/messages?since=0', {});
    expect((await view.json()).messages[0].payload).toMatchObject({ task: 'secret review payload', marker: 'S3CR3T-MARKER-ALPHA' });

    // Ack flow end-to-end under encryption: claim -> done, state + payload intact.
    await api(app, 'POST', '/v1/heartbeat', { body: { agentId: 'enc-worker', roles: ['dev'], boards: ['enc-board'] } });
    const claimed = await api(app, 'GET', '/v1/boards/enc-board/messages?since=0&wait=0', { agent: 'enc-worker' });
    const picked = (await claimed.json()).messages.find((m: { id: string }) => m.id === msg.id);
    expect(picked.state).toBe('claimed');
    const ack = await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'enc-worker', body: { status: 'done' } });
    expect(ack.status).toBe(200);
    const done = store.getMessage('default', msg.id)!;
    expect(done.state).toBe('done');
    expect(done.payload).toMatchObject({ task: 'secret review payload' });
    store.close();
  });

  it('mixed DB: legacy plaintext rows stay readable after a key is introduced', async () => {
    const { dir, path } = tmpDb();
    try {
      // Phase 1: server without a key writes plaintext payloads.
      const s1 = new Store(path);
      const a1 = createApp(s1, { token: TOKEN });
      const legacy = await (await seedBoard(a1)).json();
      s1.close();

      // Phase 2: operator adds AB_ENCRYPTION_KEY. Old row is still readable
      // (plaintext cell passes through), new writes are encrypted at rest.
      const s2 = new Store(path, makePayloadCipher(KEY));
      const a2 = createApp(s2, { token: TOKEN });
      const view = await api(a2, 'GET', '/v1/boards/enc-board/messages?since=0', {});
      const msgs = (await view.json()).messages as { id: string; payload: unknown }[];
      expect(msgs).toContainEqual(expect.objectContaining({ id: legacy.message.id, payload: expect.objectContaining({ marker: 'S3CR3T-MARKER-ALPHA' }) }));

      const fresh = await seedBoard(a2);
      const freshMsg = (await fresh.json()).message;
      const row = s2.db.prepare('SELECT payload FROM messages WHERE id = ?').get(freshMsg.id) as { payload: string };
      expect(row.payload.startsWith(AB_ENC_MAGIC)).toBe(true);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('encrypted payloads unreadable without the key — explicit error, not a JSON.parse crash', async () => {
    const { dir, path } = tmpDb();
    try {
      const s1 = new Store(path, makePayloadCipher(KEY));
      const a1 = createApp(s1, { token: TOKEN });
      const msg = (await (await seedBoard(a1)).json()).message;
      s1.close();

      // Reopen WITHOUT the key: the envelope is detected and the reader gets a
      // clear, actionable error naming the key.
      const s2 = new Store(path);
      expect(() => s2.getMessage('default', msg.id)).toThrow(/AB_ENCRYPTION_KEY/);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tampering or a wrong key is detected (GCM auth) — no silent corruption', async () => {
    const { dir, path } = tmpDb();
    try {
      const s1 = new Store(path, makePayloadCipher(KEY));
      const a1 = createApp(s1, { token: TOKEN });
      const msg = (await (await seedBoard(a1)).json()).message;
      s1.close();

      // A completely different key MUST fail authentication, not return garbage.
      const s2 = new Store(path, makePayloadCipher('wrong-key-entirely'));
      expect(() => s2.getMessage('default', msg.id)).toThrow();
      s2.close();

      // Tampered cell (flip a base64 char in the ciphertext) also fails auth.
      const s3 = new Store(path, makePayloadCipher(KEY));
      const row = s3.db.prepare('SELECT payload FROM messages WHERE id = ?').get(msg.id) as { payload: string };
      const flipped = row.payload.slice(0, -2) + (row.payload.endsWith('AA') ? 'AB' : 'AA');
      s3.db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(flipped, msg.id);
      expect(() => s3.getMessage('default', msg.id)).toThrow();
      s3.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});