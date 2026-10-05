import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { serve } from '@hono/node-server';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../server/src/db.ts';
import { createApp } from '../../../server/src/app.ts';
import {
  BoardWatcher,
  addressedTo,
  buildWakePrompt,
  createWakeController,
  defaultGlobalConfigPath,
  LazyResolver,
  resolveConfig,
  wakeResolveMs,
} from '../wake-core.js';

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

// The controller reads process.env — isolate from the runner's ambient env
// and from any real machine-wide global config (hermeticity, same class as
// the cli.test.js AB_ENV_VARS hygiene).
const AMBIENT = ['AB_SERVER', 'AB_TOKEN', 'AB_AGENT_ID', 'AB_BOARD', 'AB_WAKE_RESOLVE_MS'];
const savedEnv = {};
beforeEach(() => {
  for (const k of AMBIENT) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedEnv.APPDATA = process.env.APPDATA;
  savedEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = mkdtempSync(join(tmpdir(), 'ab-wake-appdata-'));
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'ab-wake-xdg-'));
});
afterEach(() => {
  for (const k of AMBIENT) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  if (savedEnv.APPDATA !== undefined) process.env.APPDATA = savedEnv.APPDATA;
  else delete process.env.APPDATA;
  if (savedEnv.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  else delete process.env.XDG_CONFIG_HOME;
});

function api(method, path, opts = {}) {
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
  };
  return fetch(`${baseUrl}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'ab-wake-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Deterministic timer for LazyResolver tests: manual ticks, no real interval. */
function fakeTimer() {
  let next = 0;
  const fns = new Map();
  return {
    setInterval(fn) {
      const id = ++next;
      fns.set(id, fn);
      return id;
    },
    clearInterval(id) {
      fns.delete(id);
    },
    tickAll() {
      for (const fn of [...fns.values()]) fn();
    },
    pending() {
      return fns.size;
    },
  };
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

describe('resolveConfig env -> file -> global precedence (sprint 9 T1, #101)', () => {
  it('env wins over the workspace file and the global config', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.agentboard.json'), JSON.stringify({ server: 'http://file', token: 'f-tok', agentId: 'f-id', boards: ['f-b'] }));
    const g = makeTempDir();
    writeFileSync(join(g, 'config.json'), JSON.stringify({ server: 'http://global', token: 'g-tok', agentId: 'g-id', boards: ['g-b'] }));
    try {
      const cfg = resolveConfig(dir, { AB_SERVER: 'http://env', AB_TOKEN: 'e-tok', AB_AGENT_ID: 'e-id', AB_BOARD: 'e-b' }, join(g, 'config.json'));
      expect(cfg).toEqual({ server: 'http://env', token: 'e-tok', agentId: 'e-id', board: 'e-b' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(g, { recursive: true, force: true });
    }
  });

  it('the workspace file wins over the global config; board from file boards[0]', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.agentboard.json'), JSON.stringify({ server: 'http://file', token: 'f-tok', agentId: 'f-id', boards: ['f-b', 'f-b2'] }));
    const g = makeTempDir();
    writeFileSync(join(g, 'config.json'), JSON.stringify({ server: 'http://global', token: 'g-tok', agentId: 'g-id', boards: ['g-b'] }));
    try {
      const cfg = resolveConfig(dir, {}, join(g, 'config.json'));
      expect(cfg).toEqual({ server: 'http://file', token: 'f-tok', agentId: 'f-id', board: 'f-b' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(g, { recursive: true, force: true });
    }
  });

  it('a virgin repo on a configured machine resolves from the global config', () => {
    const dir = makeTempDir(); // no .agentboard.json — fresh clone
    const g = makeTempDir();
    writeFileSync(join(g, 'config.json'), JSON.stringify({ server: 'http://global', token: 'g-tok', agentId: 'g-id', boards: ['g-b'] }));
    try {
      const cfg = resolveConfig(dir, {}, join(g, 'config.json'));
      expect(cfg).toEqual({ server: 'http://global', token: 'g-tok', agentId: 'g-id', board: 'g-b' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(g, { recursive: true, force: true });
    }
  });

  it('AB_BOARD overrides file/global boards; partial env merges with the file', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.agentboard.json'), JSON.stringify({ server: 'http://file', token: 'f-tok', agentId: 'f-id', boards: ['f-b'] }));
    try {
      const cfg = resolveConfig(dir, { AB_BOARD: 'env-board' }, join(makeTempDir(), 'config.json'));
      expect(cfg).toEqual({ server: 'http://file', token: 'f-tok', agentId: 'f-id', board: 'env-board' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no source yields server + token + agentId', () => {
    const dir = makeTempDir();
    const g = makeTempDir();
    try {
      expect(resolveConfig(dir, {}, join(g, 'config.json'))).toBeNull();
      // Partial file (missing token) also resolves null.
      writeFileSync(join(dir, '.agentboard.json'), JSON.stringify({ server: 'http://file', agentId: 'f-id' }));
      expect(resolveConfig(dir, {}, join(g, 'config.json'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(g, { recursive: true, force: true });
    }
  });

  it('defaultGlobalConfigPath mirrors the CLI (APPDATA on win32, XDG elsewhere)', () => {
    if (process.platform === 'win32') {
      const p = defaultGlobalConfigPath({ APPDATA: 'C:\\Users\\t\\AppData\\Roaming' });
      expect(p).toBe(join('C:\\Users\\t\\AppData\\Roaming', 'agentboard', 'config.json'));
    } else {
      const x = defaultGlobalConfigPath({ XDG_CONFIG_HOME: '/home/t/.config' });
      expect(x).toBe(join('/home/t/.config', 'agentboard', 'config.json'));
      // Fallback to ~/.config when XDG_CONFIG_HOME is unset.
      const f = defaultGlobalConfigPath({});
      expect(f).toBe(join(homedir(), '.config', 'agentboard', 'config.json'));
    }
  });
});

describe('wakeResolveMs coercion (sprint 10 T2, #110 follow-up)', () => {
  it('falls back to the default on NaN/invalid values, clamps sub-second values', () => {
    expect(wakeResolveMs({})).toBe(5000);
    expect(wakeResolveMs({ AB_WAKE_RESOLVE_MS: '2500' })).toBe(2500);
    expect(wakeResolveMs({ AB_WAKE_RESOLVE_MS: 'abc' })).toBe(5000);
    expect(wakeResolveMs({ AB_WAKE_RESOLVE_MS: '0' })).toBe(5000);
    expect(wakeResolveMs({ AB_WAKE_RESOLVE_MS: '-5' })).toBe(5000);
    expect(wakeResolveMs({ AB_WAKE_RESOLVE_MS: 'Infinity' })).toBe(5000);
    expect(wakeResolveMs({ AB_WAKE_RESOLVE_MS: '7' }, 9999)).toBe(7);
    expect(wakeResolveMs({}, 1234)).toBe(1234);
  });
});

describe('LazyResolver state machine (sprint 9 T1, #101)', () => {
  it('inert -> configured -> rebind; unchanged config never re-fires onChange', () => {
    let cfg = null;
    const changes = [];
    const timer = fakeTimer();
    const r = new LazyResolver({
      resolve: () => cfg,
      onChange: (c) => changes.push(c),
      timer,
    });
    r.start();
    expect(changes).toEqual([null]); // initial tick: inert

    cfg = { server: 's', token: 't', agentId: 'a', board: 'b1' };
    timer.tickAll();
    expect(changes).toEqual([null, cfg]); // config appears -> bind

    timer.tickAll();
    timer.tickAll(); // unchanged -> NO restart
    expect(changes).toEqual([null, cfg]);

    const switched = { server: 's', token: 't', agentId: 'a', board: 'b2' };
    cfg = switched; // board switch mid-session -> rebind
    timer.tickAll();
    expect(changes).toEqual([null, { server: 's', token: 't', agentId: 'a', board: 'b1' }, switched]);

    cfg = null; // config disappears -> inert again
    timer.tickAll();
    expect(changes.at(-1)).toBeNull();

    r.stop();
    expect(timer.pending()).toBe(0);
  });

  it('resolve errors are swallowed and never fire onChange', () => {
    const changes = [];
    let fail = true;
    const timer = fakeTimer();
    const r = new LazyResolver({
      resolve: () => {
        if (fail) throw new Error('boom');
        return { server: 's', token: 't', agentId: 'a', board: 'b' };
      },
      onChange: (c) => changes.push(c),
      onLog: () => {},
      timer,
    });
    r.start();
    expect(changes).toEqual([]);
    fail = false;
    timer.tickAll();
    expect(changes).toEqual([{ server: 's', token: 't', agentId: 'a', board: 'b' }]);
    r.stop();
  });

  it('keyOf distinguishes every watch dimension', () => {
    const base = { server: 's', token: 't', agentId: 'a', board: 'b' };
    expect(LazyResolver.keyOf(base)).toBe(LazyResolver.keyOf({ ...base }));
    expect(LazyResolver.keyOf({ ...base, board: 'c' })).not.toBe(LazyResolver.keyOf(base));
    expect(LazyResolver.keyOf({ ...base, agentId: 'x' })).not.toBe(LazyResolver.keyOf(base));
    expect(LazyResolver.keyOf({ ...base, token: 'y' })).not.toBe(LazyResolver.keyOf(base));
    expect(LazyResolver.keyOf(null)).toBeNull();
    expect(LazyResolver.keyOf(undefined)).toBeNull();
  });
});

describe('createWakeController lazy binding (sprint 9 T1, #101)', () => {
  it('a virgin repo is inert at load; a mid-session `ab join` starts wake without relaunch', async () => {
    const dir = makeTempDir(); // fresh clone: no .agentboard.json, no global config
    const prompts = [];
    const client = {
      app: { log: async () => {} },
      session: {
        list: async () => ({ data: [{ id: 'sess-1' }] }),
        promptAsync: async ({ body }) => {
          prompts.push(body.parts[0].text);
        },
      },
    };
    await api('POST', '/v1/heartbeat', { body: { agentId: 'qa-1', roles: ['qa'], boards: ['wake-lazy'], interval: 15 } });
    try {
      const ctl = createWakeController({ client, directory: dir, intervalMs: 100, pollMs: 200 });
      ctl.start();
      await sleep(250); // inert at load — nothing injected, no crash
      expect(prompts).toEqual([]);

      // Another terminal runs `ab join --board wake-lazy` -> config appears.
      writeFileSync(
        join(dir, '.agentboard.json'),
        JSON.stringify({ server: baseUrl, token: TOKEN, agentId: 'qa-1', boards: ['wake-lazy'] }),
      );
      await sleep(400); // resolver picks it up; watcher starts + primes

      const sent = await api('POST', '/v1/boards/wake-lazy/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'lazy wake me' } },
      });
      const msg = (await sent.json()).message;

      await sleep(700); // SSE/poll delivers -> wake prompt injected
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts[0]).toContain(msg.id);
      expect(prompts[0]).toContain('lazy wake me');

      // Read-only: the message is still pending and claimable by the agent.
      const view = await api('GET', '/v1/boards/wake-lazy/messages?since=0', {});
      const observed = (await view.json()).messages.find((m) => m.id === msg.id);
      expect(observed.state).toBe('pending');
      expect(observed.claimAgent).toBeNull();

      ctl.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});