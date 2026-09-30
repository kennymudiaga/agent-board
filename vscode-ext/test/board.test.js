import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import { serve } from '@hono/node-server';
import { Store } from '../../server/src/db.ts';
import { createApp } from '../../server/src/app.ts';
import { fetchBoardState, watchBoard, formatAgent, formatMessage } from '../src/board.js';

const TOKEN = 'ext-test-token';

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

const auth = (agent) => ({
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  ...(agent ? { 'x-agent-id': agent } : {}),
});

async function api(method, path, { agent, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: auth(agent),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('vscode-ext board helpers (T4)', () => {
  it('fetchBoardState returns agents and messages (identity-less GETs)', async () => {
    await api('POST', '/v1/heartbeat', {
      body: { agentId: 'reviewer-1', roles: ['reviewer'], boards: ['sprint-8'], status: 'busy', currentTask: 'reviewing' },
    });
    await api('POST', '/v1/boards/sprint-8/messages', {
      agent: 'producer-1',
      body: { to: 'broadcast', type: 'note', payload: { text: 'standup: statuses please' } },
    });

    const view = await fetchBoardState({ server: baseUrl, board: 'sprint-8', token: TOKEN });
    expect(view.agents.map((a) => a.agentId)).toContain('reviewer-1');
    expect(view.messages.some((m) => m.payload.text === 'standup: statuses please')).toBe(true);
  });

  it('fetchBoardState surfaces errors', async () => {
    await expect(fetchBoardState({ server: baseUrl, board: 'sprint-8', token: 'wrong' })).rejects.toThrow(/HTTP/);
  });

  it('watchBoard emits on new messages and agents, and closes cleanly', async () => {
    const events = [];
    const watcher = watchBoard({ server: baseUrl, board: 'sprint-8', token: TOKEN }, (e) => events.push(e));

    await new Promise((r) => setTimeout(r, 300)); // let the SSE connect
    await api('POST', '/v1/heartbeat', { body: { agentId: 'reviewer-2', boards: ['sprint-8'] } });
    await api('POST', '/v1/boards/sprint-8/messages', {
      agent: 'producer-1',
      body: { to: 'broadcast', type: 'note', payload: { text: 'second' } },
    });

    await new Promise((r) => setTimeout(r, 500));
    watcher.close();
    expect(events).toContain('agent');
    expect(events).toContain('message');
  }, 10_000);

  it('formatters are sane', () => {
    expect(formatAgent({ agentId: 'a', presence: 'online', status: 'busy', currentTask: 'x' })).toContain('a [online] busy — x');
    expect(formatMessage({ id: 'm1', seq: 1, from: 'a', to: 'b', type: 'note', payload: { text: 'hi' }, state: 'claimed' })).toContain('m1 #1 a -> b [note]');
  });

  it('watchBoard reconnects after the SSE stream drops (regression #21)', async () => {
    // A flaky SSE endpoint: the first connection dies immediately; the second
    // stays healthy and pushes an agent event.
    let connections = 0;
    const flaky = createServer((req, res) => {
      connections++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: hello\ndata: {}\n\n');
      if (connections === 1) {
        setTimeout(() => res.destroy(), 30); // drop the stream
      } else {
        setTimeout(() => res.write('event: agent\ndata: {"agentId":"x"}\n\n'), 150);
      }
      req.on('close', () => res.end()); // client went away — close our side
    });
    await new Promise((r) => flaky.listen(0, r));
    const flakyUrl = `http://127.0.0.1:${flaky.address().port}`;

    try {
      const events = [];
      const watcher = watchBoard({ server: flakyUrl, board: 'x', token: 't' }, (e) => events.push(e), {
        backoffBaseMs: 50,
      });
      // First stream dies -> reconnect -> connect + agent events arrive.
      await new Promise((r) => setTimeout(r, 1200));
      watcher.close();
      expect(events).toContain('connect');
      expect(events).toContain('agent');
      expect(connections).toBeGreaterThanOrEqual(2);
    } finally {
      await new Promise((r) => flaky.close(r));
    }
  }, 10_000);
});