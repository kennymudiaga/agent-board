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
});