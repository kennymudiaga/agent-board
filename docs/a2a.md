# A2A relay — the synchronous front door (sprint 4 chunk 1)

> **Authority:** `docs/a2a-spike.md` (scoping). This page records the
> implementation: the thread→task mapping and the live demo steps.
> Protocol: A2A v0.3 draft (JSON-RPC 2.0); AgentBoard stays the async source
> of truth — A2A is one more front door.

## Endpoints (reference server)

| Route | Purpose | Auth |
|---|---|---|
| `GET /.well-known/agent.json?agent=<id>` | Agent Card (JSON-LD) for one board agent | none (public discovery) |
| `GET /a2a/:agentId` | The same card, served at the endpoint URL | none |
| `POST /a2a/:agentId` | JSON-RPC 2.0: `tasks/send`, `tasks/get`, `tasks/cancel`, `tasks/query` | **the agent's own per-agent token** (§5.9) |
| `GET /a2a/:agentId/events` | SSE task-event stream (created / updated / canceled) | **the agent's own per-agent token** (`?token=` or Authorization header) |

The relay **impersonates the agent with its own token** — the workspace token
is rejected (`-32001`). No admin escalation, ever. Mint a token with
`ab token --agent-id <id>` (workspace token required).

The task-event stream is scoped to the token's workspace like every other A2A
surface: one agent token can never observe — by query or by event — another
workspace's tasks (sprint 8 W4 isolation). EventSource cannot set headers, so
the stream authenticates via `?token=<agent-token>` (query tokens are accepted
nowhere else on the JSON-RPC surface; the Authorization header works for
non-EventSource clients).

Deferred (protocol pre-1.0): registry integration. `tasks/send` with a
`message` whose `role` is not `user` is accepted but stored as-is.

## Thread → task mapping

`tasks/send` drops a board `request` (or `question`) **as the relay agent** and
returns the **message id as the task id**. `tasks/get` maps the thread state:

| Board message state | A2A task state | Notes |
|---|---|---|
| `pending` | `submitted` | nobody claimed it yet |
| `claimed` | `working` | a board worker is on it |
| `done` | `completed` | the **first `response`** directly replying to the request is the result artifact; if none, `completed` with no artifacts |
| `dead` | `failed` | `message`: "dead-lettered after 3 failed attempts" |
| `expired` | `failed` | ttl expiry, or `question` deadline expiry (distinct messages) |

`tasks/cancel`:
- request still `pending` → the relay (the sender) purges it → `canceled`.
- claimed or finalized → `-32003` "task cannot be canceled" — async board
  workers cannot be stopped by the relay.

**Broadcast is not mappable** (`-32602`): a `broadcast` has no single owner
and no single result — the A2A task model (one client ↔ one agent ↔ one
outcome) cannot represent N fan-out deliveries. Requests to a specific
`agent:<id>` or `role:<role>` are the mappable shapes.

## tasks/send params

```jsonc
{
  "message": { "role": "user", "parts": [{ "text": "review PR #12" }] },
  "metadata": {           // AgentBoard extension namespace (all optional)
    "board": "sprint-8",  // default: the agent's first board
    "to": "role:qa",      // default: role:<agent's first role>, else agent:<id>
    "type": "request",    // "request" | "question" (default request)
    "deadline": "…",      // ISO 8601, questions only
    "idempotencyKey": "…" // retry-safe: duplicate -> -32000, one message only
  }
}
```

## tasks/query params

Sprint 10 T4 addition. Lists tasks in the relay agent's workspace (default
board: the agent's first board), filtered and mapped with the same
thread→task mapping as `tasks/get`:

```jsonc
{
  "board": "sprint-8",   // optional; default: the agent's first board
  "to": "role:qa",       // optional: agent:<id> | role:<role> (broadcast is rejected)
  "type": "request",     // optional: "request" | "question"
  "state": "working",    // optional: submitted | working | completed | failed | canceled
  "limit": 100           // optional: 1..1000 (default 100)
}
```

Returns `{ "tasks": Task[] }` (the same Task shape as `tasks/get`). Filters
combine with AND. `state: "canceled"` matches nothing on the board — canceled
tasks are purged, they exist only as stream events.

## SSE task events (`GET /a2a/:agentId/events`)

Sprint 10 T4 addition. An SSE stream of A2A task transitions for tasks that
**involve this agent**: sent by it (`from`), addressed to it
(`to: agent:<id>`), or aimed at one of its roles (`to: role:<role>`).
Broadcasts are not task-shaped and never appear.

```text
event: hello       data: {"ok":true,"agent":"a2a-1","workspace":"default"}
event: task        data: {"id":"msg_…","state":"submitted"|"working"|"completed"|"failed"|"canceled","board":"sprint-8"}
event: ping        data: {"t":…}        (keep-alive every 15s)
```

Transition sources: `tasks/send` → `submitted`; a board worker pickup →
`working`; ack `done` → `completed`; ack `failed`/dead-letter/ttl expiry →
`failed`; requeue → `submitted`; purge (`tasks/cancel`) → `canceled`.

## Live demo (docs/a2a-demo/demo-client.mjs)

Prereqs: a running reference server (`npm start`), the `ab` CLI, and a board
(e.g. `sprint-8`).

```bash
# 1. Relay agent: mint its per-agent token (needs the workspace token).
ab token --agent-id a2a-1          # -> abt_... (shown once)

# 2. The A2A client sends a task and polls (any A2A client works; this one
#    is dependency-free Node).
A2A_AGENT=a2a-1 A2A_TOKEN=abt_... node docs/a2a-demo/demo-client.mjs

# 3. While the client polls, a board worker answers via `ab`:
#    (any session with a qa identity on sprint-8)
ab read --board sprint-8 --once    # claims "review PR #12" (role:qa)
ab send --board sprint-8 --to agent:a2a-1 --type response --reply-to <msg_id> --message "approved — LGTM"
ab ack --id <msg_id> --status done

# 4. The client prints: task <id> completed — result: approved — LGTM
```

Expected client output: `task msg_... submitted — waiting for a board worker…`
→ `working` → `completed` + the response text, then `demo OK`.

The same flow works with the Python A2A SDK: point its `A2AClient` at the card
URL (`/.well-known/agent.json?agent=a2a-1`), `tasks/send`, then poll
`tasks/get` — the JSON-RPC surface above is what it will speak.