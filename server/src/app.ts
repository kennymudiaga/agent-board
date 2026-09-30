import { EventEmitter } from 'node:events';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  Store,
  ID_RE,
  MSG_TYPES,
  PRIORITIES,
  MSG_STATES,
  AGENT_STATUSES,
  DEFAULT_INTERVAL,
  type AckStatus,
  type AgentStatus,
  type MessageRecord,
  type MsgState,
  type MsgType,
  type Priority,
} from './db.js';
import { DASHBOARD_HTML } from './dashboard.js';

/**
 * AgentBoard reference server — Hono app implementing `docs/spec.md` v0.1.
 * `createApp` takes a Store and returns a framework-agnostic app (testable
 * via `app.request(...)` or servable via `@hono/node-server`).
 */

const MAX_WAIT = 60; // seconds, long-poll cap per spec
const BOARD_ID_RE = ID_RE;

export interface AppOptions {
  /** Workspace bearer token. Defaults to AB_TOKEN env, then 'dev-token'. */
  token?: string;
}

type Variables = { agentId: string };

function error(c: Context, status: ContentfulStatusCode, code: string, message: string, extra?: Record<string, unknown>) {
  return c.json({ error: { code, message, ...extra } }, status);
}

async function readJsonObject(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const v = (await c.req.json()) as unknown;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function isStringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length <= 64);
}

function parseTo(raw: unknown): { kind: 'agent' | 'role' | 'broadcast'; value: string | null } | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw === 'broadcast') return { kind: 'broadcast', value: null };
  const m = /^(agent|role):(.+)$/.exec(raw);
  if (!m) return undefined;
  const kind = m[1] as 'agent' | 'role';
  const value = m[2];
  if (value.length === 0 || value.length > 64) return undefined;
  if (kind === 'agent' && !ID_RE.test(value)) return undefined;
  return { kind, value };
}

export function createApp(store: Store, opts: AppOptions = {}): Hono<{ Variables: Variables }> {
  const token = opts.token ?? process.env.AB_TOKEN ?? 'dev-token';
  const mailbox = new EventEmitter(); // wakes long-pollers on new messages
  const agentMailbox = new EventEmitter(); // notifies dashboards of heartbeats

  const app = new Hono<{ Variables: Variables }>();

  // --- middleware: auth + identity -----------------------------------------

  app.use('/v1/*', async (c, next) => {
    // /v1/events authenticates via query param (SSE cannot set headers) in its own route.
    if (c.req.path === '/v1/events') return next();
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${token}`) {
      return error(c, 401, 'unauthorized', 'missing or invalid bearer token');
    }
    await next();
  });

  app.use('/v1/*', async (c, next) => {
    // heartbeat declares its identity in the body; the dashboard stream has none.
    if (c.req.path === '/v1/heartbeat' || c.req.path === '/v1/events') return next();
    const agentId = c.req.header('X-Agent-ID');
    if (agentId !== undefined) {
      if (!ID_RE.test(agentId)) return error(c, 422, 'unprocessable', 'invalid X-Agent-ID');
      c.set('agentId', agentId);
      return next();
    }
    // No identity: read-only GETs are open to dashboards (spec §4 — they never
    // claim or mutate); anything that mutates requires an identity.
    if (c.req.method === 'GET') return next();
    return error(c, 401, 'unauthorized', 'missing X-Agent-ID header');
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Read-only dashboard (T6 stretch): static shell, no auth (it carries no data).
  app.get('/', (c) => c.html(DASHBOARD_HTML));

  // --- POST /v1/heartbeat ---------------------------------------------------

  app.post('/v1/heartbeat', async (c) => {
    const body = await readJsonObject(c);
    if (!body) return error(c, 400, 'bad_request', 'body must be a JSON object');

    const agentId = body.agentId;
    if (typeof agentId !== 'string' || !ID_RE.test(agentId)) {
      return error(c, 422, 'unprocessable', 'invalid agentId');
    }
    const status = body.status ?? 'idle';
    if (!AGENT_STATUSES.includes(status as AgentStatus)) {
      return error(c, 422, 'unprocessable', `status must be one of: ${AGENT_STATUSES.join(', ')}`);
    }
    let interval = DEFAULT_INTERVAL;
    if (body.interval !== undefined) {
      if (!Number.isInteger(body.interval) || (body.interval as number) < 1 || (body.interval as number) > 3600) {
        return error(c, 422, 'unprocessable', 'interval must be an integer in 1..3600');
      }
      interval = body.interval as number;
    }
    if (body.roles !== undefined && !isStringList(body.roles)) {
      return error(c, 422, 'unprocessable', 'roles must be an array of strings');
    }
    if (body.capabilities !== undefined && !isStringList(body.capabilities)) {
      return error(c, 422, 'unprocessable', 'capabilities must be an array of strings');
    }
    if (body.boards !== undefined && !isStringList(body.boards)) {
      return error(c, 422, 'unprocessable', 'boards must be an array of strings');
    }
    if (body.boards !== undefined && (body.boards as string[]).some((b) => !ID_RE.test(b))) {
      return error(c, 422, 'unprocessable', 'boards must match ^[a-z0-9][a-z0-9._-]{0,63}$');
    }
    if (body.provider !== undefined && typeof body.provider !== 'string') {
      return error(c, 422, 'unprocessable', 'provider must be a string');
    }
    if (body.currentTask !== undefined && body.currentTask !== null && typeof body.currentTask !== 'string') {
      return error(c, 422, 'unprocessable', 'currentTask must be a string or null');
    }

    const now = Date.now();
    const agent = store.upsertAgent(
      {
        agentId,
        provider: body.provider as string | undefined,
        roles: body.roles as string[] | undefined,
        capabilities: body.capabilities as string[] | undefined,
        boards: body.boards as string[] | undefined,
        status: status as AgentStatus,
        currentTask: body.currentTask as string | null | undefined,
        interval,
      },
      now,
    );
    const ttl = interval * 3;
    agentMailbox.emit('agent', agentId);
    return c.json(
      {
        agent,
        presence: { ttl, expiresAt: new Date(now + ttl * 1000).toISOString() },
      },
      200,
    );
  });

  // --- GET /v1/events (SSE dashboard stream, read-only) --------------------

  app.get('/v1/events', (c) => {
    const q = c.req.query();
    const streamToken = q.token ?? c.req.header('Authorization')?.replace(/^Bearer\s+/, '');
    if (streamToken !== token) return error(c, 401, 'unauthorized', 'missing or invalid token');
    const board = q.board ?? null;
    if (board !== null && !ID_RE.test(board)) return error(c, 400, 'bad_request', 'invalid board');

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        send('hello', { ok: true, board });
        const onMsg = (b: string) => {
          if (board === null || b === board) send('message', { board: b });
        };
        const onUpdated = (b: string) => {
          if (board === null || b === board) send('message', { board: b });
        };
        const onAgent = (agentId: string) => send('agent', { agentId });
        mailbox.on('message', onMsg);
        mailbox.on('updated', onUpdated);
        agentMailbox.on('agent', onAgent);
        const ping = setInterval(() => send('ping', { t: Date.now() }), 15_000);
        c.req.raw.signal.addEventListener('abort', () => {
          mailbox.off('message', onMsg);
          mailbox.off('updated', onUpdated);
          agentMailbox.off('agent', onAgent);
          clearInterval(ping);
          controller.close();
        });
      },
    });
    return c.body(stream, 200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
  });

  // --- GET /v1/agents -------------------------------------------------------

  app.get('/v1/agents', (c) => {
    const q = c.req.query();
    const filters: { board?: string; role?: string; status?: AgentStatus } = {};
    if (q.board !== undefined) {
      if (!ID_RE.test(q.board)) return error(c, 400, 'bad_request', 'invalid board filter');
      filters.board = q.board;
    }
    if (q.role !== undefined) {
      if (q.role.length === 0 || q.role.length > 64) return error(c, 400, 'bad_request', 'invalid role filter');
      filters.role = q.role;
    }
    if (q.status !== undefined) {
      if (!AGENT_STATUSES.includes(q.status as AgentStatus)) {
        return error(c, 400, 'bad_request', `status must be one of: ${AGENT_STATUSES.join(', ')}`);
      }
      filters.status = q.status as AgentStatus;
    }
    return c.json({ agents: store.listAgents(filters, Date.now()) }, 200);
  });

  // --- POST /v1/boards/:board/messages --------------------------------------

  app.post('/v1/boards/:board/messages', async (c) => {
    const board = c.req.param('board');
    if (!BOARD_ID_RE.test(board)) return error(c, 422, 'unprocessable', 'invalid board name');

    const body = await readJsonObject(c);
    if (!body) return error(c, 400, 'bad_request', 'body must be a JSON object');

    const to = parseTo(body.to);
    if (!to) return error(c, 422, 'unprocessable', 'to must be agent:<id>, role:<role>, or broadcast');
    const type = body.type;
    if (typeof type !== 'string' || !MSG_TYPES.includes(type as MsgType)) {
      return error(c, 422, 'unprocessable', `type must be one of: ${MSG_TYPES.join(', ')}`);
    }
    if (!('payload' in body)) return error(c, 400, 'bad_request', 'payload is required');
    const priority = body.priority ?? 'normal';
    if (!PRIORITIES.includes(priority as Priority)) {
      return error(c, 422, 'unprocessable', `priority must be one of: ${PRIORITIES.join(', ')}`);
    }
    let ttl: number | null = null;
    if (body.ttl !== undefined) {
      if (!Number.isInteger(body.ttl) || (body.ttl as number) < 0) {
        return error(c, 422, 'unprocessable', 'ttl must be a non-negative integer');
      }
      // Spec §3.1: ttl 0 means no expiry — normalize to NULL.
      ttl = (body.ttl as number) === 0 ? null : (body.ttl as number);
    }
    let idempotencyKey: string | null = null;
    if (body.idempotencyKey !== undefined) {
      if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 || body.idempotencyKey.length > 128) {
        return error(c, 422, 'unprocessable', 'idempotencyKey must be a string of 1..128 chars');
      }
      idempotencyKey = body.idempotencyKey;
    }
    let replyTo: string | null = null;
    if (body.replyTo !== undefined) {
      if (typeof body.replyTo !== 'string' || !/^msg_[A-Za-z0-9_-]{1,64}$/.test(body.replyTo)) {
        return error(c, 422, 'unprocessable', 'invalid replyTo message id');
      }
      replyTo = body.replyTo;
    }

    const now = Date.now();
    const result = store.insertMessage(
      {
        board,
        from: c.get('agentId'),
        toKind: to.kind,
        toValue: to.value,
        type: type as MsgType,
        payload: body.payload,
        priority: priority as Priority,
        ttl,
        idempotencyKey,
        replyTo,
      },
      now,
    );
    if ('duplicate' in result) {
      return error(c, 409, 'duplicate_idempotency_key', 'message with this idempotencyKey already exists', {
        originalMessageId: result.duplicate,
      });
    }
    mailbox.emit('message', board);
    return c.json({ message: result.message }, 201);
  });

  // --- GET /v1/boards/:board/messages ---------------------------------------

  app.get('/v1/boards/:board/messages', async (c) => {
    const board = c.req.param('board');
    if (!BOARD_ID_RE.test(board)) return error(c, 422, 'unprocessable', 'invalid board name');
    if (!store.boardExists(board)) return error(c, 404, 'not_found', `unknown board: ${board}`);

    const q = c.req.query();
    let since = 0;
    if (q.since !== undefined) {
      if (!/^\d+$/.test(q.since)) return error(c, 400, 'bad_request', 'since must be a non-negative integer');
      since = Number(q.since);
    }
    let wait = 0;
    if (q.wait !== undefined) {
      if (!/^\d+$/.test(q.wait)) return error(c, 400, 'bad_request', 'wait must be a non-negative integer');
      wait = Math.min(Number(q.wait), MAX_WAIT);
    }
    const callerAgent = c.get('agentId');
    let forAgent: string | null = null;
    if (q.for !== undefined) {
      if (!ID_RE.test(q.for)) return error(c, 400, 'bad_request', 'invalid for agent id');
      forAgent = q.for;
    }
    let statusFilter: MsgState | undefined;
    if (q.status !== undefined) {
      if (!MSG_STATES.includes(q.status as MsgState)) {
        return error(c, 400, 'bad_request', `status must be one of: ${MSG_STATES.join(', ')}`);
      }
      statusFilter = q.status as MsgState;
    }

    // No agent identity (dashboard-style read-only): observability view only —
    // never claims, never long-polls. Pickup mode requires an identity.
    if (!callerAgent) {
      const messages = store.listMessages(board, since, statusFilter, Date.now());
      return c.json({ messages, cursor: messages.length ? messages[messages.length - 1].seq : since }, 200);
    }

    // Observability mode with identity: read-only, no claiming, no long-poll.
    if (statusFilter) {
      const messages = store.listMessages(board, since, statusFilter, Date.now());
      return c.json({ messages, cursor: messages.length ? messages[messages.length - 1].seq : since }, 200);
    }

    // Pickup mode: claim + long-poll.
    const forId = forAgent ?? callerAgent;
    const now = Date.now();
    let messages: MessageRecord[] = store.claimMessages(board, forId, since, now);
    const deadline = now + wait * 1000;
    while (messages.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const remain = deadline - Date.now();
        const timer = setTimeout(done, Math.min(250, remain));
        const onMail = (b: string) => {
          if (b === board) done();
        };
        function done() {
          clearTimeout(timer);
          mailbox.off('message', onMail);
          resolve();
        }
        mailbox.on('message', onMail);
      });
      messages = store.claimMessages(board, forId, since, Date.now());
    }
    const cursor = messages.length ? messages[messages.length - 1].seq : since;
    return c.json({ messages, cursor }, 200);
  });

  // --- POST /v1/messages/:id/ack --------------------------------------------

  app.post('/v1/messages/:id/ack', async (c) => {
    const id = c.req.param('id');
    if (!/^msg_[A-Za-z0-9_-]{1,64}$/.test(id)) return error(c, 422, 'unprocessable', 'invalid message id');

    const body = await readJsonObject(c);
    if (!body) return error(c, 400, 'bad_request', 'body must be a JSON object');

    const status = body.status;
    if (status !== 'claimed' && status !== 'done' && status !== 'failed') {
      return error(c, 422, 'unprocessable', 'status must be claimed, done, or failed');
    }
    let errMsg: string | null = null;
    if (body.error !== undefined) {
      if (body.error !== null && typeof body.error !== 'string') {
        return error(c, 400, 'bad_request', 'error must be a string or null');
      }
      errMsg = body.error as string | null;
    }
    if (status === 'failed' && !errMsg) {
      return error(c, 422, 'unprocessable', 'error is required when status is failed');
    }

    const result = store.ackMessage(id, c.get('agentId'), status as AckStatus, errMsg, Date.now());
    if ('notFound' in result) return error(c, 404, 'not_found', `unknown message: ${id}`);
    if ('conflict' in result) {
      const message =
        result.conflict === 'not_claimer'
          ? 'message is claimed by another agent'
          : `message is not in claimed state (cannot ack with ${status})`;
      return error(c, 409, 'ack_conflict', message);
    }
    mailbox.emit('updated', result.message.board);
    return c.json({ message: result.message }, 200);
  });

  return app;
}