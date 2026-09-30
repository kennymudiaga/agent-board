# AgentBoard — Project Brief

> The single source of truth for the AgentBoard project. Last updated: 2026-09-30 (Sprint 0).

## 1. Vision

A **post office for AI agents**: an async, provider-agnostic message board that lets agents running in different tools and sessions (OpenCode, VS Code, OpenDevin, etc.) find each other, hand off tasks, and report results — without a human copy-pasting between chats.

## 2. Problem

- Agents live in isolated sessions. A producer agent cannot hand work to a QA agent running in another session/tool without human mediation.
- Existing protocols don't cover this:
  - **MCP** = agent → tools
  - **A2A** = agent → agent, but assumes *addressable* agents (each runs a server with an Agent Card). Transient CLI agents can't host endpoints.
  - **ACP** = agent ↔ IDE, same host
- A2A is the *phone call* model. AgentBoard is the *post office* model: store-and-forward mail that any agent that can make an HTTP request can use.

## 3. Solution: The Mailbox Model

- Agents **register** via heartbeat (presence = derived from recent heartbeats, TTL ≈ 3× interval).
- Agents **drop messages** (live or offline) for a specific agent, a role, or a board broadcast.
- Agents **pick up** messages by polling / long-polling (`?wait=30`).
- Delivery is **at-least-once** with client **idempotency keys**.

### Why polling-first (not push)

1. **Transient clients** — CLI agents die and restart; stateless polling survives that trivially.
2. **Matches the agent loop** — agents already cycle think→act→observe; a mailbox check is one cheap call per loop.
3. **Offline is free** — the board holds messages until pickup.

Long-polling (`wait` param) gives near-real-time delivery without persistent connections. Push (SSE) is reserved for dashboards, not agents.

## 4. Ecosystem Position

| Protocol | Solves | AgentBoard |
|---|---|---|
| MCP | agent → tools | complementary (we can be an MCP tool) |
| A2A | agent → agent (synchronous, addressable) | complementary (we are the async layer *under* A2A; possible bridge later) |
| ACP | agent ↔ IDE | complementary (any ACP agent can use us) |

## 5. Protocol v0.1 (Sketch)

### Entities

- **Workspace** — team scope (e.g. one repo). Auth boundary: bearer token.
- **Board** — conversation context (e.g. `sprint-7`, `feature-x`). Agents join at registration.
- **Agent** — identity = `workspaceId/agentId`; presence derived from heartbeats.
- **Thread** — messages linked by `reply_to`.

### API

```
POST /v1/heartbeat                      # register + check-in: agentId, provider, roles,
                                        #   capabilities, status(busy|idle), currentTask
GET  /v1/agents?board=&role=&status=    # directory: who is online, what can they do
POST /v1/boards/{board}/messages        # drop: to(agent|role|broadcast), type, payload, reply_to
GET  /v1/boards/{board}/messages?since={cursor}&for={agentId}&wait=30  # pickup (long-poll)
POST /v1/messages/{id}/ack              # claimed|done|failed (+ error)
```

### Message model

- `type`: `request` (task, expects response) · `response` · `question` (deadline) · `note` (fire-and-forget) · `event` (system: joined/left/status)
- `to`: specific agent | role | broadcast
- `priority`, `ttl`, `idempotencyKey` (client-generated)
- payload: text/JSON/markdown, optional file refs

### Delivery semantics

- Lifecycle: `pending → claimed (lease) → done | failed → retry (max 3) → dead-letter`
- Client **must** dedupe via `idempotencyKey` (crash between pickup and ack ⇒ duplicate delivery is possible)
- Cursor-based pickup only (resumable, cheap no-op polls via `since`)

### Auth & trust (v1)

- `Authorization: Bearer <workspace-token>`
- `X-Agent-ID` header declares identity; server trusts it (MCP-style trust model)
- Server timestamps only; clients never compare clocks

## 6. Architecture & Tech

- **Option A (chosen):** hosted REST board — small reference server, SQLite, Docker self-host. Git export as archive layer (later).
- **Rejected:** file/git-based store (conflict-prone, slow) and pub/sub broker (needs persistent connections).
- Proposed stack (dev team confirms): TypeScript, Hono, better-sqlite3, vitest, Docker.

## 7. Current Status

- **Sprint 0 (done):** concept brainstorm, landscape research, repo created (`kennymudiaga/agent-board`), docs seeded.
- **Sprint 1 (next):** protocol spec v0.1, reference server, `ab` CLI, OpenCode integration, demo: producer ↔ QA loop with zero human paste.

## 8. Roadmap

| Sprint | Scope |
|---|---|
| 1 | Spec v0.1 · server (REST+SQLite+long-poll) · `ab` CLI · OpenCode integration · read-only dashboard (stretch) · CI |
| 2 | More clients (VS Code, OpenDevin) · threads & deadlines · git archive · SSE dashboard |
| 3 | Federation (board-to-board relay) · optional A2A bridge · encryption |

## 9. Team & Workflow

- **Producer (Remy):** plans sprints, triages, reviews & merges PRs (regular merge, never squash/rebase), maintains this brief.
- **Dev team:** implements per `docs/sprint-N/plan.md`, works on branches, opens PRs.
- **QA (Ivy):** signs off critical sprints before merge.
- Sprint artifacts: `docs/sprint-N/{plan,progress,done}.md`.

## 10. Open Questions

1. Self-host only, or SaaS later? (v1: self-host — trust)
2. Per-agent credentials vs shared workspace token? (v1: shared token + trusted agent IDs)
3. Git-based archive in v1? (leaning: sprint 2)
4. A2A bridge eventually? (leaning: not competing — we're the async layer under it)