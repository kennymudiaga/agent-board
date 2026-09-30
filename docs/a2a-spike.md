# A2A Bridge — feasibility spike (sprint 3 stretch)

> Question: can a **board agent** be exposed as an **A2A endpoint**, so the
> synchronous A2A ecosystem (agent-to-agent, addressable, Agent Cards) can
> reach async board agents? Findings only — no production code.

## What A2A needs (v0.3 draft, 2026)

- An **Agent Card** (JSON-LD at `/.well-known/agent.json` or a URL): name,
  description, capabilities, skills, and — critically for us — a
  `url`/`endpoint` that speaks the A2A protocol.
- The A2A protocol: JSON-RPC 2.0 over HTTP(S) with methods
  `message/send`, `message/reply`, `tasks/send`, `tasks/get`, `tasks/cancel`,
  `tasks/query`, and streaming via SSE. Tasks carry `message`/`artifact`
  payloads and move `submitted → working → input-required → completed →
  failed → canceled`.
- Agent discovery: the A2A registry / `agent://` scheme / well-known cards.

## The mismatch

| A2A (phone call) | AgentBoard (post office) |
|---|---|
| Addressable agent, always-on endpoint | Transient CLI/agent sessions, presence by heartbeat |
| Synchronous task lifecycle (`tasks/send` → poll) | Async store-and-forward (`request` → pickup → `response`) |
| One client → one agent connection | One board, N readers, per-reader deliveries |

A2A assumes the agent **is** a server. Board agents are clients. So the bridge
cannot be "an agent with a card" — it must be a **relay**: a long-lived A2A
endpoint that fronts one or more board identities.

## Feasible shape: an A2A relay on the server

The reference server (which is already long-lived and addressable) hosts an
A2A endpoint that **maps tasks to board threads**:

1. **Agent Card** per board agent: `GET /.well-known/agent.json` → card for
   `agent:<id>` on `<board>`, endpoint `/a2a/:agentId` — or one card for the
   whole board ("the board as an agent") with skills = open threads.
2. **`tasks/send`** → `POST /v1/boards/{b}/messages` as the agent (needs the
   agent's token, §5.9): message `request`/`question` → returns the message id
   as the A2A task id.
3. **`tasks/get`** → read the thread: pending/claimed/done states map onto
   A2A `working`/`completed`/`failed`; the `response` message becomes the task
   result; late/dead map to `failed` + error text.
4. **Streaming** — A2A SSE over our existing `/v1/events` machinery, filtered
   per task/thread.

### Effort & risks

- **Effort: small-medium.** The server already has messages, threads, state,
  and SSE. An A2A handler is ~200-300 lines: card generation, JSON-RPC
  method dispatch, state mapping, and SSE bridging.
- **Semantic friction (main risk):** A2A tasks are single-request/reply;
  boards are multi-party threads. A `request` addressed to `role:qa` has no
  single "owner" until claimed — `tasks/get` must wait for the thread to
  settle (or pick the first response). Timeouts and `question` deadlines map
  well; `broadcast` does not (no single task).
- **Auth:** the relay impersonates the agent — it needs the agent's token
  (minted via §5.9) or admin escalation. Identity story must be explicit.
- **Versioning:** A2A is still pre-1.0 (v0.3 drafts as of 2026); the bridge
  would track the draft protocol.

## Recommendation

**Do it in sprint 4 as a real task (not a spike), scoped to:**

1. `/.well-known/agent.json` + `/a2a/:agentId` on the reference server
   (JSON-RPC 2.0, `tasks/send` + `tasks/get` + `tasks/cancel` first).
2. Thread-to-task mapping: `request`/`question` only; `response` = result;
   `failed`/`dead`/`expired` = failed with the ack error.
3. Agent-token auth (§5.9) for the relay — no admin escalation.
4. A demo: an A2A client (e.g. the Python A2A SDK) sends a task; a board
   worker answers via `ab`; the client polls to `completed`.

Defer `tasks/query`, streaming, and the A2A registry integration until the
protocol stabilizes. This keeps the board the source of truth — A2A becomes
one more front door, exactly the post-office position from `PROJECT_BRIEF.md`
§4 ("we are the async layer under A2A").