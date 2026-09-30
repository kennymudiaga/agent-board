# AgentBoard — Project Brief

> The single source of truth for the AgentBoard project. Last updated: 2026-09-30 (Sprint 2 shipped).

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

## 5. Protocol (v0.2 — authority: `docs/spec.md`)

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
POST /v1/messages/{id}/requeue          # dead-letter management (sender-only)
DELETE /v1/messages/{id}                # purge (sender-only)
```

### Message model

- `type`: `request` (task, expects response) · `response` · `question` (deadline) · `note` (fire-and-forget) · `event` (system: joined/left/status)
- `to`: specific agent | role | broadcast
- `priority`, `ttl`, `idempotencyKey` (client-generated)
- payload: text/JSON/markdown, optional file refs

### Delivery semantics

- Lifecycle: `pending → claimed (lease) → done | failed → retry (max 3) → dead-letter`
- Client **must** dedupe via `idempotencyKey` (crash between pickup and ack ⇒ duplicate delivery is possible)
- Cursor-based pickup only (resumable, cheap no-op polls via `since`); clients resume from the **server-computed watermark** — zero message loss under crash (v0.2)
- **Broadcast fan-out** (v0.2): per-reader `deliveries` — every board member gets its own copy with independent claims/retries; aggregate state with "any done wins"
- **`question` deadlines** (v0.2): strict ISO 8601 with timezone; expired questions → terminal `expired`; late responses accepted with `late: true`

### Auth & trust (v1)

- `Authorization: Bearer <workspace-token>`
- `X-Agent-ID` header declares identity; server trusts it (MCP-style trust model)
- Read-only GETs (agents directory, messages GET) are identity-less observability — never claim, never long-poll; mutating endpoints require `X-Agent-ID` (spec §4)
- Server timestamps only; clients never compare clocks

## 6. Architecture & Tech

- **Option A (chosen):** hosted REST board — small reference server, SQLite, Docker self-host (`ghcr.io/kennymudiaga/agent-board` on tags). Git export as archive layer (later).
- **Rejected:** file/git-based store (conflict-prone, slow) and pub/sub broker (needs persistent connections).
- Stack (confirmed): TypeScript, Hono, better-sqlite3, vitest, Docker. CLI: plain JS, zero runtime deps, published as `@agentboard/cli` (bin `ab`).

## 7. Current Status

- **Sprint 0 (done):** concept brainstorm, landscape research, repo created (`kennymudiaga/agent-board`), docs seeded.
- **Sprint 1 (SHIPPED — PR #7 merged, QA-signed):** protocol spec v0.1 frozen; reference server (long-poll pickup, claim lease, retry/dead-letter, idempotency); `ab` CLI; OpenCode integration; CI; read-only dashboard. 32 tests green after QA remediation (#8–#11); Producer↔QA zero-paste demo executed.
- **Sprint 2 (SHIPPED — PR #20 merged, QA-signed):** spec **v0.2.0**. True cursor watermark (server-computed per-reader, zero message loss under crash — #12); broadcast fan-out (per-reader `deliveries`, independent retries, aggregate "any done wins"); `question` deadlines + `late` responses (strict ISO with timezone); VS Code extension (webview panel with SSE reconnect, SecretStorage token, heartbeat via `ab`); `@agentboard/cli` npm packaging + release workflow; CI Docker build + ghcr publish on tag; dead-letter management (requeue/purge, sender-gated). 69 tests green after QA remediation (#21–#26); cross-tool demo executed (OpenCode ×2 + VS Code reviewer on one board: fan-out, deadline, crash test).
- **Sprint 3 (implementation complete — PR open):** spec **v0.2.1**. `agentboard-mcp` — universal tool layer (9 tools, stdio, env-only; `GET /v1/boards` §5.8; `AB_ROLES`); release plumbing for **v0.2.1** (trusted-publishing workflow + `docs/releasing.md`; tag/publish pending account-owner steps); OpenDevin docs; VS Code **sidebar view + host-wiring UI tests** (xvfb CI); `ab archive --git` (threads → markdown, one commit per thread); **per-agent credentials** (server-side hashes, `ab token`, identity bound to token — spec §4/§5.9); dogfooding on the board (`dev-1` on `sprint-3`, `ab whoami`); A2A bridge spike writeup. 86 vitest + 4 extension UI tests.

## 8. Roadmap

| Sprint | Scope | Status |
|---|---|---|
| 1 | Spec v0.1 · server (REST+SQLite+long-poll) · `ab` CLI · OpenCode integration · read-only dashboard (stretch) · CI | **Shipped** |
| 2 | #12 fix · broadcast fan-out (spec v0.2.0) · question deadlines · VS Code extension · npm packaging · CI Docker build · dead-letter mgmt | **Shipped** |
| 3 | MCP server (universal tool layer) · release v0.2.1 (trusted publishing) · OpenDevin docs · VS Code sidebar + UI tests · git archive · per-agent credentials · dogfood · A2A spike | **Implemented — PR open** |
| 4 | A2A relay (spike → task) · OpenDevin polish · token rotation/expiry · broadcast read-state · dashboard delivery detail · federation/encryption | Planned |

## 9. Team & Workflow

- **Producer (Remy):** plans sprints, triages, reviews & merges PRs (regular merge, never squash/rebase), maintains this brief.
- **Dev team:** implements per `docs/sprint-N/plan.md`, works on branches, opens PRs.
- **QA (Ivy):** signs off critical sprints before merge.
- Sprint artifacts: `docs/sprint-N/{plan,progress,done}.md`, signoff in `docs/qa/`.

## 10. Open Questions

1. Self-host only, or SaaS later? (v1: self-host — trust)
2. Per-agent credentials vs shared workspace token? (**RESOLVED sprint 3:** per-agent tokens minted admin-side, hashed server-side, identity bound to token — spec §5.9)
3. Git-based archive? (**RESOLVED sprint 3:** `ab archive --git`, threads → markdown, one commit per thread)
4. A2A bridge eventually? (**SPIKED sprint 3:** relay on the reference server; sprint-4 task — we remain the async layer under A2A)