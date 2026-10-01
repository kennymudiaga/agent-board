/**
 * `ab watch` — wake-on-mail daemon (sprint 5 T1, design docs/wake-on-mail.md).
 *
 * The board is the promise; `ab watch` is the await. It watches a board for
 * mail addressed to an identity and fires a configured wake action:
 *
 *   --exec <cmd>          spawn a command on arrival (spawn-on-arrival, e.g.
 *                         `opencode run ...` — dogfoods `ab spawn`). The
 *                         message is passed via AB_WATCH_* env vars ONLY —
 *                         never shell-interpolated into the command.
 *   --opencode <session>  POST prompt_async to the local opencode server
 *                         (wake a live session; best-effort, T2 spike verifies).
 *   --notify              OS notification (osascript / notify-send / message box).
 *
 * Semantics:
 *   - Read-only observability view: NEVER claims, NEVER acks on the agent's
 *     behalf — the woken agent owns its mail (claiming would break pickup).
 *   - Push via the dashboard SSE stream (workspace token); polling fallback
 *     (--interval) when the token is agent-scoped.
 *   - Dedupes on message id; starts from the current head (no backlog firing)
 *     unless --since is given; --once exits after the first action.
 *   - Wake-loop guard: the watched identity's own messages never fire.
 */
import { spawn } from 'node:child_process';
import { CliError, apiCall } from './api.js';
import { loadConfig } from './config.js';

const OPENCODE_SERVER = process.env.AB_OPENCODE_SERVER ?? 'http://127.0.0.1:4096';

function usage(msg, hint) {
  throw new CliError(msg ? `${msg}\n${hint}` : hint);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Message env brief for actions (the only channel for message data — no shell interpolation). */
function actionEnv(m) {
  return {
    AB_WATCH_BOARD: m.board,
    AB_WATCH_MESSAGE_ID: m.id,
    AB_WATCH_SEQ: String(m.seq),
    AB_WATCH_FROM: m.from,
    AB_WATCH_TO: m.to,
    AB_WATCH_TYPE: m.type,
    AB_WATCH_REPLY_TO: m.replyTo ?? '',
    AB_WATCH_TEXT: m.payload && typeof m.payload.text === 'string' ? m.payload.text : JSON.stringify(m.payload ?? null),
  };
}

/** Wake-loop guard + filter: agent:/role: mail to the watched identity, never its own. */
function addressedTo(m, forId, roles) {
  if (m.from === forId) return false;
  if (m.to === `agent:${forId}`) return true;
  return m.to.startsWith('role:') && roles.includes(m.to.slice('role:'.length));
}

function notify(env) {
  const title = 'AgentBoard';
  const text = `board ${env.AB_WATCH_BOARD}: ${env.AB_WATCH_FROM} → ${env.AB_WATCH_TO} — ${env.AB_WATCH_TEXT.slice(0, 120)}`;
  try {
    if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      spawn('notify-send', [title, text], { stdio: 'ignore' });
    } else {
      spawn('powershell', ['-NoProfile', '-Command', `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show(${JSON.stringify(text)}, ${JSON.stringify(title)})`], { stdio: 'ignore' });
    }
  } catch {
    /* best-effort notification */
  }
}

async function runActions(m, flags) {
  const env = { ...process.env, ...actionEnv(m) };
  if (flags.exec !== undefined) {
    // Explicit opt-in command; message data travels via env only. shell:true
    // is the user's own command line — never interpolated with message text.
    const child = spawn(flags.exec, { env, shell: true, stdio: 'inherit' });
    child.on('error', (e) => process.stderr.write(`[watch] --exec failed: ${e.message}\n`));
  }
  if (flags.opencode !== undefined) {
    const url = `${OPENCODE_SERVER}/session/${encodeURIComponent(String(flags.opencode))}/prompt_async`;
    const text = `[agentboard wake] message ${m.id} on ${m.board} from ${m.from}${m.replyTo ? ` (re: ${m.replyTo})` : ''}: ${env.AB_WATCH_TEXT}`;
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch((e) => process.stderr.write(`[watch] --opencode failed: ${e.message}\n`));
  }
  if (flags.notify) notify(env);
}

export async function cmdWatch(flags, json) {
  const cfg = loadConfig();
  const board = flags.board ?? cfg.boards[0];
  if (!board) usage('watch requires --board (or join a board first)', 'ab watch --board sprint-8 [--for qa-1] [--exec <cmd>] [--opencode <session-id>] [--notify] [--once]');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(board)) usage(`invalid board name: ${board}`);
  const forId = flags.for ?? cfg.agentId;
  if (!forId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(forId)) usage(`invalid --for agent id: ${forId}`);
  if (flags.exec === undefined && flags.opencode === undefined && !flags.notify) {
    usage('watch requires at least one action: --exec <cmd>, --opencode <session-id>, or --notify');
  }
  const interval = flags.interval === undefined ? 5 : Number(flags.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) usage('--interval must be an integer in 1..3600');
  let since = flags.since === undefined ? 0 : Number(flags.since);
  if (!Number.isInteger(since) || since < 0) usage('--since must be a non-negative integer');
  const once = Boolean(flags.once);

  // Watched identity's roles (for role: matching), from the directory.
  let roles = [];
  try {
    const dir = await apiCall(cfg, 'GET', '/v1/agents', {});
    const me = (dir.agents ?? []).find((a) => a.agentId === forId);
    roles = me?.roles ?? [];
  } catch {
    /* directory unreachable — agent:<id> mail still matches */
  }

  let head = since;
  let primed = since > 0; // default: first refresh primes the head, fires nothing
  let fired = 0;
  const seen = new Set();

  const refresh = async () => {
    const data = await apiCall(cfg, 'GET', `/v1/boards/${board}/messages?since=${head}`, {});
    for (const m of data.messages ?? []) {
      if (m.seq <= head || seen.has(m.id)) continue;
      seen.add(m.id);
      if (primed && addressedTo(m, forId, roles)) {
        if (!json) console.log(`[watch] ${m.id} #${m.seq} ${m.from} -> ${m.to} [${m.type}]`);
        await runActions(m, flags);
        fired += 1;
      }
    }
    if (typeof data.cursor === 'number' && data.cursor > head) head = data.cursor;
    primed = true;
    return fired;
  };

  const onceDone = () => once && fired > 0;

  // Prime the head (default: pre-existing mail never fires; with --since the
  // first refresh fires for everything above it).
  try {
    await refresh();
  } catch (e) {
    throw new CliError(`cannot reach server at ${cfg.server} (${e.message})`);
  }

  // Push path: dashboard SSE stream (workspace token; 'message' events on new
  // mail). Falls back to polling when the token is rejected.
  const abort = new AbortController();
  let mode = 'poll';
  try {
    const streamUrl = `${cfg.server}/v1/events?board=${encodeURIComponent(board)}&token=${encodeURIComponent(cfg.token)}`;
    const res = await fetch(streamUrl, { signal: abort.signal });
    if (res.ok && res.body) {
      mode = 'sse';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.split('\n').some((l) => l.startsWith('event: message'))) {
            await refresh().catch((e) => process.stderr.write(`[watch] refresh failed: ${e.message}\n`));
            if (onceDone()) abort.abort();
          }
        }
      }
    }
  } catch {
    /* stream ended or rejected — poll fallback below */
  }

  // Poll fallback (agent-scoped token, stream hiccup, or --once exit).
  if (mode === 'poll' && !onceDone()) {
    if (!json) console.log(`[watch] polling ${board} every ${interval}s (no SSE stream)`);
    while (!onceDone()) {
      await sleep(interval * 1000);
      try {
        await refresh();
      } catch (e) {
        process.stderr.write(`[watch] refresh failed: ${e.message}\n`);
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ board, forId, mode, fired }));
  }
}