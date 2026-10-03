/**
 * Thin `ab` CLI invocation helpers — vscode-free, testable. The CLI is the
 * client; the extension never reimplements the protocol. Identity comes from
 * env vars (AB_SERVER/AB_TOKEN/AB_AGENT_ID), so no `.agentboard.json` is
 * needed (see cli/src/config.js env-only support). (CommonJS.)
 *
 * Windows note: npm shims are `.cmd` files — execFile cannot launch them
 * directly (EINVAL), so we run through the shell on win32.
 */
const { execFile } = require('node:child_process');

const AB = process.platform === 'win32' ? 'ab.cmd' : 'ab';
const SHELL = process.platform === 'win32';

function findAb() {
  return new Promise((resolve) => {
    execFile(AB, ['--version'], { shell: SHELL }, (err) => resolve(err ? null : AB));
  });
}

function runAb(args, env) {
  return new Promise((resolve) => {
    execFile(
      AB,
      args,
      {
        env: { ...process.env, AB_SERVER: env.server, AB_TOKEN: env.token, AB_AGENT_ID: env.agentId },
        shell: SHELL,
        timeout: 15_000,
      },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, error: (err.message || '').split('\n')[0] });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(stdout) });
        } catch {
          resolve({ ok: true, data: { raw: stdout } });
        }
      },
    );
  });
}

async function abHeartbeat({ server, token, agentId, board, interval, capabilities }) {
  const args = ['heartbeat', '--interval', String(interval), '--once', '--json'];
  if (board) args.push('--board', board);
  if (capabilities?.length) args.push('--capabilities', capabilities.join(','));
  return runAb(args, { server, token, agentId });
}

async function abSendNote({ server, token, agentId, board, text }) {
  return runAb(['send', '--board', board, '--to', 'broadcast', '--type', 'note', '--message', text, '--json'], {
    server,
    token,
    agentId,
  });
}

module.exports = { findAb, abHeartbeat, abSendNote };