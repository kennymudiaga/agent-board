import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token';

function makeCtx() {
  const store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  return { store, app };
}

interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
  agent?: string;
}

function api(app: ReturnType<typeof createApp>, method: string, path: string, opts: ApiOptions = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
    ...(opts.headers ?? {}),
  };
  return app.request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function heartbeat(app: ReturnType<typeof createApp>, agentId: string, extra: Record<string, unknown> = {}) {
  return api(app, 'POST', '/v1/heartbeat', {
    body: { agentId, roles: [], boards: ['sprint-7'], interval: 15, ...extra },
  });
}

describe('auth', () => {
  it('rejects missing or invalid bearer token', async () => {
    const { app } = makeCtx();
    const res = await app.request('/v1/heartbeat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'producer-1' }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('rejects missing X-Agent-ID on mutating endpoints (GETs are read-only)', async () => {
    const { app } = makeCtx();
    // POST (mutating) without identity -> 401.
    const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      headers: {},
      body: { to: 'role:qa', type: 'note', payload: { text: 'x' } },
    });
    expect(res.status).toBe(401);
    // An invalid-format identity header is 422.
    const badFormat = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      headers: { 'x-agent-id': 'BAD ID!' },
      body: { to: 'role:qa', type: 'note', payload: { text: 'x' } },
    });
    expect(badFormat.status).toBe(422);
    // GET (read-only) without identity is allowed for dashboards (spec §4).
    const read = await api(app, 'GET', '/v1/agents', { headers: {} });
    expect(read.status).toBe(200);
  });
});

describe('heartbeat & presence', () => {
  it('registers an agent, creates boards, returns presence ttl', async () => {
    const { app } = makeCtx();
    const res = await heartbeat(app, 'qa-1', {
      provider: 'opencode',
      roles: ['qa'],
      capabilities: ['code-review'],
      status: 'idle',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent).toMatchObject({
      agentId: 'qa-1',
      provider: 'opencode',
      roles: ['qa'],
      boards: ['sprint-7'],
      status: 'idle',
      interval: 15,
      presence: 'online',
    });
    expect(body.presence).toEqual({ ttl: 45, expiresAt: expect.any(String) });
  });

  it('validates heartbeat input', async () => {
    const { app } = makeCtx();
    expect((await heartbeat(app, 'BAD ID!')).status).toBe(422);
    expect((await heartbeat(app, 'qa-1', { status: 'asleep' })).status).toBe(422);
    expect((await heartbeat(app, 'qa-1', { interval: 0 })).status).toBe(422);
    expect((await heartbeat(app, 'qa-1', { roles: 'qa' })).status).toBe(422);
  });

  it('rejects invalid board names in heartbeat boards (regression #10)', async () => {
    const { app } = makeCtx();
    const res = await heartbeat(app, 'qa-1', { boards: ['BAD BOARD!'] });
    expect(res.status).toBe(422);
    // The whole heartbeat was rejected: no agent registered with a bad board.
    const dir = await (await api(app, 'GET', '/v1/agents', { agent: 'qa-1' })).json();
    expect(dir.agents).toHaveLength(0);
    // A board by that name can never be read or addressed.
    expect((await api(app, 'GET', '/v1/boards/BAD BOARD!/messages', { agent: 'qa-1' })).status).toBe(422);
  });

  it('derives presence: agents go offline after 3x interval', async () => {
    const { store, app } = makeCtx();
    await heartbeat(app, 'qa-1');
    await heartbeat(app, 'qa-2', { interval: 5 });

    // Age qa-2 beyond its 15s TTL; qa-1 (TTL 45s) stays online.
    store.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now() - 20_000, 'qa-2');

    const res = await api(app, 'GET', '/v1/agents', { agent: 'qa-1' });
    const agents = (await res.json()).agents as { agentId: string; presence: string }[];
    expect(agents.find((a) => a.agentId === 'qa-1')?.presence).toBe('online');
    expect(agents.find((a) => a.agentId === 'qa-2')?.presence).toBe('offline');
  });

  it('filters the directory by board, role, and status', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'producer-1', { roles: ['producer'], status: 'busy' });
    await heartbeat(app, 'qa-1', { roles: ['qa'], status: 'idle' });

    const byRole = await (await api(app, 'GET', '/v1/agents?role=qa', { agent: 'qa-1' })).json();
    expect(byRole.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['qa-1']);

    const byStatus = await (await api(app, 'GET', '/v1/agents?status=busy', { agent: 'qa-1' })).json();
    expect(byStatus.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['producer-1']);

    const byBoard = await (await api(app, 'GET', '/v1/agents?board=sprint-7', { agent: 'qa-1' })).json();
    expect(byBoard.agents).toHaveLength(2);
  });
});

describe('message lifecycle', () => {
  it('runs the full loop: heartbeat -> send -> pickup -> ack done -> no redelivery', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'producer-1', { roles: ['producer'] });
    await heartbeat(app, 'qa-1', { roles: ['qa'] });

    const sent = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'request', payload: { text: 'review PR #12' } },
    });
    expect(sent.status).toBe(201);
    const { message: created } = await sent.json();
    expect(created).toMatchObject({ board: 'sprint-7', from: 'producer-1', to: 'role:qa', type: 'request', state: 'pending', attempts: 0 });

    // Pickup: claimed atomically.
    const picked = await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' });
    expect(picked.status).toBe(200);
    const { messages, cursor } = await picked.json();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: created.id, state: 'claimed', attempts: 1, claimAgent: 'qa-1' });
    expect(cursor).toBe(created.seq);

    // Ack done.
    const acked = await api(app, 'POST', `/v1/messages/${created.id}/ack`, {
      agent: 'qa-1',
      body: { status: 'done' },
    });
    expect(acked.status).toBe(200);
    expect((await acked.json()).message.state).toBe('done');

    // No redelivery, and cursor semantics return nothing new.
    const again = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(again.messages).toHaveLength(0);
    const resumed = await (
      await api(app, 'GET', `/v1/boards/sprint-7/messages?since=${cursor}`, { agent: 'qa-1' })
    ).json();
    expect(resumed.messages).toHaveLength(0);
  });

  it('rejects duplicate idempotencyKey with 409 and the original id', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'producer-1');

    const body = { to: 'role:qa', type: 'request', payload: { text: 'x' }, idempotencyKey: 'k1' };
    const first = await api(app, 'POST', '/v1/boards/sprint-7/messages', { agent: 'producer-1', body });
    expect(first.status).toBe(201);
    const firstId = (await first.json()).message.id;

    const dup = await api(app, 'POST', '/v1/boards/sprint-7/messages', { agent: 'producer-1', body });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({
      error: { code: 'duplicate_idempotency_key', originalMessageId: firstId },
    });

    // Same key from a different sender is fine.
    const other = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'qa-1',
      body: { ...body, payload: { text: 'y' } },
    });
    expect(other.status).toBe(201);
  });

  it('addresses by agent, role, and broadcast (fan-out to all members)', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await heartbeat(app, 'dev-1', { roles: ['dev'] });

    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'agent:qa-1', type: 'note', payload: { text: 'direct' } },
    });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'note', payload: { text: 'role' } },
    });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'broadcast', type: 'note', payload: { text: 'all' } },
    });

    const qaMail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(qaMail.messages.map((m: { payload: { text: string } }) => m.payload.text).sort()).toEqual(['all', 'direct', 'role']);
    // qa-1's broadcast copy carries its own delivery record.
    const bcast = qaMail.messages.find((m: { to: string }) => m.to === 'broadcast');
    expect(bcast.delivery).toMatchObject({ readerId: 'qa-1', state: 'claimed', attempts: 1, claimAgent: 'qa-1' });

    // dev-1 gets its own broadcast copy too (per-reader fan-out).
    const devMail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'dev-1' })).json();
    expect(devMail.messages.map((m: { payload: { text: string } }) => m.payload.text)).toEqual(['all']);
    expect(devMail.messages[0].delivery).toMatchObject({ readerId: 'dev-1', state: 'claimed' });
    expect(devMail.messages[0].id).toBe(bcast.id); // same message, own copy
  });

  it('retries failed messages and dead-letters after max attempts', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'request', payload: { text: 'flaky' } },
    });

    let id = '';
    for (let i = 1; i <= 3; i++) {
      const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
      expect(mail.messages).toHaveLength(1);
      id = mail.messages[0].id;
      expect(mail.messages[0].attempts).toBe(i);
      const ack = await api(app, 'POST', `/v1/messages/${id}/ack`, {
        agent: 'qa-1',
        body: { status: 'failed', error: `attempt ${i} blew up` },
      });
      expect(ack.status).toBe(200);
      const state = (await ack.json()).message.state;
      expect(state).toBe(i < 3 ? 'pending' : 'dead');
    }

    // Dead messages are never redelivered.
    const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(mail.messages).toHaveLength(0);

    // Visible via observability filter.
    const dead = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=dead', { agent: 'qa-1' })).json();
    expect(dead.messages).toHaveLength(1);
    expect(dead.messages[0].id).toBe(id);
  });

  it('redelivers when the claim lease expires', async () => {
    const { store, app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    const sent = await (
      await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'lease' } },
      })
    ).json();
    const id = sent.message.id;

    const first = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(first.messages[0].attempts).toBe(1);

    // Simulate the 5-minute lease elapsing.
    store.db
      .prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, id);

    const second = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].id).toBe(id); // same id -> client dedupes
    expect(second.messages[0].attempts).toBe(2);
  });

  it('renews the lease via ack claimed', async () => {
    const { store, app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'request', payload: { text: 'long task' } },
    });
    const picked = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    const id = picked.messages[0].id;

    // Bring the lease within 1s of expiry, then renew it.
    store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run(Date.now() + 1000, id);

    const renewed = await api(app, 'POST', `/v1/messages/${id}/ack`, { agent: 'qa-1', body: { status: 'claimed' } });
    expect(renewed.status).toBe(200);

    const after = store.db
      .prepare('SELECT lease_expires_at FROM messages WHERE id = ?')
      .get(id) as { lease_expires_at: number };
    expect(after.lease_expires_at).toBeGreaterThan(Date.now() + 299_000);
  });

  it('long-polls: a pickup with wait returns as soon as a message arrives', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await heartbeat(app, 'producer-1');

    const pending = api(app, 'GET', '/v1/boards/sprint-7/messages?wait=5', { agent: 'qa-1' });
    setTimeout(() => {
      void api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'arrives later' } },
      });
    }, 300);

    const res = await pending;
    const { messages } = await res.json();
    expect(messages).toHaveLength(1);
    expect(messages[0].payload).toEqual({ text: 'arrives later' });
  }, 10_000);

  it('expires ttl messages without delivering them', async () => {
    const { store, app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'note', payload: { text: 'perishable' }, ttl: 60 },
    });

    // Age the message past its ttl.
    store.db.prepare('UPDATE messages SET created_at = ?').run(Date.now() - 120_000);

    const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(mail.messages).toHaveLength(0);

    const expired = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=expired', { agent: 'qa-1' })).json();
    expect(expired.messages).toHaveLength(1);
  });

  it('ttl: 0 means no expiry (regression #9)', async () => {
    const { store, app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'note', payload: { text: 'immortal' }, ttl: 0 },
    });

    // Age the message far beyond any instant-expiry interpretation.
    store.db.prepare('UPDATE messages SET created_at = ?').run(Date.now() - 3_600_000);

    const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0].payload).toEqual({ text: 'immortal' });
    expect(mail.messages[0].ttl).toBeNull();

    const expired = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=expired', { agent: 'qa-1' })).json();
    expect(expired.messages).toHaveLength(0);
  });

  it('rejects ack conflicts: wrong claimer, invalid transitions, missing error', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'qa-1', { roles: ['qa'] });
    await heartbeat(app, 'qa-2', { roles: ['qa'] });
    const sent = await (
      await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'x' } },
      })
    ).json();
    const id = sent.message.id;

    await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' });

    // Wrong claimer.
    const wrong = await api(app, 'POST', `/v1/messages/${id}/ack`, { agent: 'qa-2', body: { status: 'done' } });
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe('ack_conflict');

    // Aking a pending (unclaimed) message is an invalid transition.
    const sent2 = await (
      await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'y' } },
      })
    ).json();
    const pendingAck = await api(app, 'POST', `/v1/messages/${sent2.message.id}/ack`, {
      agent: 'qa-1',
      body: { status: 'done' },
    });
    expect(pendingAck.status).toBe(409);

    // failed requires an error.
    const noErr = await api(app, 'POST', `/v1/messages/${id}/ack`, { agent: 'qa-1', body: { status: 'failed' } });
    expect(noErr.status).toBe(422);

    // Acking twice: second is invalid transition.
    expect((await api(app, 'POST', `/v1/messages/${id}/ack`, { agent: 'qa-1', body: { status: 'done', error: null } })).status).toBe(200);
    const twice = await api(app, 'POST', `/v1/messages/${id}/ack`, { agent: 'qa-1', body: { status: 'done' } });
    expect(twice.status).toBe(409);
  });

  it('validates message posting', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'producer-1');
    const post = (body: unknown) => api(app, 'POST', '/v1/boards/sprint-7/messages', { agent: 'producer-1', body });

    expect((await post({ to: 'role:qa', type: 'request' })).status).toBe(400); // missing payload
    expect((await post({ to: 'nonsense', type: 'request', payload: {} })).status).toBe(422);
    expect((await post({ to: 'role:qa', type: 'teleport', payload: {} })).status).toBe(422);
    expect((await post({ to: 'agent:BAD ID!', type: 'note', payload: {} })).status).toBe(422);
    expect((await post({ to: 'role:qa', type: 'note', payload: {}, priority: 'urgent' })).status).toBe(422);
    expect((await post({ to: 'role:qa', type: 'note', payload: {}, ttl: -5 })).status).toBe(422);
    expect((await api(app, 'POST', '/v1/boards/BAD!/messages', { agent: 'producer-1', body: { to: 'role:qa', type: 'note', payload: {} } })).status).toBe(422);
  });

  it('404s on unknown board and unknown message', async () => {
    const { app } = makeCtx();
    await heartbeat(app, 'qa-1');
    expect((await api(app, 'GET', '/v1/boards/nope/messages', { agent: 'qa-1' })).status).toBe(404);
    expect((await api(app, 'POST', '/v1/messages/msg_nope/ack', { agent: 'qa-1', body: { status: 'done' } })).status).toBe(404);
  });

  describe('true cursor watermark (T1, #12)', () => {
    async function send(app: ReturnType<typeof createApp>, to: string, text: string) {
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to, type: 'note', payload: { text } },
      });
      expect(res.status).toBe(201);
      return (await res.json()).message as { id: string; seq: number };
    }
    async function pickup(app: ReturnType<typeof createApp>, agent: string, query = '') {
      return (await (await api(app, 'GET', `/v1/boards/sprint-7/messages${query}`, { agent })).json()) as {
        messages: { id: string; seq: number; attempts: number }[];
        watermark: number;
      };
    }

    it('pickup responses carry a watermark that reflects finalization', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const msg = await send(app, 'role:qa', 'x');
      // Claimed by me -> blocks the watermark (min non-finalized = 1 -> wm 0).
      expect((await pickup(app, 'qa-1')).watermark).toBe(0);
      // Finalized -> watermark advances past it.
      await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-1', body: { status: 'done' } });
      expect((await pickup(app, 'qa-1')).watermark).toBe(msg.seq);
    });

    it('a claimed-but-unacked message blocks forever, even past newer finalized ones (#12)', async () => {
      const { store, app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const a = await send(app, 'role:qa', 'a');
      await pickup(app, 'qa-1'); // claim a
      const b = await send(app, 'role:qa', 'b'); // arrives while a is still claimed
      const view = await pickup(app, 'qa-1');
      expect(view.messages).toHaveLength(1); // only b is pending
      expect(view.messages[0].id).toBe(b.id);
      expect(view.watermark).toBe(a.seq - 1); // a still blocks

      // Finalize b: watermark must NOT jump past a.
      await api(app, 'POST', `/v1/messages/${b.id}/ack`, { agent: 'qa-1', body: { status: 'done' } });
      expect((await pickup(app, 'qa-1')).watermark).toBe(a.seq - 1);

      // Crash window: a's lease expires -> redelivery with attempts=2.
      store.db.prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?').run(Date.now() - 1, a.id);
      const redelivered = await pickup(app, 'qa-1');
      expect(redelivered.messages).toHaveLength(1);
      expect(redelivered.messages[0].id).toBe(a.id);
      expect(redelivered.messages[0].attempts).toBe(2);
    });

    it('messages claimed by another reader do not block', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const a = await send(app, 'role:qa', 'a');
      await pickup(app, 'qa-1'); // qa-1 claims a
      const b = await send(app, 'role:qa', 'b');
      const forTwo = await pickup(app, 'qa-2'); // qa-2 claims b
      expect(forTwo.messages[0].id).toBe(b.id);
      await api(app, 'POST', `/v1/messages/${b.id}/ack`, { agent: 'qa-2', body: { status: 'done' } });
      // qa-1's watermark is still blocked by its own claim of a.
      expect((await pickup(app, 'qa-1')).watermark).toBe(a.seq - 1);
      await api(app, 'POST', `/v1/messages/${a.id}/ack`, { agent: 'qa-1', body: { status: 'done' } });
      const done = await pickup(app, 'qa-1');
      expect(done.messages).toHaveLength(0);
      expect(done.watermark).toBe(b.seq);
    });

    it('messages addressed to others never block', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'dev-1', { roles: ['dev'] });
      await send(app, 'agent:dev-1', '1');
      await send(app, 'agent:dev-1', '2');
      const view = await pickup(app, 'qa-1');
      expect(view.messages).toHaveLength(0);
      expect(view.watermark).toBe(2); // passes messages that are not qa-1's mail
    });
  });

  describe('broadcast fan-out (T2)', () => {
    async function broadcast(app: ReturnType<typeof createApp>, text: string) {
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'broadcast', type: 'note', payload: { text } },
      });
      expect(res.status).toBe(201);
      return (await res.json()).message as { id: string; seq: number; deliveries: { readerId: string }[] };
    }
    async function pickup(app: ReturnType<typeof createApp>, agent: string) {
      return (await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent })).json()) as {
        messages: { id: string; delivery?: { state: string; attempts: number; readerId: string } }[];
      };
    }

    it('reaches every member independently, online or offline', async () => {
      const { store, app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      // dev-1 heartbeated once (long ago — presence gone) but remains a member.
      await heartbeat(app, 'dev-1', { roles: ['dev'] });
      store.db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now() - 3_600_000, 'dev-1');
      const msg = await broadcast(app, 'standup: statuses please');

      // Fan-out rows exist for both members regardless of presence.
      expect(msg.deliveries.map((d) => d.readerId).sort()).toEqual(['dev-1', 'qa-1']);

      const qa = await pickup(app, 'qa-1');
      expect(qa.messages.map((m) => m.id)).toContain(msg.id);
      const dev = await pickup(app, 'dev-1'); // offline member still receives
      expect(dev.messages.map((m) => m.id)).toContain(msg.id);
    });

    it('one reader failing to dead does not affect another reader\'s copy', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const msg = await broadcast(app, 'flaky broadcast');

      // qa-1 fails its copy three times -> its delivery dead-letters.
      for (let i = 0; i < 3; i++) {
        const mail = await pickup(app, 'qa-1');
        const mine = mail.messages.find((m) => m.id === msg.id);
        expect(mine).toBeDefined();
        const ack = await api(app, 'POST', `/v1/messages/${msg.id}/ack`, {
          agent: 'qa-1',
          body: { status: 'failed', error: `attempt ${i + 1}` },
        });
        expect(ack.status).toBe(200);
        const state = (await ack.json()).message.delivery.state;
        expect(state).toBe(i < 2 ? 'pending' : 'dead');
      }

      // qa-2 still gets its own fresh copy (attempts=1, unaffected).
      const mail2 = await pickup(app, 'qa-2');
      const mine2 = mail2.messages.find((m) => m.id === msg.id);
      expect(mine2).toBeDefined();
      expect(mine2.delivery).toMatchObject({ state: 'claimed', attempts: 1, readerId: 'qa-2' });
      const ack2 = await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-2', body: { status: 'done' } });
      expect((await ack2.json()).message.delivery.state).toBe('done');
    });

    it('aggregates: pending while any delivery active, done when all terminal', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const msg = await broadcast(app, 'aggregate');

      const viewPending = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=pending', { agent: 'qa-1' })).json();
      expect(viewPending.messages.some((m: { id: string }) => m.id === msg.id)).toBe(true);

      // qa-1 done, qa-2 still pending -> message stays pending.
      await pickup(app, 'qa-1');
      await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-1', body: { status: 'done' } });
      await pickup(app, 'qa-2');
      let view = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=done', { agent: 'qa-1' })).json();
      expect(view.messages.some((m: { id: string }) => m.id === msg.id)).toBe(false);

      // qa-2 done -> all terminal -> aggregate done.
      await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-2', body: { status: 'done' } });
      view = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=done', { agent: 'qa-1' })).json();
      expect(view.messages.some((m: { id: string }) => m.id === msg.id)).toBe(true);
    });

    it('a broadcast with no members is dead-lettered immediately', async () => {
      const { app } = makeCtx();
      const msg = await broadcast(app, 'nobody home');
      const view = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=dead', { agent: 'qa-1' })).json();
      expect(view.messages.some((m: { id: string }) => m.id === msg.id)).toBe(true);
    });

    it('late joiners do not receive past broadcasts', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await broadcast(app, 'before you joined');
      await heartbeat(app, 'dev-1', { roles: ['dev'] }); // joins after the broadcast
      const dev = await pickup(app, 'dev-1');
      expect(dev.messages).toHaveLength(0);
    });

    it('ack conflicts: only the claiming reader can ack its own delivery', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const msg = await broadcast(app, 'conflict');
      await pickup(app, 'qa-1');
      // qa-2 cannot ack qa-1's delivery.
      const wrong = await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-2', body: { status: 'done' } });
      expect(wrong.status).toBe(409);
      // qa-1 acks its own; second ack is an invalid transition.
      expect((await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-1', body: { status: 'done' } })).status).toBe(200);
      expect((await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-1', body: { status: 'done' } })).status).toBe(409);
    });

    it('delivery leases expire independently and redeliver to the same reader', async () => {
      const { store, app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const msg = await broadcast(app, 'lease');
      const mail = await pickup(app, 'qa-1');
      expect(mail.messages.find((m) => m.id === msg.id)?.delivery).toMatchObject({ attempts: 1 });

      store.db
        .prepare('UPDATE deliveries SET lease_expires_at = ? WHERE message_id = ? AND reader_id = ?')
        .run(Date.now() - 1, msg.id, 'qa-1');

      const redelivered = await pickup(app, 'qa-1');
      expect(redelivered.messages.find((m) => m.id === msg.id)?.delivery).toMatchObject({ attempts: 2, claimAgent: 'qa-1' });
    });

    it('broadcast ttl expiry expires every reader\'s delivery', async () => {
      const { store, app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'broadcast', type: 'note', payload: { text: 'perishable' }, ttl: 60 },
      });
      const msg = (await res.json()).message as { id: string };
      store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, msg.id);

      const mail = await pickup(app, 'qa-1');
      expect(mail.messages).toHaveLength(0);
      const expired = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=expired', { agent: 'qa-1' })).json();
      const found = expired.messages.find((m: { id: string }) => m.id === msg.id);
      expect(found).toBeDefined();
      expect(found.deliveries).toHaveLength(2);
      expect(found.deliveries.every((d: { state: string }) => d.state === 'expired')).toBe(true);
    });

    it('my pending broadcast delivery blocks my watermark; another reader\'s does not', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const msg = await broadcast(app, 'wm');
      // qa-1 claims its copy; qa-2 leaves its copy pending.
      await pickup(app, 'qa-1');
      const view = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-2' })).json();
      // qa-2's own pending delivery blocks its watermark; qa-1's claim does not.
      expect(view.watermark).toBe(msg.seq - 1);
      await api(app, 'POST', `/v1/messages/${msg.id}/ack`, { agent: 'qa-2', body: { status: 'done' } });
      const done = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-2' })).json();
      expect(done.watermark).toBe(msg.seq);
    });
  });

  describe('question deadlines (T3)', () => {
    it('a pending question is delivered before its deadline', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: {
          to: 'role:qa',
          type: 'question',
          payload: { text: 'ship today?' },
          deadline: new Date(Date.now() + 120_000).toISOString(),
        },
      });
      expect(res.status).toBe(201);
      const msg = (await res.json()).message;
      expect(msg.deadline).toBeDefined();
      expect(msg.late).toBe(false);
      const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
      expect(mail.messages).toHaveLength(1);
      expect(mail.messages[0].id).toBe(msg.id);
    });

    it('a question past its deadline expires and is never delivered', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: {
          to: 'role:qa',
          type: 'question',
          payload: { text: 'too late' },
          deadline: new Date(Date.now() - 1000).toISOString(),
        },
      });
      const msg = (await res.json()).message;
      const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
      expect(mail.messages).toHaveLength(0);
      const expired = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=expired', { agent: 'qa-1' })).json();
      expect(expired.messages.some((m: { id: string }) => m.id === msg.id)).toBe(true);
    });

    it('a response to an expired question is accepted and flagged late', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1', { roles: ['producer'] });
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const q = await (
        await api(app, 'POST', '/v1/boards/sprint-7/messages', {
          agent: 'producer-1',
          body: { to: 'role:qa', type: 'question', payload: { text: 'hurry' }, deadline: new Date(Date.now() - 1000).toISOString() },
        })
      ).json();
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'qa-1',
        body: { to: 'agent:producer-1', type: 'response', payload: { text: 'yes (late, sorry)' }, replyTo: q.message.id },
      });
      expect(res.status).toBe(201);
      const response = (await res.json()).message;
      expect(response.late).toBe(true);
      expect(response.replyTo).toBe(q.message.id);
    });

    it('an on-time response is not flagged late', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1', { roles: ['producer'] });
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const q = await (
        await api(app, 'POST', '/v1/boards/sprint-7/messages', {
          agent: 'producer-1',
          body: { to: 'role:qa', type: 'question', payload: { text: 'quick one' }, deadline: new Date(Date.now() + 120_000).toISOString() },
        })
      ).json();
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'qa-1',
        body: { to: 'agent:producer-1', type: 'response', payload: { text: 'yes' }, replyTo: q.message.id },
      });
      expect((await res.json()).message.late).toBe(false);
    });

    it('deadline is validated: format and question-only', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1');
      const post = (body: unknown) => api(app, 'POST', '/v1/boards/sprint-7/messages', { agent: 'producer-1', body });
      expect((await post({ to: 'role:qa', type: 'question', payload: {}, deadline: 'not-a-date' })).status).toBe(422);
      expect((await post({ to: 'role:qa', type: 'question', payload: {}, deadline: 12345 })).status).toBe(422);
      expect((await post({ to: 'role:qa', type: 'note', payload: {}, deadline: new Date().toISOString() })).status).toBe(422);
      expect((await post({ to: 'role:qa', type: 'question', payload: {}, deadline: new Date(Date.now() + 60_000).toISOString() })).status).toBe(201);
    });

    it('a broadcast question expires all deliveries at its deadline', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const res = await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'broadcast', type: 'question', payload: { text: 'all hands?' }, deadline: new Date(Date.now() - 1000).toISOString() },
      });
      const msg = (await res.json()).message as { id: string; deliveries: { state: string }[] };
      expect(msg.deliveries).toHaveLength(2);
      const expired = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=expired', { agent: 'qa-1' })).json();
      const found = expired.messages.find((m: { id: string }) => m.id === msg.id);
      expect(found.deliveries.every((d: { state: string }) => d.state === 'expired')).toBe(true);
    });
  });

  describe('dead-letter management (T7)', () => {
    async function killToDead(app: ReturnType<typeof createApp>, id: string, reader: string) {
      for (let i = 0; i < 3; i++) {
        await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: reader });
        await api(app, 'POST', `/v1/messages/${id}/ack`, { agent: reader, body: { status: 'failed', error: 'boom' } });
      }
    }

    it('requeue returns a dead message to the queue with attempts reset', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1', { roles: ['producer'] });
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const sent = await (
        await api(app, 'POST', '/v1/boards/sprint-7/messages', {
          agent: 'producer-1',
          body: { to: 'role:qa', type: 'request', payload: { text: 'resurrect me' } },
        })
      ).json();
      await killToDead(app, sent.message.id, 'qa-1');

      const dead = await (await api(app, 'GET', '/v1/boards/sprint-7/messages?status=dead', { agent: 'qa-1' })).json();
      expect(dead.messages).toHaveLength(1);

      const requeued = await api(app, 'POST', `/v1/messages/${sent.message.id}/requeue`, { agent: 'producer-1' });
      expect(requeued.status).toBe(200);
      expect((await requeued.json()).message).toMatchObject({ state: 'pending', attempts: 0 });

      // Redeliverable with a fresh attempt count.
      const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })).json();
      expect(mail.messages[0].id).toBe(sent.message.id);
      expect(mail.messages[0].attempts).toBe(1);
    });

    it('requeue is sender-only and dead-only', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1');
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const sent = await (
        await api(app, 'POST', '/v1/boards/sprint-7/messages', {
          agent: 'producer-1',
          body: { to: 'role:qa', type: 'request', payload: { text: 'x' } },
        })
      ).json();
      // Non-sender requeue.
      expect((await api(app, 'POST', `/v1/messages/${sent.message.id}/requeue`, { agent: 'qa-1' })).status).toBe(403);
      // Requeueing a non-dead message.
      expect((await api(app, 'POST', `/v1/messages/${sent.message.id}/requeue`, { agent: 'producer-1' })).status).toBe(409);
    });

    it('requeue resets every delivery of a dead broadcast', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1');
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      await heartbeat(app, 'qa-2', { roles: ['qa'] });
      const sent = await (
        await api(app, 'POST', '/v1/boards/sprint-7/messages', {
          agent: 'producer-1',
          body: { to: 'broadcast', type: 'note', payload: { text: 'broadcast dead' } },
        })
      ).json();
      await killToDead(app, sent.message.id, 'qa-1');
      await killToDead(app, sent.message.id, 'qa-2');
      // The sender is a member too (spec §3.2) — its delivery must also be dead
      // for the aggregate to reach 'dead' and requeue to apply.
      await killToDead(app, sent.message.id, 'producer-1');

      const requeued = await api(app, 'POST', `/v1/messages/${sent.message.id}/requeue`, { agent: 'producer-1' });
      expect(requeued.status).toBe(200);
      expect((await requeued.json()).message.state).toBe('pending');

      // Both readers get a fresh copy again.
      for (const reader of ['qa-1', 'qa-2']) {
        const mail = await (await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: reader })).json();
        expect(mail.messages[0].delivery).toMatchObject({ readerId: reader, attempts: 1 });
      }
    });

    it('purge deletes the message and its deliveries (sender-only)', async () => {
      const { app } = makeCtx();
      await heartbeat(app, 'producer-1');
      await heartbeat(app, 'qa-1', { roles: ['qa'] });
      const sent = await (
        await api(app, 'POST', '/v1/boards/sprint-7/messages', {
          agent: 'producer-1',
          body: { to: 'role:qa', type: 'note', payload: { text: 'delete me' } },
        })
      ).json();
      expect((await api(app, 'DELETE', `/v1/messages/${sent.message.id}`, { agent: 'qa-1' })).status).toBe(403);
      expect((await api(app, 'DELETE', `/v1/messages/${sent.message.id}`, { agent: 'producer-1' })).status).toBe(200);
      expect((await api(app, 'POST', `/v1/messages/${sent.message.id}/ack`, { agent: 'qa-1', body: { status: 'done' } })).status).toBe(404);
      expect((await api(app, 'DELETE', `/v1/messages/${sent.message.id}`, { agent: 'producer-1' })).status).toBe(404);
    });
  });
});