import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

const TOKEN = 'test-token';

function makeCtx() {
  const store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  return { store, app };
}

function api(app: ReturnType<typeof createApp>, method: string, path: string, opts: { body?: unknown; agent?: string; headers?: Record<string, string> } = {}) {
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

describe('dashboard (T6 stretch)', () => {
  let store: Store;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ store, app } = makeCtx());
  });
  afterEach(() => store.close());

  it('serves the static dashboard at /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('AGENTBOARD');
  });

  it('renders per-reader delivery detail for broadcasts (sprint 5 T7)', async () => {
    const html = await (await app.request('/')).text();
    // The expander scaffolding: summary from the reads aggregate + one row per
    // delivery (reader -> state -> attempts).
    expect(html).toContain('class="reads"');
    expect(html).toContain('reads: ');
    expect(html).toContain('class="read-row"');
    expect(html).toContain('d.readerId');
    expect(html).toContain('d.attempts');
    // The broadcast reads aggregate from T6 is what feeds the summary.
    expect(html).toContain('m.reads');
  });

  it('requires a valid token on the SSE stream', async () => {
    expect((await app.request('/v1/events')).status).toBe(401);
    expect((await app.request('/v1/events?token=wrong')).status).toBe(401);
    expect((await app.request(`/v1/events?token=${TOKEN}`)).status).toBe(200);
  });

  it('streams message and agent events as they happen', async () => {
    const res = await app.request(`/v1/events?token=${TOKEN}&board=sprint-7`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const readChunk = async (): Promise<string> => {
      const { value } = await reader.read();
      return decoder.decode(value);
    };

    // hello event arrives first
    expect(await readChunk()).toContain('event: hello');

    // heartbeat -> agent event
    await api(app, 'POST', '/v1/heartbeat', {
      body: { agentId: 'qa-1', roles: ['qa'], boards: ['sprint-7'], interval: 15 },
    });
    expect(await readChunk()).toContain('event: agent');

    // message post -> message event
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'request', payload: { text: 'hi' } },
    });
    expect(await readChunk()).toContain('event: message');

    await reader.cancel();
  }, 10_000);

  it('serves the dashboard REST fetches without X-Agent-ID (regression #8)', async () => {
    await api(app, 'POST', '/v1/heartbeat', {
      body: { agentId: 'qa-1', roles: ['qa'], boards: ['sprint-7'], interval: 15 },
    });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'request', payload: { text: 'review PR #12' } },
    });

    // Exactly what dashboard.html's refresh() does: Authorization only.
    const agents = await app.request('/v1/agents', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(agents.status).toBe(200);
    expect((await agents.json()).agents).toHaveLength(1);

    const mail = await app.request('/v1/boards/sprint-7/messages', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(mail.status).toBe(200);
    const body = await mail.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].payload).toEqual({ text: 'review PR #12' });
  });

  it('identity-less reads are read-only: they never claim (regression #8)', async () => {
    await api(app, 'POST', '/v1/heartbeat', {
      body: { agentId: 'qa-1', roles: ['qa'], boards: ['sprint-7'], interval: 15 },
    });
    const sent = await (
      await api(app, 'POST', '/v1/boards/sprint-7/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'precious' } },
      })
    ).json();

    // Dashboard view does not claim: the message stays pending.
    const view = await (
      await app.request('/v1/boards/sprint-7/messages', { headers: { authorization: `Bearer ${TOKEN}` } })
    ).json();
    expect(view.messages[0].state).toBe('pending');
    expect(view.messages[0].attempts).toBe(0);

    // A real agent pickup still gets it, fresh with attempts=1.
    const picked = await (
      await api(app, 'GET', '/v1/boards/sprint-7/messages', { agent: 'qa-1' })
    ).json();
    expect(picked.messages).toHaveLength(1);
    expect(picked.messages[0].id).toBe(sent.message.id);
    expect(picked.messages[0].state).toBe('claimed');
    expect(picked.messages[0].attempts).toBe(1);
    expect(picked.messages[0].claimAgent).toBe('qa-1');
  });

  it('lists the board directory read-only (spec §5.8)', async () => {
    await api(app, 'POST', '/v1/heartbeat', {
      body: { agentId: 'qa-1', roles: ['qa'], boards: ['sprint-7', 'sprint-8'], interval: 15 },
    });
    await api(app, 'POST', '/v1/boards/sprint-7/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'note', payload: { text: 'x' } },
    });
    const res = await app.request('/v1/boards', { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const { boards } = await res.json();
    expect(boards.map((b: { name: string }) => b.name).sort()).toEqual(['sprint-7', 'sprint-8']);
    expect(boards.find((b: { name: string }) => b.name === 'sprint-7').messageCount).toBe(1);
    expect(boards.find((b: { name: string }) => b.name === 'sprint-8').messageCount).toBe(0);
  });
});