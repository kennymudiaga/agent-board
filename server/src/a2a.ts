/**
 * A2A relay (sprint 4 chunk 1 — docs/a2a.md, docs/a2a-spike.md).
 *
 * The synchronous A2A ecosystem reaches async board agents through a
 * JSON-RPC 2.0 endpoint that maps A2A tasks onto board threads:
 *
 *   tasks/send   -> POST /v1/boards/:board/messages as the relay agent
 *                   (`request` | `question` only; the message id IS the task id)
 *   tasks/get    -> thread state -> A2A task state
 *                   (pending -> submitted, claimed -> working, done -> completed,
 *                    dead/expired -> failed; the first `response` is the result)
 *   tasks/cancel -> a still-pending request is purged (sender-gated); anything
 *                   claimed or finalized is NOT cancelable (-32003) — async
 *                   board workers cannot be stopped by the relay.
 *
 * Auth: the relay impersonates the relay agent with its own per-agent token
 * (spec §5.9) — the workspace token is NOT accepted here (no admin escalation).
 * Broadcast is not mappable to a single A2A task (no single owner, no single
 * result) — rejected with -32602 and documented in docs/a2a.md.
 */
import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { ID_RE, type MessageRecord, type Store } from './db.js';

const A2A_CONTEXT = 'https://a2a-protocol.org/ns/0.3/agent-card.jsonld';

const RPC_CODES = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  UNAUTHORIZED: -32001,
  TASK_NOT_FOUND: -32002,
  TASK_NOT_CANCELABLE: -32003,
} as const;

interface TaskStatus {
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';
  message?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskPart {
  type: 'text';
  text: string;
}

interface TaskMessage {
  role: 'user' | 'agent';
  parts: TaskPart[];
}

interface Task {
  id: string;
  status: TaskStatus;
  artifacts?: { name?: string; parts: TaskPart[] }[];
  history?: TaskMessage[];
  metadata?: Record<string, unknown>;
}

function rpcOk(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcErr(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function originOf(c: Context): string {
  const host = c.req.header('host') ?? 'localhost';
  const proto = c.req.header('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

/** Agent Card (JSON-LD, A2A v0.3 draft) for one board agent. */
function cardFor(store: Store, agentId: string, origin: string, now: number) {
  const agent = store.getAgent(agentId, now);
  const url = `${origin}/a2a/${agentId}`;
  return {
    '@context': A2A_CONTEXT,
    '@type': 'AgentCard',
    name: `agentboard:${agentId}`,
    description:
      `AgentBoard agent ${agentId} — async post office relay. Tasks map to board ` +
      `threads; a board worker answers asynchronously and the client polls tasks/get.` +
      (agent && agent.boards.length ? ` Boards: ${agent.boards.join(', ')}.` : ''),
    url,
    endpoints: [{ protocol: 'a2a', url }],
    skills: (agent?.roles ?? []).map((r) => ({
      id: `role:${r}`,
      name: `role ${r}`,
      description: `Sends board requests addressed to role:${r}`,
    })),
    ...(agent ? { boards: agent.boards } : {}),
  };
}

function partsFromPayload(payload: unknown): TaskPart[] {
  const p = payload as Record<string, unknown> | null;
  if (p && typeof p.text === 'string') return [{ type: 'text', text: p.text }];
  return [{ type: 'text', text: JSON.stringify(payload ?? null) }];
}

/**
 * Thread -> A2A task mapping (docs/a2a.md):
 * `pending` -> submitted · `claimed` -> working · `done` -> completed (the
 * first direct `response` becomes the artifact) · `dead` -> failed (3 failed
 * attempts) · `expired` -> failed (ttl/deadline).
 */
function taskFromMessage(store: Store, m: MessageRecord, now: number): Task {
  const replies = store.listReplies(m.id, now);
  const response = replies.find((r) => r.type === 'response') ?? replies[0] ?? null;
  let state: TaskStatus['state'] = 'working';
  let message: string | undefined;
  switch (m.state) {
    case 'pending':
      state = 'submitted';
      break;
    case 'claimed':
      state = 'working';
      break;
    case 'done':
      state = 'completed';
      break;
    case 'dead':
      state = 'failed';
      message = 'dead-lettered after 3 failed attempts';
      break;
    case 'expired':
      state = 'failed';
      message = m.type === 'question' ? 'question deadline expired' : 'message ttl expired';
      break;
    default:
      state = 'working';
  }
  const history: TaskMessage[] = [{ role: 'user', parts: partsFromPayload(m.payload) }];
  const artifacts: Task['artifacts'] = [];
  if (response) {
    history.push({ role: 'agent', parts: partsFromPayload(response.payload) });
    if (state === 'completed') artifacts.push({ name: response.id, parts: partsFromPayload(response.payload) });
  }
  return {
    id: m.id,
    status: { state, ...(message ? { message } : {}), createdAt: m.createdAt, updatedAt: m.updatedAt },
    ...(artifacts.length ? { artifacts } : {}),
    ...(history.length ? { history } : {}),
    metadata: { board: m.board, to: m.to },
  };
}

function parseA2ATo(raw: string): { kind: 'agent' | 'role' | 'broadcast'; value: string | null } | undefined {
  if (raw === 'broadcast') return { kind: 'broadcast', value: null };
  const m = /^(agent|role):(.+)$/.exec(raw);
  if (!m || m[2].length === 0 || m[2].length > 64) return undefined;
  if (m[1] === 'agent' && !ID_RE.test(m[2])) return undefined;
  return { kind: m[1] as 'agent' | 'role', value: m[2] };
}

export function createA2ARoutes(store: Store, mailbox: { emit: (event: string, data?: unknown) => void }) {
  const app = new Hono();

  // Agent Card discovery (public — cards carry no secrets).
  app.get('/.well-known/agent.json', (c) => {
    const agentId = c.req.query('agent');
    if (!agentId || !ID_RE.test(agentId)) {
      return c.json(
        { error: { code: 'agent_required', message: 'pass ?agent=<id> — Agent Cards here are per board agent' } },
        400,
      );
    }
    return c.json(cardFor(store, agentId, originOf(c), Date.now()));
  });

  // The A2A endpoint URL also serves the card (A2A discovery convention).
  app.get('/a2a/:agentId', (c) => {
    const agentId = c.req.param('agentId');
    if (!ID_RE.test(agentId)) return c.json({ error: { code: 'invalid_agent', message: 'invalid agent id' } }, 400);
    return c.json(cardFor(store, agentId, originOf(c), Date.now()));
  });

  // JSON-RPC 2.0 relay — agent-token auth only (§5.9, no admin escalation).
  app.post('/a2a/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    if (!ID_RE.test(agentId)) return c.json(rpcErr(null, RPC_CODES.INVALID_PARAMS, 'invalid agent id'), 400);

    const auth = c.req.header('Authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const bound = bearer ? store.agentForToken(bearer) : null;
    if (bound !== agentId) {
      return c.json(rpcErr(null, RPC_CODES.UNAUTHORIZED, "unauthorized: this agent's per-agent token is required (spec §5.9)"), 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcErr(null, RPC_CODES.PARSE, 'parse error: body must be valid JSON'), 200);
    }
    const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown } | null;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return c.json(rpcErr(req?.id, RPC_CODES.INVALID_REQUEST, 'invalid request: jsonrpc 2.0 + method are required'), 200);
    }

    const now = Date.now();
    const params = (req.params ?? {}) as Record<string, unknown>;

    switch (req.method) {
      case 'tasks/send': {
        const msg = params.message as { parts?: unknown } | undefined;
        if (!msg || typeof msg !== 'object' || !Array.isArray(msg.parts)) {
          return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'params.message.parts is required'), 200);
        }
        const text = (msg.parts as { text?: unknown }[])
          .filter((p) => p && typeof p === 'object' && typeof p.text === 'string')
          .map((p) => p.text as string)
          .join('\n');
        if (!text) return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'params.message must contain at least one text part'), 200);

        const meta = params.metadata && typeof params.metadata === 'object' ? (params.metadata as Record<string, unknown>) : {};
        const agent = store.getAgent(agentId, now);
        const board = typeof meta.board === 'string' && ID_RE.test(meta.board) ? meta.board : agent?.boards?.[0];
        if (!board) {
          return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'no target board: the agent has no boards — pass metadata.board'), 200);
        }
        const toRaw = typeof meta.to === 'string' ? meta.to : agent?.roles?.[0] ? `role:${agent.roles[0]}` : `agent:${agentId}`;
        const to = parseA2ATo(toRaw);
        if (!to) return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'metadata.to must be agent:<id> or role:<role>'), 200);
        if (to.kind === 'broadcast') {
          return c.json(
            rpcErr(
              req.id,
              RPC_CODES.INVALID_PARAMS,
              'broadcast is not mappable to a single A2A task: no single owner, no single result (docs/a2a.md)',
            ),
            200,
          );
        }
        const type = meta.type === 'question' ? 'question' : 'request';
        let deadline: number | null = null;
        if (meta.deadline !== undefined) {
          if (type !== 'question' || typeof meta.deadline !== 'string' || Number.isNaN(Date.parse(meta.deadline))) {
            return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'metadata.deadline must be an ISO 8601 timestamp and type=question'), 200);
          }
          deadline = Date.parse(meta.deadline);
        }
        const idem = typeof meta.idempotencyKey === 'string' && meta.idempotencyKey.length > 0;
        const idempotencyKey = `a2a:${agentId}:${idem ? meta.idempotencyKey : randomUUID()}`;

        const result = store.insertMessage(
          {
            board,
            from: agentId,
            toKind: to.kind,
            toValue: to.value,
            type,
            payload: { text },
            priority: 'normal',
            ttl: null,
            deadline,
            idempotencyKey,
            replyTo: null,
          },
          now,
        );
        if ('duplicate' in result) {
          return c.json(rpcErr(req.id, -32000, 'duplicate task: this idempotencyKey was already used'), 200);
        }
        mailbox.emit('message', board);
        return c.json(rpcOk(req.id, taskFromMessage(store, result.message, now)), 200);
      }

      case 'tasks/get': {
        const id = typeof params.id === 'string' ? params.id : null;
        if (!id) return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'params.id is required'), 200);
        const m = store.getMessage(id);
        if (!m) return c.json(rpcErr(req.id, RPC_CODES.TASK_NOT_FOUND, 'task not found'), 200);
        store.listReplies(m.id, now); // sweep for fresh states
        return c.json(rpcOk(req.id, taskFromMessage(store, store.getMessage(id)!, now)), 200);
      }

      case 'tasks/cancel': {
        const id = typeof params.id === 'string' ? params.id : null;
        if (!id) return c.json(rpcErr(req.id, RPC_CODES.INVALID_PARAMS, 'params.id is required'), 200);
        const m = store.getMessage(id);
        if (!m) return c.json(rpcErr(req.id, RPC_CODES.TASK_NOT_FOUND, 'task not found'), 200);
        // The relay is the sender, so a still-pending request can be purged.
        if (m.state === 'pending' && m.from === agentId) {
          store.deleteMessage(m.id, agentId);
          return c.json(
            rpcOk(req.id, {
              id: m.id,
              status: { state: 'canceled', createdAt: m.createdAt, updatedAt: new Date(now).toISOString() },
            }),
            200,
          );
        }
        return c.json(
          rpcErr(req.id, RPC_CODES.TASK_NOT_CANCELABLE, 'task cannot be canceled: the board request is claimed or finalized (async workers cannot be stopped by the relay)'),
          200,
        );
      }

      default:
        return c.json(rpcErr(req.id, RPC_CODES.METHOD_NOT_FOUND, `method not found: ${String(req.method)}`), 200);
    }
  });

  return app;
}