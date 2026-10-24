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
  buildWakeTargets,
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
const AMBIENT = ['AB_SERVER', 'AB_TOKEN', 'AB_AGENT_ID', 'AB_BOARD', 'AB_WAKE_RESOLVE_MS', 'AB_WAKE_SESSION'];
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

/** Poll a predicate instead of sleeping a fixed amount (less flaky). */
async function waitFor(predicate, timeoutMs = 4000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await sleep(stepMs);
  }
}

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
        promptAsync: async ({ path, body }) => {
          prompts.push({ id: path.id, text: body.parts[0].text });
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
      ctl.noteSession('sess-1'); // session.created from the plugin's own event hook (#117)

      const sent = await api('POST', '/v1/boards/wake-lazy/messages', {
        agent: 'producer-1',
        body: { to: 'role:qa', type: 'request', payload: { text: 'lazy wake me' } },
      });
      const msg = (await sent.json()).message;

      await sleep(700); // SSE/poll delivers -> wake prompt injected
      expect(prompts.length).toBeGreaterThan(0);
      expect(prompts[0].id).toBe('sess-1');
      expect(prompts[0].text).toContain(msg.id);
      expect(prompts[0].text).toContain('lazy wake me');

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

describe('session-scoped wake — never the sender, never a fan-out (#117)', () => {
  const BOARD = 'wake-echo';

  function setup(opts = {}) {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, '.agentboard.json'),
      JSON.stringify({ server: baseUrl, token: TOKEN, agentId: 'qa-1', boards: [BOARD] }),
    );
    const prompts = [];
    const logs = [];
    const client = {
      app: { log: async () => {} },
      session: {
        // #117: the old fan-out source. If this is consulted, wake is broken.
        list: async () => {
          throw new Error('session.list must not be used for wake injection (#117)');
        },
        promptAsync: async ({ path, body }) => {
          prompts.push({ id: path.id, text: body.parts[0].text });
        },
      },
    };
    const ctl = createWakeController({
      client,
      directory: dir,
      log: (m) => logs.push(m),
      intervalMs: 50,
      pollMs: 100,
      ...opts,
    });
    return { dir, prompts, logs, ctl };
  }

  async function startPrimed(ctl, logs) {
    ctl.start();
    await waitFor(() => logs.some((l) => l.startsWith('watching board')));
    await sleep(400); // let the watcher prime its head (pre-existing mail never fires)
  }

  async function sendMail(text) {
    const sent = await api('POST', `/v1/boards/${BOARD}/messages`, {
      agent: 'producer-1',
      body: { to: 'agent:qa-1', type: 'request', payload: { text } },
    });
    return (await sent.json()).message;
  }

  beforeEach(async () => {
    await api('POST', '/v1/heartbeat', {
      body: { agentId: 'qa-1', roles: ['qa'], boards: [BOARD], interval: 15 },
    });
  });

  it('wakes the recipient session, not the sender session in the same project', async () => {
    const { dir, prompts, logs, ctl } = setup();
    try {
      ctl.noteSession('sess-qa'); // observed via this process's session.created hook
      await startPrimed(ctl, logs);
      // The sender (producer-1) has a session in the project too — but this
      // process never observed it, so it is not a wake candidate.
      const msg = await sendMail('echo check');

      await waitFor(() => prompts.length > 0);
      expect(prompts).toHaveLength(1);
      expect(prompts[0].id).toBe('sess-qa');
      expect(prompts[0].id).not.toBe('sess-producer');
      expect(prompts[0].text).toContain(msg.id);
      expect(prompts[0].text).toContain('addressed to qa-1');
      expect(prompts[0].text).toContain('if you are not qa-1, ignore');
      expect(logs.some((l) => l.includes('injection failed'))).toBe(false);
    } finally {
      ctl.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('several live sessions in one process are ambiguous: no injection, actionable warning', async () => {
    const { dir, prompts, logs, ctl } = setup();
    try {
      ctl.noteSession('sess-a');
      ctl.noteSession('sess-b');
      await startPrimed(ctl, logs);
      await sendMail('ambiguous check');

      await waitFor(() => logs.some((l) => l.includes('ambiguous wake')));
      await sleep(300); // give a (wrong) fan-out time to happen
      expect(prompts).toEqual([]);
      const warning = logs.find((l) => l.includes('ambiguous wake'));
      expect(warning).toContain('sess-a');
      expect(warning).toContain('sess-b');
      expect(warning).toContain('ab watch --opencode');
    } finally {
      ctl.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AB_WAKE_SESSION pins the target even when several sessions are live', async () => {
    const { dir, prompts, logs, ctl } = setup({ sessionId: 'sess-pin' });
    try {
      ctl.noteSession('sess-a');
      ctl.noteSession('sess-b');
      await startPrimed(ctl, logs);
      const msg = await sendMail('pinned check');

      await waitFor(() => prompts.length > 0);
      expect(prompts.map((p) => p.id)).toEqual(['sess-pin']);
      expect(prompts[0].text).toContain(msg.id);
    } finally {
      ctl.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no observed session skips the wake instead of guessing', async () => {
    const { dir, prompts, logs, ctl } = setup();
    try {
      await startPrimed(ctl, logs);
      await sendMail('nobody home');

      await waitFor(() => logs.some((l) => l.includes('no live session to wake')));
      await sleep(300);
      expect(prompts).toEqual([]);
    } finally {
      ctl.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildWakeTargets: pin wins, one is chosen, several are ambiguous, stale expires', () => {
    const sessions = new Map([
      ['s-a', 0],
      ['s-b', 500],
    ]);
    expect(buildWakeTargets({ pinnedId: 'pin', sessions, now: 2_000, ttlMs: 10_000 })).toEqual({
      id: 'pin',
      reason: 'pinned',
      ids: ['pin'],
    });

    const one = new Map([['s-a', 1_000]]);
    expect(buildWakeTargets({ pinnedId: null, sessions: one, now: 2_000, ttlMs: 10_000 })).toEqual({
      id: 's-a',
      reason: 'single-live-session',
      ids: ['s-a'],
    });

    const amb = buildWakeTargets({ pinnedId: null, sessions, now: 2_000, ttlMs: 10_000 });
    expect(amb.id).toBeNull();
    expect(amb.reason).toBe('ambiguous');
    expect(amb.ids).toEqual(['s-a', 's-b']);

    // Only s-b is inside the TTL window -> unambiguously wake it.
    const fresh = buildWakeTargets({ pinnedId: null, sessions, now: 10_200, ttlMs: 10_000 });
    expect(fresh).toEqual({ id: 's-b', reason: 'single-live-session', ids: ['s-b'] });

    expect(buildWakeTargets({ pinnedId: null, sessions: new Map(), now: 1, ttlMs: 10_000 })).toEqual({
      id: null,
      reason: 'no-live-session',
      ids: [],
    });
  });

  it('buildWakePrompt carries the recipient marker (#117)', () => {
    const p = buildWakePrompt(
      { id: 'msg_x', board: 'b', from: 'producer-1', to: 'agent:qa-1', type: 'request', payload: { text: 'hi' } },
      'qa-1',
    );
    expect(p).toContain('addressed to qa-1');
    expect(p).toContain('if you are not qa-1, ignore this prompt');
    expect(p).toContain('msg_x');
  });
});