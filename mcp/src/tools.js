/**
 * agentboard-mcp tool layer — one handler per board capability.
 * Reuses the CLI's HTTP client and env-only config rules (tokens stay out of
 * disk). Handlers return MCP text content; errors are returned as text, never
 * thrown (the server stays alive for the next tool call).
 */
import { z } from 'zod';
import { apiCall, CliError } from '../../cli/src/api.js';
import { loadConfig } from '../../cli/src/config.js';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const errorText = (e) => text({ error: e instanceof CliError ? { message: e.message, code: e.code, status: e.status } : { message: String(e?.message ?? e) } });

/** Shared env-only config (AB_SERVER/AB_TOKEN/AB_AGENT_ID). Never saved. */
export function identity() {
  return loadConfig(process.cwd(), { requireFile: false });
}

const boardField = z.string().describe('Board name.');

export const tools = {
  whoami: {
    description: 'Report this agent\'s identity and board configuration (from env/config; no server call).',
    inputSchema: z.object({}),
    async handler(args) {
      const cfg = identity();
      return text({
        agentId: cfg.agentId,
        roles: cfg.roles,
        boards: cfg.boards,
        provider: cfg.provider,
        server: cfg.server,
        env: { server: !!process.env.AB_SERVER, token: !!process.env.AB_TOKEN, agentId: !!process.env.AB_AGENT_ID },
      });
    },
  },

  heartbeat: {
    description: 'Register/check in with the board server: keeps presence alive and declares status + current task. Returns the agent record and presence TTL.',
    inputSchema: z.object({
      interval: z.number().int().min(1).max(3600).optional().describe('Heartbeat interval in seconds (presence TTL = 3x). Default 60.'),
      status: z.enum(['idle', 'busy']).optional().describe('busy while working, idle while waiting.'),
      task: z.string().optional().describe('currentTask shown to producers/dashboards.'),
      board: z.string().optional().describe('Boards to join (comma-separated). Defaults to configured boards.'),
      roles: z.string().optional().describe('Roles to declare (comma-separated, e.g. "qa,reviewer"). Defaults to AB_ROLES env / config.'),
    }),
    async handler(args) {
      const cfg = identity();
      const boards = args.board !== undefined ? String(args.board).split(',').map((s) => s.trim()).filter(Boolean) : cfg.boards;
      const roles = args.roles !== undefined ? String(args.roles).split(',').map((s) => s.trim()).filter(Boolean) : cfg.roles;
      const body = {
        agentId: cfg.agentId,
        provider: cfg.provider ?? undefined,
        roles,
        boards,
        status: args.status ?? 'idle',
        currentTask: args.task ?? null,
        interval: args.interval ?? 60,
      };
      try {
        return text(await apiCall(cfg, 'POST', '/v1/heartbeat', { body }));
      } catch (e) {
        return errorText(e);
      }
    },
  },

  send: {
    description: 'Drop a message on a board. to accepts agent:<id>, role:<role>, or broadcast. Returns the created message (state pending).',
    inputSchema: z.object({
      board: boardField,
      to: z.string().describe('agent:<id> | role:<role> | broadcast.'),
      type: z.enum(['request', 'response', 'question', 'note', 'event']).optional().describe('Default request.'),
      message: z.string().optional().describe('Shortcut for payload {"text": ...}.'),
      payload: z.string().optional().describe('Raw JSON payload (mutually exclusive with message).'),
      replyTo: z.string().optional().describe('Message id this answers (threads).'),
      priority: z.enum(['low', 'normal', 'high']).optional(),
      ttl: z.number().int().min(0).optional().describe('Seconds until the message expires (0/absent = never).'),
      deadline: z.string().optional().describe('ISO 8601 with timezone; questions only.'),
      idempotencyKey: z.string().optional().describe('Retry-safe key (409 on duplicate with original id).'),
    }),
    async handler(args) {
      const cfg = identity();
      let payload;
      if (args.payload !== undefined) {
        try {
          payload = JSON.parse(args.payload);
        } catch {
          return text({ error: 'payload must be valid JSON' });
        }
      } else {
        payload = { text: args.message ?? '' };
      }
      const body = {
        to: args.to,
        type: args.type ?? 'request',
        payload,
        ...(args.replyTo !== undefined ? { replyTo: args.replyTo } : {}),
        ...(args.priority !== undefined ? { priority: args.priority } : {}),
        ...(args.ttl !== undefined ? { ttl: args.ttl } : {}),
        ...(args.deadline !== undefined ? { deadline: args.deadline } : {}),
        ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
      };
      try {
        const data = await apiCall(cfg, 'POST', `/v1/boards/${args.board}/messages`, { agent: cfg.agentId, body });
        return text(data.message);
      } catch (e) {
        return errorText(e);
      }
    },
  },

  read: {
    description: 'Pick up messages on a board (pickup atomically CLAIMS pending messages addressed to this agent; long-poll with wait). Optionally auto-acks each with the given status. Returns messages + the server watermark (resume point).',
    inputSchema: z.object({
      board: boardField,
      wait: z.number().int().min(0).max(60).optional().describe('Long-poll seconds (0-60). Default 30.'),
      since: z.number().int().min(0).optional().describe('Resume cursor (use the previous watermark). Default 0.'),
      ack: z.enum(['claimed', 'done', 'failed']).optional().describe('Auto-ack each returned message.'),
      error: z.string().optional().describe('Required when ack=failed.'),
    }),
    async handler(args) {
      const cfg = identity();
      try {
        const data = await apiCall(cfg, 'GET', `/v1/boards/${args.board}/messages?since=${args.since ?? 0}&wait=${args.wait ?? 30}`, {
          agent: cfg.agentId,
        });
        if (args.ack) {
          for (const m of data.messages) {
            await apiCall(cfg, 'POST', `/v1/messages/${m.id}/ack`, {
              agent: cfg.agentId,
              body: { status: args.ack, error: args.error ?? null },
            });
          }
        }
        return text({ messages: data.messages, watermark: data.watermark, cursor: data.cursor });
      } catch (e) {
        return errorText(e);
      }
    },
  },

  ack: {
    description: 'Acknowledge a claimed message: done (success), failed (+error -> retry/dead-letter), or claimed (lease renewal for long tasks).',
    inputSchema: z.object({
      id: z.string().describe('Message id (msg_...).'),
      status: z.enum(['done', 'failed', 'claimed']),
      error: z.string().optional().describe('Required for failed.'),
    }),
    async handler(args) {
      const cfg = identity();
      try {
        const data = await apiCall(cfg, 'POST', `/v1/messages/${args.id}/ack`, {
          agent: cfg.agentId,
          body: { status: args.status, error: args.error ?? null },
        });
        return text(data.message);
      } catch (e) {
        return errorText(e);
      }
    },
  },

  list_agents: {
    description: 'Agent directory: who is around and what they can do. Filters optional.',
    inputSchema: z.object({
      board: z.string().optional(),
      role: z.string().optional(),
      status: z.enum(['busy', 'idle']).optional(),
    }),
    async handler(args) {
      const cfg = identity();
      const q = new URLSearchParams();
      if (args.board !== undefined) q.set('board', args.board);
      if (args.role !== undefined) q.set('role', args.role);
      if (args.status !== undefined) q.set('status', args.status);
      try {
        const data = await apiCall(cfg, 'GET', `/v1/agents${q.size ? `?${q}` : ''}`);
        return text(data.agents);
      } catch (e) {
        return errorText(e);
      }
    },
  },

  list_boards: {
    description: 'Board directory: every known board with message counts (read-only).',
    inputSchema: z.object({}),
    async handler() {
      const cfg = identity();
      try {
        const data = await apiCall(cfg, 'GET', '/v1/boards');
        return text(data.boards);
      } catch (e) {
        return errorText(e);
      }
    },
  },

  requeue: {
    description: 'Return a dead-lettered message to the queue (sender only): dead -> pending, attempts reset.',
    inputSchema: z.object({ id: z.string() }),
    async handler(args) {
      const cfg = identity();
      try {
        const data = await apiCall(cfg, 'POST', `/v1/messages/${args.id}/requeue`, { agent: cfg.agentId });
        return text(data.message);
      } catch (e) {
        return errorText(e);
      }
    },
  },

  purge: {
    description: 'Permanently delete a message and its deliveries (sender only).',
    inputSchema: z.object({ id: z.string() }),
    async handler(args) {
      const cfg = identity();
      try {
        const data = await apiCall(cfg, 'DELETE', `/v1/messages/${args.id}`, { agent: cfg.agentId });
        return text(data);
      } catch (e) {
        return errorText(e);
      }
    },
  },
};

/** Call a tool by name with raw args (used by the MCP server and tests). */
export async function callTool(name, args) {
  const tool = tools[name];
  if (!tool) return text({ error: `unknown tool: ${name}` });
  return tool.handler(args ?? {});
}