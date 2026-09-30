import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from '../../server/src/db.ts';
import { createApp } from '../../server/src/app.ts';

const TOKEN = 'cli-test-token';
const CLI = resolve(import.meta.dirname, '..', 'bin', 'ab.js');
const ROOT = resolve(import.meta.dirname, '..', '..');

let server;
let baseUrl;
let store;

beforeAll(async () => {
  store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  const srv = serve({ fetch: app.fetch, port: 0 });
  await new Promise((resolveReady) => srv.once('listening', resolveReady));
  server = srv;
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  store.close();
});

function runCli(args, { cwd, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, AB_SERVER: baseUrl, AB_TOKEN: TOKEN, ...env } },
      (err, stdout, stderr) => {
        resolvePromise({ code: err?.code ?? 0, stdout, stderr });
      },
    );
  });
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'ab-cli-'));
}

const AGENT_ID = 'cli-agent';

async function initWorkspace(dir, agentId = AGENT_ID, extra = []) {
  const r = await runCli(['init', '--agent-id', agentId, '--roles', 'qa,dev', '--provider', 'vitest', ...extra], { cwd: dir });
  expect(r.code).toBe(0, r.stderr);
  return r;
}

describe('ab CLI against the reference server', () => {
  it('init writes .agentboard.json', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      const cfg = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      expect(cfg).toMatchObject({ server: baseUrl, token: TOKEN, agentId: AGENT_ID, roles: ['qa', 'dev'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors without config and with a bad token', async () => {
    const dir = makeWorkspace();
    try {
      const noCfg = await runCli(['send', '--board', 'b', '--to', 'role:qa', '--message', 'x'], { cwd: dir });
      expect(noCfg.code).not.toBe(0);
      expect(noCfg.stderr).toContain('ab init');

      await initWorkspace(dir);
      const badToken = await runCli(['heartbeat', '--once'], { cwd: dir, env: { AB_TOKEN: 'wrong' } });
      expect(badToken.code).not.toBe(0);
      expect(badToken.stderr).toContain('bearer token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drives the full lifecycle: heartbeat -> send -> read -> ack done -> no redelivery', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });

      const hb = await runCli(['heartbeat', '--interval', '15', '--status', 'busy', '--task', 'reviewing', '--once'], { cwd: dir });
      expect(hb.code).toBe(0, hb.stderr);
      expect(hb.stdout).toContain('ttl=45');

      const sent = await runCli(
        ['send', '--board', 'sprint-7', '--to', 'role:qa', '--type', 'request', '--message', 'review PR #12', '--idempotency-key', 'k1', '--json'],
        { cwd: dir },
      );
      expect(sent.code).toBe(0, sent.stderr);
      const msg = JSON.parse(sent.stdout);
      expect(msg).toMatchObject({ board: 'sprint-7', from: AGENT_ID, to: 'role:qa', type: 'request', state: 'pending' });

      // Duplicate idempotency key -> 409 with original id.
      const dup = await runCli(
        ['send', '--board', 'sprint-7', '--to', 'role:qa', '--type', 'request', '--message', 'again', '--idempotency-key', 'k1'],
        { cwd: dir },
      );
      expect(dup.code).not.toBe(0);
      expect(dup.stderr).toContain('original message');

      // Pickup as a qa-role agent.
      const qaDir = makeWorkspace();
      try {
        await runCli(['init', '--agent-id', 'qa-1', '--roles', 'qa'], { cwd: qaDir });
        await runCli(['join', '--board', 'sprint-7'], { cwd: qaDir });
        await runCli(['heartbeat', '--interval', '15', '--once'], { cwd: qaDir });

        const readOnce = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: qaDir });
        expect(readOnce.code).toBe(0, readOnce.stderr);
        expect(readOnce.stdout).toContain(msg.id);
        expect(readOnce.stdout).toContain('review PR #12');

        const acked = await runCli(['ack', '--id', msg.id, '--status', 'done'], { cwd: qaDir });
        expect(acked.code).toBe(0, acked.stderr);
        expect(acked.stdout).toContain('done');

        // No redelivery; cursor persisted means a fresh read skips consumed mail.
        const again = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: qaDir });
        expect(again.code).toBe(0, again.stderr);
        expect(again.stdout).not.toContain(msg.id);
      } finally {
        rmSync(qaDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acks failed -> retries -> dead-letters after max attempts', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
      await runCli(['heartbeat', '--once'], { cwd: dir });

      const sent = await runCli(['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--message', 'flaky', '--json'], { cwd: dir });
      const msg = JSON.parse(sent.stdout);

      for (let i = 1; i <= 3; i++) {
        const mail = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
        expect(mail.stdout, `read ${i}: stderr=${mail.stderr}`).toContain(msg.id);
        const ack = await runCli(['ack', '--id', msg.id, '--status', 'failed', '--error', `boom ${i}`], { cwd: dir });
        expect(ack.stdout).toContain(i < 3 ? 'pending' : 'dead');
      }

      const gone = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
      expect(gone.stdout).not.toContain(msg.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('read --ack auto-acks, and ack conflicts exit non-zero', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
      await runCli(['heartbeat', '--once'], { cwd: dir });
      await runCli(['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--message', 'auto'], { cwd: dir });

      const read = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once', '--ack', 'done'], { cwd: dir });
      expect(read.code).toBe(0, read.stderr);
      expect(read.stdout).toContain('[ack]');

      // A second ack is a conflict (already done) -> non-zero exit.
      const id = /msg_[A-Za-z0-9_-]+/.exec(read.stdout)?.[0];
      const conflict = await runCli(['ack', '--id', id, '--status', 'done'], { cwd: dir });
      expect(conflict.code).not.toBe(0);
      expect(conflict.stderr).toContain('not in claimed state');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports validation errors cleanly', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      const bad = await runCli(['send', '--board', 'sprint-7', '--to', 'nonsense', '--message', 'x'], { cwd: dir });
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('to must be');
      expect(existsSync(join(dir, '.agentboard.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid board names on join (regression #10)', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      const bad = await runCli(['join', '--board', 'BAD BOARD!'], { cwd: dir });
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('invalid board name');

      const cfg = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      expect(cfg.boards).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--ack claimed does not advance the cursor; redelivery still arrives (regression #11)', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
      await runCli(['heartbeat', '--once'], { cwd: dir });
      const sent = await runCli(['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--message', 'renewed', '--json'], { cwd: dir });
      const msg = JSON.parse(sent.stdout);

      // Lease-renew (ack claimed) — NOT finalization.
      const renew = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once', '--ack', 'claimed'], { cwd: dir });
      expect(renew.code).toBe(0, renew.stderr);
      expect(renew.stdout).toContain(msg.id);

      // Watermark must NOT have advanced past the message.
      const cfg = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      expect(cfg.cursors['sprint-7']).toBe(0);

      // Simulate the crash window: lease expires server-side.
      store.db
        .prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?')
        .run(Date.now() - 1, msg.id);

      // A fresh read (new process, empty seen-set) must see the redelivery.
      const redelivered = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
      expect(redelivered.code).toBe(0, redelivered.stderr);
      expect(redelivered.stdout).toContain(msg.id);
      expect(redelivered.stdout).toContain('claimed');

      // Attempt count proves the redelivery was claimed anew.
      const row = store.db.prepare('SELECT attempts FROM messages WHERE id = ?').get(msg.id);
      expect(row.attempts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});