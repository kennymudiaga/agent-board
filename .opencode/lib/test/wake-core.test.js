import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Store } from '../../../server/src/db.ts';
import { createApp } from '../../../server/src/app.ts';
import { BoardWatcher, addressedTo, buildWakePrompt } from '../wake-core.js';

const TOKEN = 'wake-plugin-test-token';

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
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  store.close();
});

function api(method, path, opts = {}) {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
  };
  return fetch(`${baseUrl}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

describe('agentboard-wake core (sprint 5 T2)', () => {
  it('addressedTo filters agent:/role: mail to the identity, never its own', () => {
    const roles = ['qa'];
    expect(addressedTo({ from: 'producer-1', to: 'agent:qa-1' }, 'qa-1', roles)).toBe(true);
    expect(addressedTo({ from: 'producer-1', to: 'role:qa' }, 'qa-1', roles)).toBe(true);
    expect(addressedTo({ from: 'producer-1', to: 'role:dev' }, 'qa-1', roles)).toBe(false);
    expect(addressedTo({ from: 'producer-1', to: 'broadcast' }, 'qa-1', roles)).toBe(false);
    expect(addressedTo({ from: 'qa-1', to: 'agent:qa-1' }, 'qa-1', roles)).toBe(false); // wake-loop guard
  });

  it('buildWakePrompt carries id, board, thread refs, sender, text', () => {
    const p = buildWakePrompt({ id: 'msg_x', board: 'sprint-8', from: 'producer-1', to: 'role:qa', type: 'request', replyTo: 'msg_y', payload: { text: 'review PR #12' } });
    expect(p).toContain('msg_x');
    expect(p).toContain('sprint-8');
    expect(p).toContain('msg_y');
    expect(p).toContain('producer-1');
    expect(p).toContain('review PR #12');
  });

  it('the watcher fires onMail for matching mail, never claims it, and dedupes', async () => {
    await api('POST', '/v1/heartbeat', { body: { agentId: 'qa-1', roles: ['qa'], boards: ['wake-b1'], interval: 15 } });

    const fired = [];
    const watcher = new BoardWatcher({
      server: baseUrl,
      token: TOKEN,
      board: 'wake-b1',
      forId: 'qa-1',
      onMail: (m) => fired.push(m),
      pollMs: 200,
    });
    await watcher.loadRoles(); // run() does this; refresh() alone needs it for role: matching
    await watcher.refresh(); // prime (no firing)

    const sent = await api('POST', '/v1/boards/wake-b1/messages', { agent: 'producer-1', body: { to: 'role:qa', type: 'request', payload: { text: 'wake me' } } });
    const msg = (await sent.json()).message;

    await watcher.refresh();
    await watcher.refresh(); // redelivery/duplicate passes must not re-fire
    expect(fired.map((m) => m.id)).toEqual([msg.id]);

    // Never claims: the message is still pending and claimable.
    const view = await api('GET', '/v1/boards/wake-b1/messages?since=0', {});
    const observed = (await view.json()).messages.find((m) => m.id === msg.id);
    expect(observed.state).toBe('pending');
    expect(observed.claimAgent).toBeNull();
  });

  it('the watcher ignores mail for other identities', async () => {
    await api('POST', '/v1/heartbeat', { body: { agentId: 'qa-1', roles: ['qa'], boards: ['wake-b2'], interval: 15 } });

    const fired = [];
    const watcher = new BoardWatcher({
      server: baseUrl,
      token: TOKEN,
      board: 'wake-b2',
      forId: 'qa-1',
      onMail: (m) => fired.push(m),
      pollMs: 200,
    });
    await watcher.refresh();

    await api('POST', '/v1/boards/wake-b2/messages', { agent: 'producer-1', body: { to: 'agent:dev-9', type: 'request', payload: { text: 'not yours' } } });
    await watcher.refresh();
    expect(fired).toEqual([]);
  });
});