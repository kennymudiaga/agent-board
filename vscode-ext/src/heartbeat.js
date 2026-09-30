/**
 * Thin `ab` CLI invocation helpers — vscode-free, testable. The CLI is the
 * client; the extension never reimplements the protocol. Identity comes from
 * env vars (AB_SERVER/AB_TOKEN/AB_AGENT_ID), so no `.agentboard.json` is
 * needed (see cli/src/config.js env-only support). (CommonJS.)
 */
const { execFile } = require('node:child_process');

const AB = process.platform === 'win32' ? 'ab.cmd' : 'ab';

function findAb() {
  return new Promise((resolve) => {
    execFile(AB, ['--version'], (err) => resolve(err ? null : AB));
  });
}

function runAb(args, env) {
  return new Promise((resolve) => {
    execFile(
      AB,
      args,
      {
        env: { ...process.env, AB_SERVER: env.server, AB_TOKEN: env.token, AB_AGENT_ID: env.agentId },
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

async function abHeartbeat({ server, token, agentId, board, interval }) {
  const args = ['heartbeat', '--interval', String(interval), '--once', '--json'];
  if (board) args.push('--board', board);
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