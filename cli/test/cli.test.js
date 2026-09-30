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

function gitLog(dir) {
  return new Promise((resolvePromise) => {
    execFile('git', ['log', '--pretty=%s'], { cwd: dir }, (err, stdout) => {
      resolvePromise(err ? [] : stdout.split('\n').filter(Boolean));
    });
  });
}

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
      expect(cfg.cursors['sprint-7']).toBe(msg.seq - 1);

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

  it('broadcast fan-out: two agents each receive and finalize their own copy (T2)', async () => {
    const aDir = makeWorkspace();
    const bDir = makeWorkspace();
    try {
      for (const [dir, agentId, roles] of [[aDir, 'cli-agent', 'qa,dev'], [bDir, 'qa-1', 'qa']]) {
        await runCli(['init', '--agent-id', agentId, '--roles', roles], { cwd: dir });
        await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
        await runCli(['heartbeat', '--once'], { cwd: dir });
      }

      const sent = await runCli(['send', '--board', 'sprint-7', '--to', 'broadcast', '--type', 'note', '--message', 'standup: statuses please', '--json'], { cwd: aDir });
      expect(sent.code).toBe(0, sent.stderr);
      const msg = JSON.parse(sent.stdout);
      expect(msg.deliveries.map((d) => d.readerId).sort()).toEqual(['cli-agent', 'qa-1']);

      // Both readers see the broadcast and ack their own copies.
      for (const dir of [aDir, bDir]) {
        const read = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once', '--ack', 'done'], { cwd: dir });
        expect(read.code).toBe(0, read.stderr);
        expect(read.stdout).toContain(msg.id);
        expect(read.stdout).toContain('[ack]');
      }

      // Both deliveries terminal -> aggregate done.
      const view = await (
        await fetch(`${baseUrl}/v1/boards/sprint-7/messages?status=done`, {
          headers: { authorization: `Bearer ${TOKEN}`, 'x-agent-id': 'qa-1' },
        })
      ).json();
      expect(view.messages.some((m) => m.id === msg.id)).toBe(true);
    } finally {
      rmSync(aDir, { recursive: true, force: true });
      rmSync(bDir, { recursive: true, force: true });
    }
  });

  it('sends questions with deadlines (T3)', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
      await runCli(['heartbeat', '--once'], { cwd: dir });
      const deadline = new Date(Date.now() + 120_000).toISOString();
      const sent = await runCli(
        ['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--type', 'question', '--message', 'ship today?', '--deadline', deadline, '--json'],
        { cwd: dir },
      );
      expect(sent.code).toBe(0, sent.stderr);
      const msg = JSON.parse(sent.stdout);
      expect(msg.type).toBe('question');
      expect(msg.deadline).toBe(deadline);
      expect(msg.late).toBe(false);

      // deadline on a non-question is rejected by the server.
      const bad = await runCli(
        ['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--type', 'note', '--message', 'nope', '--deadline', deadline],
        { cwd: dir },
      );
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('question');

      // Non-ISO / timezone-less deadlines are rejected client-side too (#24).
      const lax = await runCli(
        ['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--type', 'question', '--message', 'x', '--deadline', 'March 5, 2025'],
        { cwd: dir },
      );
      expect(lax.code).not.toBe(0);
      expect(lax.stderr).toContain('timezone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env-only identity never persists the token to disk (regression #25)', async () => {
    const dir = makeWorkspace();
    try {
      // No `ab init` — identity comes purely from env (the extension's flow).
      const read = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], {
        cwd: dir,
        env: { AB_AGENT_ID: 'env-agent' },
      });
      expect(read.code).toBe(0, read.stderr);

      const cfg = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      expect(cfg.token).toBeUndefined(); // never written to disk
      expect(cfg.server).toBeUndefined();
      expect(typeof cfg.cursors).toBe('object'); // cursors still persist

      // A second env-only run (file now exists) still must not leak the token.
      const again = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], {
        cwd: dir,
        env: { AB_AGENT_ID: 'env-agent' },
      });
      expect(again.code).toBe(0, again.stderr);
      const cfg2 = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      expect(cfg2.token).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('existing config keeps its stored token even when AB_TOKEN is set (regression #26)', async () => {
    const dir = makeWorkspace();
    try {
      // Deliberate config: init stores a token (explicit flag wins over env).
      const init = await runCli(['init', '--agent-id', 'file-agent', '--token', 'stored-token-123'], { cwd: dir });
      expect(init.code).toBe(0, init.stderr);
      expect(JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8')).token).toBe('stored-token-123');

      // Run commands while AB_TOKEN is present in the environment (the harness
      // always sets it) — the stored token must survive.
      const read = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
      expect(read.code).toBe(0, read.stderr);
      const after = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      expect(after.token).toBe('stored-token-123'); // not erased, env token not written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dead/requeue/purge manage the dead-letter queue (T7)', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
      await runCli(['heartbeat', '--once'], { cwd: dir });
      const sent = await runCli(['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--message', 'flaky', '--json'], { cwd: dir });
      const msg = JSON.parse(sent.stdout);

      // Fail to dead (3 failed acks).
      for (let i = 1; i <= 3; i++) {
        await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
        await runCli(['ack', '--id', msg.id, '--status', 'failed', '--error', `boom ${i}`], { cwd: dir });
      }

      const dead = await runCli(['dead', '--board', 'sprint-7'], { cwd: dir });
      expect(dead.code).toBe(0, dead.stderr);
      expect(dead.stdout).toContain(msg.id);

      // Requeue (sender) -> redeliverable.
      const requeued = await runCli(['requeue', '--id', msg.id], { cwd: dir });
      expect(requeued.code).toBe(0, requeued.stderr);
      expect(requeued.stdout).toContain('pending');
      const mail = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
      expect(mail.stdout).toContain(msg.id);

      // A non-sender cannot purge.
      const other = makeWorkspace();
      try {
        await runCli(['init', '--agent-id', 'other-1'], { cwd: other });
        const denied = await runCli(['purge', '--id', msg.id], { cwd: other });
        expect(denied.code).not.toBe(0);
        expect(denied.stderr).toContain('sender');
      } finally {
        rmSync(other, { recursive: true, force: true });
      }

      // Sender purges; message is gone.
      const purged = await runCli(['purge', '--id', msg.id], { cwd: dir });
      expect(purged.code).toBe(0, purged.stderr);
      const deadAgain = await runCli(['dead', '--board', 'sprint-7'], { cwd: dir });
      expect(deadAgain.stdout).not.toContain(msg.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('archive exports the board to markdown with one commit per thread (T5)', async () => {
    const dir = makeWorkspace();
    const archiveDir = join(dir, 'archive');
    const board = 'archive-board'; // fresh board — deterministic thread count
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', board], { cwd: dir });
      await runCli(['heartbeat', '--once', '--board', board], { cwd: dir });

      // A request thread + a response.
      const req = await runCli(['send', '--board', board, '--to', 'agent:cli-agent', '--type', 'request', '--message', 'review PR #12', '--json'], { cwd: dir });
      const reqMsg = JSON.parse(req.stdout);
      const resp = await runCli(['send', '--board', board, '--to', 'agent:cli-agent', '--type', 'response', '--reply-to', reqMsg.id, '--message', 'approved', '--json'], { cwd: dir });
      const respMsg = JSON.parse(resp.stdout);

      const run = await runCli(['archive', '--board', board, '--git', archiveDir], { cwd: dir });
      expect(run.code).toBe(0, run.stderr);
      expect(run.stdout).toContain('archived');

      // Markdown history exists and is readable.
      const threadFile = join(archiveDir, 'threads', `${reqMsg.id}.md`);
      expect(existsSync(threadFile)).toBe(true);
      const md = readFileSync(threadFile, 'utf8');
      expect(md).toContain('review PR #12');
      expect(md).toContain('approved');
      expect(md).toContain(reqMsg.id);
      expect(md).toContain(respMsg.id);
      expect(readFileSync(join(archiveDir, 'README.md'), 'utf8')).toContain(`Board ${board}`);

      // One commit per thread (request + response share one thread) + index commit.
      const log = await gitLog(archiveDir);
      expect(log.filter((m) => m.includes('thread'))).toHaveLength(1);
      expect(log.filter((m) => m.includes('index'))).toHaveLength(1);

      // Idempotent: a second run adds no commits.
      await runCli(['archive', '--board', board, '--git', archiveDir], { cwd: dir });
      expect(await gitLog(archiveDir)).toEqual(log);

      // Closing the thread (all messages terminal) produces a new commit.
      const mail = await runCli(['read', '--board', board, '--wait', '0', '--once'], { cwd: dir });
      expect(mail.stdout).toContain(reqMsg.id);
      await runCli(['ack', '--id', reqMsg.id, '--status', 'done'], { cwd: dir });
      await runCli(['ack', '--id', respMsg.id, '--status', 'done'], { cwd: dir });
      await runCli(['archive', '--board', board, '--git', archiveDir], { cwd: dir });
      const log2 = await gitLog(archiveDir);
      expect(log2.filter((m) => m.includes('closed'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('token minting binds identity: an agent cannot act as another (T6)', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir); // workspace token from the harness env
      await runCli(['heartbeat', '--once', '--board', 'sprint-7'], { cwd: dir });

      // Mint a token for qa-1 (workspace token = admin).
      const minted = await runCli(['token', '--agent-id', 'qa-1', '--json'], { cwd: dir });
      expect(minted.code).toBe(0, minted.stderr);
      const { token } = JSON.parse(minted.stdout);
      expect(token).toMatch(/^abt_/);

      // As qa-1 with its own token: heartbeat works (identity from token).
      const qaDir = makeWorkspace();
      try {
        const asQa = await runCli(['heartbeat', '--once', '--board', 'sprint-7'], {
          cwd: qaDir,
          env: { AB_AGENT_ID: 'qa-1', AB_TOKEN: token },
        });
        expect(asQa.code).toBe(0, asQa.stderr);

        // Impersonation: token of qa-1 with a different agent id -> 401.
        const impostor = await runCli(['heartbeat', '--once', '--board', 'sprint-7'], {
          cwd: qaDir,
          env: { AB_AGENT_ID: 'dev-1', AB_TOKEN: token },
        });
        expect(impostor.code).not.toBe(0);
        expect(impostor.stderr).toContain('does not match');

        // An agent token cannot mint (admin-only).
        const noMint = await runCli(['token', '--agent-id', 'dev-1'], {
          cwd: qaDir,
          env: { AB_AGENT_ID: 'qa-1', AB_TOKEN: token },
        });
        expect(noMint.code).not.toBe(0);

        // Revoke via the workspace token -> qa-1's token stops working.
        const revoked = await runCli(['token', '--agent-id', 'qa-1', '--revoke'], { cwd: dir });
        expect(revoked.code).toBe(0, revoked.stderr);
        const dead = await runCli(['heartbeat', '--once', '--board', 'sprint-7'], {
          cwd: qaDir,
          env: { AB_AGENT_ID: 'qa-1', AB_TOKEN: token },
        });
        expect(dead.code).not.toBe(0);
      } finally {
        rmSync(qaDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('true watermark: mixed ack statuses across runs never skip redelivery (T1, #12)', async () => {
    const dir = makeWorkspace();
    try {
      await initWorkspace(dir);
      await runCli(['join', '--board', 'sprint-7'], { cwd: dir });
      await runCli(['heartbeat', '--once'], { cwd: dir });

      // msg_5 arrives first; msg_6 arrives AFTER msg_5 is claimed (the #12 shape).
      const five = await runCli(['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--message', 'five', '--json'], { cwd: dir });
      const msg5 = JSON.parse(five.stdout);

      // Run 1: claim msg_5 with --ack claimed, then "crash" (process exits).
      const claim = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once', '--ack', 'claimed'], { cwd: dir });
      expect(claim.code).toBe(0, claim.stderr);
      expect(claim.stdout).toContain(msg5.id);

      // msg_6 arrives while msg_5 is still claimed (invisible to pickup).
      const six = await runCli(['send', '--board', 'sprint-7', '--to', 'agent:cli-agent', '--message', 'six', '--json'], { cwd: dir });
      const msg6 = JSON.parse(six.stdout);

      // Run 2 (restart): finalize msg_6 with --ack done. The watermark MUST NOT
      // jump past msg_5.
      const finalize = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once', '--ack', 'done'], { cwd: dir });
      expect(finalize.code).toBe(0, finalize.stderr);
      expect(finalize.stdout).toContain(msg6.id);
      const cfg = JSON.parse(readFileSync(join(dir, '.agentboard.json'), 'utf8'));
      // The watermark must NOT have passed msg_5 (earlier tests may leave other
      // claimed-but-unfinalized messages that block it even earlier — the
      // property that matters is: strictly below msg_5's seq).
      expect(cfg.cursors['sprint-7']).toBeLessThan(msg5.seq);

      // Crash window: msg_5's lease expires server-side.
      store.db
        .prepare('UPDATE messages SET lease_expires_at = ? WHERE id = ?')
        .run(Date.now() - 1, msg5.id);

      // Run 3: redelivery of msg_5 must arrive (attempts=2).
      const redelivered = await runCli(['read', '--board', 'sprint-7', '--wait', '0', '--once'], { cwd: dir });
      expect(redelivered.code).toBe(0, redelivered.stderr);
      expect(redelivered.stdout).toContain(msg5.id);
      const row = store.db.prepare('SELECT attempts FROM messages WHERE id = ?').get(msg5.id);
      expect(row.attempts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});