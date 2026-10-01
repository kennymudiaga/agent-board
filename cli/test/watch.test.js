import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from '../../server/src/db.ts';
import { createApp } from '../../server/src/app.ts';

const TOKEN = 'watch-test-token';
const CLI = resolve(import.meta.dirname, '..', 'bin', 'ab.js');

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
    ...(opts.headers ?? {}),
  };
  return fetch(`${baseUrl}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'ab-watch-'));
}

/** The --exec recorder: appends the AB_WATCH_* brief (env-only channel) as JSON lines. */
const RECORD = `const fs = require('node:fs');
fs.appendFileSync(process.env.MARKER, JSON.stringify({
  id: process.env.AB_WATCH_MESSAGE_ID,
  board: process.env.AB_WATCH_BOARD,
  seq: process.env.AB_WATCH_SEQ,
  from: process.env.AB_WATCH_FROM,
  to: process.env.AB_WATCH_TO,
  type: process.env.AB_WATCH_TYPE,
  text: process.env.AB_WATCH_TEXT,
}) + '\\n');
`;

function startWatch(args, dir, env = {}) {
  const child = spawn(process.execPath, [CLI, 'watch', ...args], {
    cwd: dir,
    env: { ...process.env, AB_SERVER: baseUrl, AB_TOKEN: TOKEN, AB_AGENT_ID: 'watch-1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Capture the exit promise at spawn time — with --once the watcher can
  // exit before a late-attached listener would see the event.
  child.exitPromise = new Promise((resolvePromise) => child.on('close', resolvePromise));
  return child;
}

async function waitForMarker(marker, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

describe('ab watch — wake-on-mail daemon (sprint 5 T1)', () => {
  it('fires --exec when mail for the watched identity lands, and never acks', { timeout: 20_000 }, async () => {
    const dir = makeWorkspace();
    const marker = join(dir, 'fired.jsonl');
    const record = join(dir, 'record.cjs');
    writeFileSync(record, RECORD);
    await api('POST', '/v1/heartbeat', { body: { agentId: 'qa-1', roles: ['qa'], boards: ['watch-b1'], interval: 15 } });

    const child = startWatch(['--board', 'watch-b1', '--for', 'qa-1', '--exec', `node ${record}`, '--once'], dir, { MARKER: marker });
    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(String(d)));
    await new Promise((r) => setTimeout(r, 1200)); // let it prime + connect

    const sent = await api('POST', '/v1/boards/watch-b1/messages', {
      agent: 'producer-1',
      body: { to: 'role:qa', type: 'request', payload: { text: 'wake up and review PR #12' } },
    });
    expect(sent.status).toBe(201);
    const msg = (await sent.json()).message;

    const lines = await waitForMarker(marker);
    expect(lines, `marker never appeared (stderr: ${stderr.join('')})`).not.toBeNull();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      id: msg.id,
      board: 'watch-b1',
      from: 'producer-1',
      to: 'role:qa',
      type: 'request',
      text: 'wake up and review PR #12',
    });

    // Never acks/claims: the message is still pending and claimable.
    const view = await api('GET', '/v1/boards/watch-b1/messages?since=0', {});
    const m = (await view.json()).messages.find((x) => x.id === msg.id);
    expect(m.state).toBe('pending');
    expect(m.claimAgent).toBeNull();

    // --once: the watcher exits cleanly after the first action.
    const code = await child.exitPromise;
    expect(code).toBe(0);
    expect(stderr.join('')).toBe('');
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores mail for other identities, then fires for the watched one (agent: match)', { timeout: 20_000 }, async () => {
    const dir = makeWorkspace();
    const marker = join(dir, 'fired.jsonl');
    const record = join(dir, 'record.cjs');
    writeFileSync(record, RECORD);
    await api('POST', '/v1/heartbeat', { body: { agentId: 'qa-1', roles: ['qa'], boards: ['watch-b2'], interval: 15 } });

    const child = startWatch(['--board', 'watch-b2', '--for', 'qa-1', '--exec', `node ${record}`, '--once'], dir, { MARKER: marker });
    await new Promise((r) => setTimeout(r, 1200));

    // Mail for another agent must not fire the action.
    await api('POST', '/v1/boards/watch-b2/messages', { agent: 'producer-1', body: { to: 'agent:dev-9', type: 'request', payload: { text: 'not yours' } } });
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(marker)).toBe(false);

    // Direct agent: mail to the watched identity fires.
    const sent = await api('POST', '/v1/boards/watch-b2/messages', { agent: 'producer-1', body: { to: 'agent:qa-1', type: 'question', payload: { text: 'ship today?' } } });
    const msg = (await sent.json()).message;
    const lines = await waitForMarker(marker);
    expect(lines).not.toBeNull();
    expect(JSON.parse(lines[0])).toMatchObject({ id: msg.id, to: 'agent:qa-1' });

    await child.exitPromise;
    rmSync(dir, { recursive: true, force: true });
  });

  it('daemon mode fires once per message id and keeps watching', { timeout: 20_000 }, async () => {
    const dir = makeWorkspace();
    const marker = join(dir, 'fired.jsonl');
    const record = join(dir, 'record.cjs');
    writeFileSync(record, RECORD);
    await api('POST', '/v1/heartbeat', { body: { agentId: 'qa-1', roles: ['qa'], boards: ['watch-b3'], interval: 15 } });

    const child = startWatch(['--board', 'watch-b3', '--for', 'qa-1', '--exec', `node ${record}`], dir, { MARKER: marker });
    await new Promise((r) => setTimeout(r, 1200));

    const a = await (await api('POST', '/v1/boards/watch-b3/messages', { agent: 'producer-1', body: { to: 'role:qa', type: 'request', payload: { text: 'first' } } })).json();
    const b = await (await api('POST', '/v1/boards/watch-b3/messages', { agent: 'producer-1', body: { to: 'role:qa', type: 'request', payload: { text: 'second' } } })).json();
    const lines = await waitForMarker(marker);
    expect(lines).not.toBeNull();
    // Give any duplicates time to appear, then assert each id fired exactly once.
    await new Promise((r) => setTimeout(r, 800));
    const ids = readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
    expect(ids.filter((x) => x === a.message.id)).toHaveLength(1);
    expect(ids.filter((x) => x === b.message.id)).toHaveLength(1);

    child.kill();
    await child.exitPromise;
    rmSync(dir, { recursive: true, force: true });
  });

  it('validates: requires an action and a valid board', async () => {
    const dir = makeWorkspace();
    const run = (args) =>
      new Promise((res) => {
        execFile(process.execPath, [CLI, 'watch', ...args], { cwd: dir, env: { ...process.env, AB_SERVER: baseUrl, AB_TOKEN: TOKEN, AB_AGENT_ID: 'watch-1' } }, (err, stdout, stderr) =>
          res({ code: err?.code ?? 0, stderr }),
        );
      });
    const noAction = await run(['--board', 'watch-b4']);
    expect(noAction.code).not.toBe(0);
    expect(noAction.stderr).toContain('at least one action');

    const badBoard = await run(['--board', 'BAD BOARD!', '--exec', 'true']);
    expect(badBoard.code).not.toBe(0);
    expect(badBoard.stderr).toContain('invalid board name');

    const noBoard = await run(['--for', 'qa-1', '--exec', 'true']);
    expect(noBoard.code).not.toBe(0);
    expect(noBoard.stderr).toContain('--board');
    rmSync(dir, { recursive: true, force: true });
  });
});