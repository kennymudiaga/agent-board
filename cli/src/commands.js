/**
 * `ab` CLI commands — one function per subcommand.
 * Every command accepts `json` (--json) for machine-readable stdout.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CliError, apiCall } from './api.js';
import { CONFIG_FILE, configPath, loadConfig, parseList, saveConfig } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage(msg, hint) {
  throw new CliError(msg ? `${msg}\n${hint}` : hint);
}

// ------------------------------------------------------------------ init

export async function cmdInit(flags, json) {
  const server = flags.server ?? process.env.AB_SERVER;
  const token = flags.token ?? process.env.AB_TOKEN;
  if (!server || !token) {
    usage('init requires --server and --token (or AB_SERVER / AB_TOKEN env vars)', 'ab init --server http://localhost:8080 --token <workspace-token> [--agent-id qa-1] [--roles qa,dev] [--provider opencode]');
  }
  const path = configPath();
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const cfg = {
    server,
    token,
    agentId: flags.agentId ?? existing.agentId,
    provider: flags.provider ?? existing.provider ?? null,
    roles: flags.roles !== undefined ? parseList(flags.roles) : existing.roles ?? [],
    boards: existing.boards ?? [],
    cursors: existing.cursors ?? {},
  };
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  if (json) {
    console.log(JSON.stringify({ ok: true, path, agentId: cfg.agentId, boards: cfg.boards }));
  } else {
    console.log(`initialized ${path}`);
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

// ------------------------------------------------------------------ dead / requeue / purge (v0.2 §5.7)

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