import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve } from '@hono/node-server';
import { Store } from '../../server/src/db.ts';
import { createApp } from '../../server/src/app.ts';
import { watchMail, addressedTo, mailText } from '../src/wake.js';

const TOKEN = 'wake-ext-test-token';

let server;
let baseUrl;

beforeAll(async () => {
  const store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  const srv = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => srv.once('listening', r));
  server = srv;
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function api(method, path, opts = {}) {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
  };
  return fetch(`${baseUrl}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe('vscode-ext wake-on-mail watcher (sprint 5 T3)', () => {
  it('addressedTo filters agent:/role: mail to the identity, never its own', () => {
    const roles = ['qa'];
    expect(addressedTo({ from: 'p-1', to: 'agent:ui-agent' }, 'ui-agent', roles)).toBe(true);
    expect(addressedTo({ from: 'p-1', to: 'role:qa' }, 'ui-agent', roles)).toBe(true);
    expect(addressedTo({ from: 'p-1', to: 'role:dev' }, 'ui-agent', roles)).toBe(false);
    expect(addressedTo({ from: 'p-1', to: 'broadcast' }, 'ui-agent', roles)).toBe(false);
    expect(addressedTo({ from: 'ui-agent', to: 'agent:ui-agent' }, 'ui-agent', roles)).toBe(false);
  });

  it('mailText carries sender, thread ref and preview', () => {
    const t = mailText({ id: 'msg_x', from: 'p-1', to: 'agent:ui-agent', type: 'request', replyTo: 'msg_y', payload: { text: 'review PR #12' } });
    expect(t).toContain('p-1');
    expect(t).toContain('msg_y');
    expect(t).toContain('review PR #12');
  });

  it('fires onMail for matching mail, dedupes, and never claims', async () => {
    await api('POST', '/v1/heartbeat', { body: { agentId: 'ui-agent', roles: ['qa'], boards: ['wake-ext-b1'], interval: 15 } });

    const fired = [];
    const watcher = watchMail({ server: baseUrl, board: 'wake-ext-b1', token: TOKEN, forId: 'ui-agent' }, (m) => fired.push(m), { pollMs: 200 });
    await waitFor(() => fired.length >= 0, 'watcher primed');
    await new Promise((r) => setTimeout(r, 300)); // let the prime tick run

    const sent = await api('POST', '/v1/boards/wake-ext-b1/messages', { agent: 'producer-1', body: { to: 'role:qa', type: 'request', payload: { text: 'wake me' } } });
    const msg = (await sent.json()).message;

    await waitFor(() => fired.some((m) => m.id === msg.id), 'onMail fired');
    await new Promise((r) => setTimeout(r, 600)); // extra ticks must not re-fire
    expect(fired.filter((m) => m.id === msg.id)).toHaveLength(1);

    // Never claims: the message is still pending.
    const view = await api('GET', '/v1/boards/wake-ext-b1/messages?since=0', {});
    const observed = (await view.json()).messages.find((m) => m.id === msg.id);
    expect(observed.state).toBe('pending');

    watcher.close();
  });

  it('ignores mail for other identities', async () => {
    await api('POST', '/v1/heartbeat', { body: { agentId: 'ui-agent', roles: ['qa'], boards: ['wake-ext-b2'], interval: 15 } });

    const fired = [];
    const watcher = watchMail({ server: baseUrl, board: 'wake-ext-b2', token: TOKEN, forId: 'ui-agent' }, (m) => fired.push(m), { pollMs: 200 });
    await new Promise((r) => setTimeout(r, 300));

    await api('POST', '/v1/boards/wake-ext-b2/messages', { agent: 'producer-1', body: { to: 'agent:other-1', type: 'request', payload: { text: 'not yours' } } });
    await new Promise((r) => setTimeout(r, 600));
    expect(fired).toEqual([]);

    watcher.close();
  });
});