/**
 * `ab` CLI commands — one function per subcommand.
 * Every command accepts `json` (--json) for machine-readable stdout.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { CliError, apiCall } from './api.js';
import { CONFIG_FILE, configPath, globalConfigPath, loadConfig, parseList, saveConfig } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Loud send guard (issue #68): the board pipeline never truncates payloads.
 * A reply that arrives shorter than intended was cut BEFORE `ab` saw it
 * (observed in spawned workers' LLM-generated messages). This cap makes an
 * oversized message fail loudly instead of feeding a silent boundary, and
 * pushes workers to split long verdicts.
 */
const MAX_MESSAGE_CHARS = 4096;

function usage(msg, hint) {
  throw new CliError(msg ? `${msg}\n${hint}` : hint);
}

// ------------------------------------------------------------------ init

export async function cmdInit(flags, json) {
  const server = flags.server ?? process.env.AB_SERVER;
  const token = flags.token ?? process.env.AB_TOKEN;
  if (!server || !token) {
    usage(
      'init requires --server and --token (or AB_SERVER / AB_TOKEN env vars)',
      'ab init --server http://localhost:8080 --token <workspace-token> [--agent-id qa-1] [--roles qa,dev] [--provider opencode]\n  ab init --global --server <url> --token <t> [--agent-id qa-1] [--roles qa,dev]   machine-wide config (no per-repo re-entry)',
    );
  }
  // --global writes the machine-wide config (issue #41); the local file is
  // left untouched so a repo can still override the machine with `ab init`.
  const path = flags.global ? globalConfigPath() : configPath();
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // A plain `ab init` fills omitted identity fields from the global config —
  // local init overrides global, it does not replace it.
  const gpath = globalConfigPath();
  const globalCfg = flags.global || !existsSync(gpath) ? {} : JSON.parse(readFileSync(gpath, 'utf8'));
  const cfg = {
    server,
    token,
    agentId: flags.agentId ?? existing.agentId ?? globalCfg.agentId,
    provider: flags.provider ?? existing.provider ?? globalCfg.provider ?? null,
    roles: flags.roles !== undefined ? parseList(flags.roles) : existing.roles ?? globalCfg.roles ?? [],
    boards: existing.boards ?? [],
    cursors: existing.cursors ?? {},
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  if (json) {
    console.log(JSON.stringify({ ok: true, path, global: Boolean(flags.global), agentId: cfg.agentId, boards: cfg.boards }));
  } else {
    console.log(`initialized ${flags.global ? 'global config ' : ''}${path}`);
    console.log(`  server : ${server}`);
    console.log(`  agent  : ${cfg.agentId ?? '(set --agent-id)'}`);
    console.log(`  roles  : ${cfg.roles.join(', ') || '(none)'}`);
  }
}

// ------------------------------------------------------------------ join

export async function cmdJoin(flags, json) {
  if (flags.board === undefined) usage('join requires --board', 'ab join --board sprint-7 [--board feature-x]');
  const cfg = loadConfig();
  const added = [];
  const BOARD_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  for (const board of parseList(flags.board)) {
    if (!BOARD_RE.test(board)) usage(`invalid board name: ${board} (must match ^[a-z0-9][a-z0-9._-]{0,63}$)`);
    if (!cfg.boards.includes(board)) {
      cfg.boards.push(board);
      added.push(board);
    }
  }
  saveConfig(cfg);
  if (json) {
    console.log(JSON.stringify({ ok: true, boards: cfg.boards, added }));
  } else if (added.length === 0) {
    console.log(`already on: ${cfg.boards.join(', ')}`);
  } else {
    console.log(`joined ${added.join(', ')} — boards: ${cfg.boards.join(', ')}`);
  }
}

// ------------------------------------------------------------------ heartbeat

export async function cmdHeartbeat(flags, json) {
  const cfg = loadConfig();
  const interval = flags.interval === undefined ? 60 : Number(flags.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) {
    usage('interval must be an integer in 1..3600', 'ab heartbeat --interval 15 [--status idle|busy] [--task "review PR #12"]');
  }
  const status = flags.status ?? 'idle';
  if (status !== 'idle' && status !== 'busy') usage('status must be idle or busy');
  const once = Boolean(flags.once);

  const body = {
    agentId: cfg.agentId,
    provider: cfg.provider ?? undefined,
    roles: cfg.roles,
    capabilities: flags.capabilities !== undefined ? parseList(flags.capabilities) : undefined,
    boards: flags.board !== undefined ? parseList(flags.board) : cfg.boards,
    status,
    currentTask: flags.task ?? null,
    interval,
  };

  do {
    const data = await apiCall(cfg, 'POST', '/v1/heartbeat', { body });
    if (json) {
      console.log(JSON.stringify(data));
    } else {
      const boards = data.agent.boards.length ? data.agent.boards.join(',') : 'no boards';
      console.log(`[heartbeat] ${data.agent.agentId} ${data.agent.status} ttl=${data.presence.ttl}s boards=[${boards}]`);
    }
    if (once) return;
    await sleep(interval * 1000);
  } while (true);
}

// ------------------------------------------------------------------ send

export async function cmdSend(flags, json) {
  const cfg = loadConfig();
  const board = flags.board ?? cfg.boards[0];
  if (!board) usage('no board: pass --board or run `ab join --board <name>` first');
  if (!flags.to) usage('send requires --to', 'ab send --board sprint-7 --to role:qa --type request --message "review PR #12"');
  if (flags.message !== undefined && flags.payload !== undefined) {
    usage('use either --message or --payload, not both');
  }
  let payload;
  if (flags.payload !== undefined) {
    try {
      payload = JSON.parse(flags.payload);
    } catch {
      usage('--payload must be valid JSON');
    }
  } else if (flags.message !== undefined) {
    payload = { text: flags.message };
  } else {
    usage('send requires --message (or --payload as raw JSON)');
  }
  // Loud size guard (issue #68): the pipeline never truncates — a message
  // that comes out shorter than it went in was cut BEFORE `ab` saw it (seen
  // in spawned workers' LLM-generated replies). Reject oversized payloads so
  // a future boundary fails loudly instead of silently cutting; workers get
  // explicit split guidance.
  const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload);
  if (text.length > MAX_MESSAGE_CHARS) {
    usage(
      `message is ${text.length} chars — the send guard allows at most ${MAX_MESSAGE_CHARS} (issue #68)\n` +
        '  the board never truncates; split long replies into multiple messages, or the text was already cut before `ab` saw it',
    );
  }

  const body = {
    to: flags.to,
    type: flags.type ?? 'request',
    payload,
  };
  if (flags.priority !== undefined) body.priority = flags.priority;
  if (flags.ttl !== undefined) {
    const ttl = Number(flags.ttl);
    if (!Number.isInteger(ttl) || ttl < 0) usage('ttl must be a non-negative integer');
    body.ttl = ttl;
  }
  if (flags.deadline !== undefined) {
    // Mirror of the server's strict check (spec §3.1): ISO 8601 with timezone.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(flags.deadline) || Number.isNaN(Date.parse(flags.deadline))) {
      usage('--deadline must be ISO 8601 with an explicit timezone (e.g. 2026-09-30T12:00:00Z)');
    }
    body.deadline = flags.deadline; // questions only; server rejects on other types
  }
  if (flags.idempotencyKey !== undefined) body.idempotencyKey = flags.idempotencyKey;
  if (flags.key !== undefined) body.idempotencyKey = flags.key; // --key alias (conventions/persona)
  if (flags.replyTo !== undefined) body.replyTo = flags.replyTo;

  const data = await apiCall(cfg, 'POST', `/v1/boards/${board}/messages`, { agent: cfg.agentId, body });
  const m = data.message;
  if (json) {
    console.log(JSON.stringify(m));
  } else {
    console.log(`sent ${m.id} #${m.seq} to ${m.to} [${m.type}] (${m.state})`);
  }
}

// ------------------------------------------------------------------ read

function formatMessage(m) {
  const payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
  return `${m.id} #${m.seq} ${m.from} -> ${m.to} [${m.type}] ${payload} (${m.state}${m.replyTo ? `, replies to ${m.replyTo}` : ''})`;
}

export async function cmdRead(flags, json) {
  const cfg = loadConfig();
  const board = flags.board ?? cfg.boards[0];
  if (!board) usage('no board: pass --board or run `ab join --board <name>` first');
  const wait = flags.wait === undefined ? 30 : Number(flags.wait);
  if (!Number.isInteger(wait) || wait < 0 || wait > 60) usage('wait must be an integer in 0..60');
  const once = Boolean(flags.once);
  const ackStatus = flags.ack === undefined ? null : flags.ack;
  if (ackStatus !== null && !['claimed', 'done', 'failed'].includes(ackStatus)) usage('--ack must be claimed, done, or failed');
  if (ackStatus === 'failed' && !flags.error) usage('--ack failed requires --error');

  let cursor = flags.since !== undefined ? Number(flags.since) : (cfg.cursors[board] ?? 0);
  if (!Number.isInteger(cursor) || cursor < 0) usage('since must be a non-negative integer');
  // At-least-once: the persisted cursor is the server-computed *watermark*
  // (spec §6.2) — the highest seq below which everything is finalized-or-not-
  // ours. Claimed-but-unacked messages block it, so lease-expiry redelivery is
  // always picked up, even across crashes and mixed ack statuses (#12).
  // The in-process seen set only suppresses duplicate re-prints.
  const seen = new Set();

  do {
    const data = await apiCall(cfg, 'GET', `/v1/boards/${board}/messages?since=${cursor}&wait=${wait}`, {
      agent: cfg.agentId,
    });
    for (const m of data.messages) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        if (json) {
          console.log(JSON.stringify(m));
        } else {
          console.log(`[read] ${formatMessage(m)}`);
        }
      }
      if (ackStatus) {
        try {
          await apiCall(cfg, 'POST', `/v1/messages/${m.id}/ack`, {
            agent: cfg.agentId,
            body: { status: ackStatus, error: flags.error ?? null },
          });
          if (!json) console.log(`[ack] ${m.id} ${ackStatus}`);
        } catch (e) {
          console.error(`[ack] ${m.id} failed: ${e.message}`);
        }
      }
    }
    // Resume from the server watermark. Against an older server that does not
    // send one, keep the current cursor (conservative — never advances past
    // unverified mail).
    cursor = data.watermark ?? cursor;
    cfg.cursors[board] = cursor;
    saveConfig(cfg);
    if (once) return;
    // No-op long-poll: loop again immediately; the server holds the request.
  } while (true);
}

// ------------------------------------------------------------------ ack

export async function cmdAck(flags, json) {
  const cfg = loadConfig();
  const id = flags.id ?? flags._[0];
  if (!id) usage('ack requires --id', 'ab ack --id msg_xxx --status done');
  const status = flags.status;
  if (!['claimed', 'done', 'failed'].includes(status ?? '')) usage('--status must be claimed, done, or failed');
  if (status === 'failed' && !flags.error) usage('--status failed requires --error');

  const data = await apiCall(cfg, 'POST', `/v1/messages/${id}/ack`, {
    agent: cfg.agentId,
    body: { status, error: flags.error ?? null },
  });
  const m = data.message;
  if (json) {
    console.log(JSON.stringify(m));
  } else {
    console.log(`acked ${m.id} -> ${m.state}`);
  }
}

// ------------------------------------------------------------------ archive (v0.2.1, brief §10.3)

const ARCHIVE_STATE = '.agentboard-archive.json';

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function markdownMessage(m) {
  const payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload, null, 2);
  const meta = [
    `${m.id} · seq ${m.seq} · ${m.from} → ${m.to} · [${m.type}] · ${m.state}`,
    `posted ${m.createdAt}${m.replyTo ? ` · replies to ${m.replyTo}` : ''}${m.deadline ? ` · deadline ${m.deadline}` : ''}${m.late ? ' · late' : ''}`,
  ].join('\n\n');
  return `### ${m.id}\n\n${meta}\n\n\`\`\`json\n${payload}\n\`\`\`\n`;
}

export async function cmdArchive(flags, json) {
  const cfg = loadConfig();
  const board = flags.board ?? cfg.boards[0];
  if (!board) usage('archive requires --board', 'ab archive --board sprint-7 --git ./archive');
  const dir = flags.git ?? flags._[0];
  if (!dir) usage('archive requires --git <dir>', 'ab archive --board sprint-7 --git ./archive');

  // Read-only full-board view (identity-less observability — never claims).
  const data = await apiCall(cfg, 'GET', `/v1/boards/${board}/messages`);
  const messages = data.messages;

  // Group into threads by replyTo chains (root = no replyTo or unknown target).
  const byId = new Map(messages.map((m) => [m.id, m]));
  const roots = messages.filter((m) => !m.replyTo || !byId.has(m.replyTo));
  const threadOf = new Map();
  for (const m of messages) {
    let cur = m;
    const seen = new Set();
    while (cur.replyTo && byId.has(cur.replyTo) && !seen.has(cur.replyTo)) {
      seen.add(cur.replyTo);
      cur = byId.get(cur.replyTo);
    }
    threadOf.set(m.id, cur.id);
  }
  const threadMessages = new Map();
  for (const m of messages) {
    const rootId = threadOf.get(m.id);
    if (!threadMessages.has(rootId)) threadMessages.set(rootId, []);
    threadMessages.get(rootId).push(m);
  }

  mkdirSync(resolve(dir, 'threads'), { recursive: true });
  const statePath = resolve(dir, ARCHIVE_STATE);
  let state = {};
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      /* fresh state */
    }
  }
  if (!gitSafe(dir)) git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'agentboard@localhost']);
  git(dir, ['config', 'user.name', 'AgentBoard Archive']);

  const committed = [];
  const rootsSorted = [...threadMessages.keys()].sort();
  // Index file.
  const index = [
    `# Board ${board} — archive`,
    '',
    `${messages.length} messages · ${threadMessages.size} threads`,
    '',
    ...rootsSorted.map((rootId, i) => `${i + 1}. [${rootId}](${encodeURIComponent(`${rootId}.md`)}) — ${threadMessages.get(rootId).length} message(s)`),
    '',
  ].join('\n');
  writeFileSync(resolve(dir, 'README.md'), index);

  for (const rootId of rootsSorted) {
    const msgs = threadMessages.get(rootId).sort((a, b) => a.seq - b.seq);
    const closed = msgs.every((m) => ['done', 'dead', 'expired'].includes(m.state));
    const body = [
      `# Thread ${rootId}`,
      '',
      `Status: ${closed ? 'closed' : 'open'} · ${msgs.length} message(s)`,
      '',
      ...msgs.map(markdownMessage),
    ].join('\n');
    const file = resolve(dir, 'threads', `${rootId}.md`);
    writeFileSync(file, body);

    // Commit only when the thread's content changed (one commit per thread).
    const prev = state.threads?.[rootId]?.hash;
    const hash = hashOf(body);
    if (prev !== hash) {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', `board ${board}: thread ${rootId}${closed ? ' (closed)' : ''}`]);
      committed.push(rootId);
    }
    state.threads = state.threads ?? {};
    state.threads[rootId] = { hash, closed };
  }
  state.board = board;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  try {
    git(dir, ['add', '-A']); // state file + index
    git(dir, ['commit', '-q', '-m', `board ${board}: archive index`]);
  } catch {
    /* nothing changed — fine */
  }

  if (json) {
    console.log(JSON.stringify({ board, dir, threads: threadMessages.size, committed, messages: messages.length }));
  } else if (committed.length === 0) {
    console.log(`archive up to date: ${threadMessages.size} thread(s) on ${board}`);
  } else {
    console.log(`archived ${committed.length} thread(s) of ${threadMessages.size} on ${board} → ${dir}`);
  }
}

function gitSafe(dir) {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

function hashOf(s) {
  return execFileSync('git', ['hash-object', '--stdin'], { input: s, encoding: 'utf8' }).trim();
}

export async function cmdWhoami(flags, json) {
  const cfg = loadConfig(process.cwd(), { requireFile: false });
  const sourceText = {
    env: 'env (AB_SERVER / AB_TOKEN / AB_AGENT_ID)',
    local: cfg.path,
    global: `global ${cfg.globalPath}`,
    none: 'none',
  }[cfg.source] ?? 'none';
  const info = {
    agentId: cfg.agentId,
    roles: cfg.roles,
    boards: cfg.boards,
    provider: cfg.provider,
    server: cfg.server,
    source: cfg.source,
    configFile: existsSync(cfg.path),
    env: {
      server: process.env.AB_SERVER !== undefined,
      token: process.env.AB_TOKEN !== undefined,
      agentId: process.env.AB_AGENT_ID !== undefined,
      roles: process.env.AB_ROLES !== undefined,
    },
  };
  if (json) {
    console.log(JSON.stringify(info));
  } else {
    console.log(`agent   : ${info.agentId ?? '(unset)'}`);
    console.log(`roles   : ${info.roles.join(', ') || '(none)'}`);
    console.log(`boards  : ${info.boards.join(', ') || '(none)'}`);
    console.log(`provider: ${info.provider ?? '(unset)'}`);
    console.log(`server  : ${info.server ?? '(unset)'}`);
    console.log(`source  : ${cfg.source}`);
    console.log(`config  : ${sourceText}`);
    console.log(`env     : server=${info.env.server} token=${info.env.token} agentId=${info.env.agentId} roles=${info.env.roles}`);
  }
}

export async function cmdToken(flags, json) {
  const cfg = loadConfig();
  const agentId = flags.agentId ?? flags._[0];
  if (!agentId) usage('token requires --agent-id', 'ab token --agent-id qa-1 [--ttl-days <n>] [--rotate] [--revoke]   (needs the workspace token; admin-only)');
  if (flags.revoke) {
    await apiCall(cfg, 'DELETE', `/v1/tokens/${agentId}`, { agent: cfg.agentId });
    if (json) {
      console.log(JSON.stringify({ ok: true, revoked: agentId }));
    } else {
      console.log(`revoked token for ${agentId}`);
    }
    return;
  }
  // ttlDays = per-token expiry (sprint 5 T5). --rotate is explicit intent:
  // minting already atomically replaces the stored hash, so the previous
  // token dies the moment this one is minted.
  const body = { agentId };
  if (flags.ttlDays !== undefined) {
    const ttl = Number(flags.ttlDays);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3650) usage('--ttl-days must be an integer in 1..3650');
    body.ttlDays = ttl;
  }
  const data = await apiCall(cfg, 'POST', '/v1/tokens', { body });
  if (json) {
    console.log(JSON.stringify(data));
  } else {
    console.log(`token for ${agentId}: ${data.token}`);
    if (data.expiresAt) console.log(`expires : ${data.expiresAt}`);
    console.log('store it now — it is only shown once. Use it as AB_TOKEN (or ab init --token).');
    if (flags.rotate) console.log('rotated: the previous token is invalid immediately.');
  }
}

export async function cmdDead(flags, json) {
  const cfg = loadConfig();
  const board = flags.board ?? cfg.boards[0];
  if (!board) usage('dead requires --board (or join a board first)');
  const data = await apiCall(cfg, 'GET', `/v1/boards/${board}/messages?status=dead`, { agent: cfg.agentId });
  if (json) {
    for (const m of data.messages) console.log(JSON.stringify(m));
  } else if (data.messages.length === 0) {
    console.log(`no dead messages on ${board}`);
  } else {
    for (const m of data.messages) console.log(`[dead] ${formatMessage(m)}`);
  }
}

export async function cmdRequeue(flags, json) {
  const cfg = loadConfig();
  const id = flags.id ?? flags._[0];
  if (!id) usage('requeue requires --id', 'ab requeue --id msg_xxx');
  const data = await apiCall(cfg, 'POST', `/v1/messages/${id}/requeue`, { agent: cfg.agentId });
  const m = data.message;
  if (json) {
    console.log(JSON.stringify(m));
  } else {
    console.log(`requeued ${m.id} -> ${m.state} (attempts reset)`);
  }
}

export async function cmdPurge(flags, json) {
  const cfg = loadConfig();
  const id = flags.id ?? flags._[0];
  if (!id) usage('purge requires --id', 'ab purge --id msg_xxx');
  await apiCall(cfg, 'DELETE', `/v1/messages/${id}`, { agent: cfg.agentId });
  if (json) {
    console.log(JSON.stringify({ ok: true, deleted: id }));
  } else {
    console.log(`purged ${id}`);
  }
}

// ------------------------------------------------------------------ agents (issue #42 part 1)

export async function cmdAgents(flags, json) {
  const cfg = loadConfig();
  const qs = [];
  if (flags.board !== undefined) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(flags.board)) usage(`invalid board name: ${flags.board} (must match ^[a-z0-9][a-z0-9._-]{0,63}$)`);
    qs.push(`board=${encodeURIComponent(flags.board)}`);
  }
  if (flags.role !== undefined) {
    if (flags.role.length === 0 || flags.role.length > 64) usage('--role must be 1..64 characters');
    qs.push(`role=${encodeURIComponent(flags.role)}`);
  }
  if (flags.status !== undefined) {
    if (!['idle', 'busy'].includes(flags.status)) usage('--status must be idle or busy');
    qs.push(`status=${flags.status}`);
  }

  const data = await apiCall(cfg, 'GET', `/v1/agents${qs.length ? `?${qs.join('&')}` : ''}`, { agent: cfg.agentId });
  if (json) {
    console.log(JSON.stringify(data));
  } else if (data.agents.length === 0) {
    console.log('no agents found');
  } else {
    for (const a of data.agents) {
      const roles = a.roles?.length ? a.roles.join(',') : '-';
      const boards = a.boards?.length ? a.boards.join(',') : '-';
      const task = a.currentTask ? ` task="${a.currentTask}"` : '';
      console.log(`${a.agentId} [${a.presence}] ${a.status ?? 'idle'} roles=[${roles}] boards=[${boards}]${task}`);
    }
  }
}

// ------------------------------------------------------------------ spawn (issue #42 part 2)

export const SPAWN_DEFAULT_AGENT = 'board-worker';
export const SPAWN_DEFAULT_MODEL = 'opencode-go/deepseek-v4-flash';
const SPAWN_OPPENCODE_TIER = 'opencode';

/**
 * Random hex suffix for default child agentIds (`<role>-<3-hex>`):
 * 3 random bytes → 6 hex chars, e.g. `qa-3f9a2c`.
 */
function randomHex(bytes = 3) {
  let s = '';
  for (let i = 0; i < bytes; i += 1) {
    s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return s;
}

/** Display quoting for a printed command line (dry-run output only). */
function shellQuote(s) {
  return /[\s"^&|<>]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

/** cmd.exe quoting for the ACTUAL spawned command line (Windows shim path). */
function cmdQuote(s) {
  const str = String(s);
  // Wrap when the arg contains whitespace or cmd metacharacters so the message
  // survives as ONE argv entry (a split message with embedded --flags broke
  // opencode's yargs parsing in the live test).
  return /[\s"&|<>^%]/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
}

/**
 * Launch the opencode worker. Windows ships `opencode` as a .cmd shim, which
 * CreateProcess cannot exec directly — run it through cmd.exe. Explicitly
 * passing /d /s /c avoids Node's DEP0190 shell:true warning and lets us quote
 * the args ourselves (shell:true merely concatenates, which is the bug the
 * live test caught). POSIX: plain exec of the `opencode` binary.
 */
function spawnWorker(args, env) {
  if (process.platform === 'win32') {
    const cmdline = ['opencode', ...args.map(cmdQuote)].join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdline], { env, stdio: 'inherit' });
  }
  return spawn('opencode', args, { env, stdio: 'inherit' });
}

/** Synchronous `opencode` invocation (pre-flight). Same .cmd-shim handling. */
function execOpencode(args, opts = {}) {
  if (process.platform === 'win32') {
    const cmdline = ['opencode', ...args.map(cmdQuote)].join(' ');
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmdline], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      ...opts,
    });
  }
  return execFileSync('opencode', args, { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], ...opts });
}

/**
 * `ab spawn <role> [--board <b>] [--count <n>] [--brief <text>|-f <file>]
 *            [--agent-id <id>] [--dry-run]`
 * Spawns transient board workers per tier preference:
 *   - opencode (default): headless `opencode run --agent board-worker`
 *     (pre-flights `opencode --version`, surfaces stderr on failure).
 *   - vs-code (and any other tier): cannot be spawned headlessly — prints the
 *     human-invoked fallback (`/ab join <board> as <role>`) instead of failing.
 * Tier: `AB_SPAWN_TIER` env > config `spawn.tier` > default `opencode`.
 * Model/agent: `AB_SPAWN_MODEL`/`AB_SPAWN_AGENT` env > config `spawn.model`/`spawn.agent`.
 * Child env carries AB_SERVER/AB_TOKEN/AB_AGENT_ID/AB_ROLES from the spawner
 * config so the worker session heartbeats as the spawned identity.
 */
/**
 * Spawn worktree plumbing (issue #78 — one writer per checkout).
 * A spawned dev/qa worker gets a fresh branch (`spawn/<agentId>`) on a temp
 * worktree, so it never shares a checkout with the human or another worker.
 */
export function spawnWorktreePlan(repoDir, agentId) {
  return {
    branch: `spawn/${agentId}`,
    path: join(tmpdir(), 'ab-worktrees', `${basename(repoDir)}-${agentId}`),
  };
}

/** Create the branch + worktree (real git side effect; used by spawn + tests). */
export function createSpawnWorktree(repoDir, agentId) {
  const { branch, path } = spawnWorktreePlan(repoDir, agentId);
  mkdirSync(dirname(path), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, path, 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { branch, path };
}

/** Install dependencies in a fresh worktree (npm ci when a lockfile exists). */
export function installWorktree(path) {
  if (!existsSync(join(path, 'package-lock.json'))) {
    return { installed: false, reason: 'no package-lock.json — install dependencies manually if needed' };
  }
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --no-audit --no-fund'], { cwd: path, stdio: 'inherit' });
  } else {
    execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path, stdio: 'inherit' });
  }
  return { installed: true };
}

export async function cmdSpawn(flags, json) {
  const cfg = loadConfig();

  const role = flags.role ?? flags._[0];
  if (!role) usage('spawn requires a role', 'ab spawn qa --board sprint-8 [--count 2] [--brief "review PR #12"] [-f brief.md] [--dry-run]');
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(role)) usage(`invalid role: ${role} (must match ^[a-z][a-z0-9._-]{0,63}$)`);

  const board = flags.board ?? cfg.boards[0];
  if (!board) usage('no board: pass --board or run `ab join --board <name>` first');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(board)) usage(`invalid board name: ${board} (must match ^[a-z0-9][a-z0-9._-]{0,63}$)`);

  const count = flags.count === undefined ? 1 : Number(flags.count);
  if (!Number.isInteger(count) || count < 1 || count > 20) usage('--count must be an integer in 1..20');

  // OpenCode's `--file` is a yargs *array* option — it consumes every token
  // after it, so the message must come BEFORE `-f` (demo finding, issue #42).
  const file = flags.file ?? flags.f;
  if (file !== undefined && !existsSync(file)) usage(`brief file not found: ${file}`);

  const tier = String(process.env.AB_SPAWN_TIER ?? cfg.spawn?.tier ?? SPAWN_OPPENCODE_TIER).toLowerCase();

  // Unsupported tier (incl. vs-code): print the human-invoked fallback instead
  // of failing — the mailbox keeps pending requests until a human worker joins.
  if (tier !== SPAWN_OPPENCODE_TIER) {
    const instructions = [
      `ab spawn: tier "${tier}" cannot be spawned headlessly.`,
      `start a worker manually:`,
      `  1. open a VS Code chat in ${process.cwd()}`,
      `  2. run: /ab join ${board} as ${role}`,
      `  3. the worker heartbeats, claims role:${role} requests, replies, and exits.`,
    ].join('\n');
    if (json) {
      console.log(JSON.stringify({ tier, humanFallback: true, role, board, instructions }));
    } else {
      console.log(instructions);
    }
    return;
  }

  const model = process.env.AB_SPAWN_MODEL ?? cfg.spawn?.model ?? SPAWN_DEFAULT_MODEL;
  const agent = process.env.AB_SPAWN_AGENT ?? cfg.spawn?.agent ?? SPAWN_DEFAULT_AGENT;
  const message = flags.brief ?? (
    file !== undefined
      ? `Execute the attached brief. Board ${board}, role ${role}.`
      : `Board ${board}, role ${role}: join the board, pick up a pending request for role:${role}, do the work, ack done, reply to the sender, then heartbeat idle and exit. Reply IN FULL — the board never truncates messages; if your verdict is long, send it complete in one --message (up to 4096 chars), never a summary.`
  );

  // Pre-flight: verify the opencode binary is reachable before shelling out
// (surfaces stderr on failure, e.g. a missing install or broken auth setup).
  if (!flags.dryRun) {
    try {
      execOpencode(['--version']);
    } catch (e) {
      const stderr = String(e?.stderr ?? e?.message ?? '').trim();
      throw new CliError(
        `opencode pre-flight failed${stderr ? `: ${stderr}` : ' (opencode not found on PATH)'}\n` +
        '  fix: install opencode and configure a provider token that supports non-interactive runs (opencode auth login), or set AB_SPAWN_TIER=vs-code for a human-invoked worker.',
      );
    }
  }

  const spawned = [];
  const commands = [];
  // One writer per checkout (#78): dev/qa workers default to their own
  // worktree; other roles (read-only/coordination) do not.
  const useWorktree = flags.worktree === true ? true : flags.noWorktree ? false : role === 'dev' || role === 'qa';
  for (let i = 0; i < count; i += 1) {
    const agentId = (flags.agentId ?? `${role}-${randomHex()}`) + (i > 0 ? `-${i + 1}` : '');
    let workdir = process.cwd();
    let wt = null;
    if (useWorktree) {
      const plan = spawnWorktreePlan(process.cwd(), agentId);
      if (flags.dryRun) {
        commands.push(`git worktree add -b ${plan.branch} "${plan.path}" HEAD`);
        if (existsSync(join(process.cwd(), 'package-lock.json'))) commands.push(`npm ci   # in "${plan.path}"`);
        workdir = plan.path;
      } else {
        wt = createSpawnWorktree(process.cwd(), agentId);
        workdir = wt.path;
        const inst = installWorktree(wt.path);
        if (!inst.installed) process.stderr.write(`spawn: ${wt.path}: ${inst.reason}\n`);
      }
    }
    // Message first, `-f` last (yargs array option consumes trailing tokens).
    const args = ['run', '--agent', agent, '--model', model, message, '--dir', workdir];
    // Absolute brief path in worktree mode (the worker's cwd differs from the
    // spawner's); the user's path as typed otherwise.
    if (file !== undefined) args.push('-f', useWorktree ? resolve(file) : file);
    const cmdline = ['opencode', ...args.map(shellQuote)].join(' ');

    if (flags.dryRun) {
      commands.push(cmdline);
      continue;
    }

    const childEnv = {
      ...process.env,
      AB_SERVER: cfg.server,
      AB_TOKEN: cfg.token,
      AB_AGENT_ID: agentId,
      AB_ROLES: role,
    };
    const child = spawnWorker(args, childEnv);
    child.on('error', (err) => {
      process.stderr.write(`error: failed to spawn worker ${agentId}: ${err.message}\n`);
    });
    child.unref(); // fire-and-forget: the worker heartbeats on its own
    spawned.push({ agentId, pid: child.pid, command: cmdline, ...(wt ? { worktree: wt.path, branch: wt.branch } : {}) });
  }

  if (json) {
    console.log(JSON.stringify({ tier, dryRun: Boolean(flags.dryRun), role, board, model, agent, worktree: useWorktree, spawned, commands }));
  } else if (flags.dryRun) {
    for (const c of commands) console.log(c);
    console.log(`spawn dry run: ${count} worker(s) for role:${role} on ${board} — nothing executed${useWorktree ? ' (worktrees planned)' : ''}`);
  } else {
    for (const s of spawned) {
      console.log(`spawned ${s.agentId} (opencode pid=${s.pid}) on ${board} as role:${role}`);
      if (s.worktree) {
        console.log(`  worktree: ${s.worktree} (branch ${s.branch})`);
        console.log(`  cleanup:  git worktree remove "${s.worktree}"   # after the worker exits; prune leftovers with \`git worktree prune\``);
      }
    }
  }
}