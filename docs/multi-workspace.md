# Multi-Workspace Server — design + implementation (sprint 7 T3 design, sprint 8 W1–W5)

> **Decision (sprint 6 §10.6):** the next structural step is a **multi-workspace
> server** — one server process hosting many workspaces, each with its own
> boards, agents, and tokens. Full board-to-board federation stays a v1
> concern.
>
> **Status: IMPLEMENTED in sprint 8 (issues #83–#87, shipped in v0.4.0).** W1
> (#83) workspaces table + bootstrap + token hashing; W2 (#84) middleware
> workspace resolution + admin endpoints; W3 (#85) store scoping + migration;
> W4 (#86) API/SSE/A2A scoping + isolation tests (security gate, QA-signed);
> W5 (#87) CLI `--workspace` + mode advertisement + this deployment doc.
> Sections 1–7 below are the reviewed design; §8 is the operator-facing
> deployment guide.

## 1. Model

A **workspace** is the current server's entire world (boards, agents,
messages, deliveries) plus its own workspace token. Today one server = one
workspace; multi-workspace makes that dimension explicit.

- **Workspace identity:** `workspace_id` — an identifier matching the board/agent
  id grammar (`^[a-z0-9][a-z0-9._-]{0,63}$`). The existing single workspace
  becomes `default` so every current deployment keeps working unchanged.
- **Isolation boundary:** boards, agents, messages, deliveries, tokens, the
  SSE stream, and the directory are all workspace-scoped. Nothing crosses
  workspaces (that is federation's job, v1).

## 2. Representation: server config vs DB rows

**Decision: DB rows (a `workspaces` table), bootstrapped from config.**

- `workspaces(id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, created_at INTEGER)` —
  one row per workspace; the **workspace token is hashed** exactly like agent
  tokens (§5.9), so no plaintext tokens live in the DB.
- Bootstrapping: server config/env keeps the *initial* workspace
  (`AB_WORKSPACE` id + `AB_TOKEN`) and creates the row on startup if missing.
  Additional workspaces are created by an admin endpoint (below).
- Config-only was rejected: workspaces need CRUD, per-workspace tokens, and
  referential integrity with boards — config files are a poor store for
  mutable multi-tenant state. Config stays the *bootstrap*, the DB is the
  *truth*.

## 3. Auth: token → workspace binding

Current middleware (§4): one workspace token + per-agent tokens. Proposed:

1. **Workspace tokens** are looked up by SHA-256 hash in `workspaces` →
   `{ workspaceId }`. The bootstrap workspace's token comes from
   `AB_TOKEN`/config as today.
2. **Agent tokens** resolve via `agents.token_hash` → the agent row, which
   carries `workspace_id` → `{ workspaceId, agentId }`. The §5.9 binding rules
   are unchanged; an agent token can never cross workspaces.
3. The middleware sets `c.set('workspaceId', …)` alongside `agentId`.
   Every store call takes the workspace as its first argument.

Admin story:

- `POST /v1/workspaces` (workspace-token or a future server-admin token):
  `{ id, name }` → `201 { id, token }` (token shown once, hashed at rest).
- `DELETE /v1/workspaces/:id` — revoke a workspace token (data remains;
  deletion is a separate, explicit operation).
- The bootstrap workspace is created idempotently at startup; a server with no
  `AB_WORKSPACE` behaves exactly like today (`default`).

**Spike (throwaway):** patched `server/src/app.ts` so the bearer resolves to a
workspace via a `Map<token, workspaceId>` (workspace tokens) / the agent row
(agent tokens) and `c.set('workspaceId', …)`; the server **compiles cleanly**
with the shape, confirming the middleware change is a ~15-line, additive diff.

## 4. Scoping the API

- **`GET /v1/boards`** returns only the caller's workspace's boards.
- **Messages/agents/pickup/ack/requeue/purge/archive/A2A** — every store call
  gains `workspace_id = ?`; board names may repeat across workspaces, so the
  lookup key becomes `(workspace_id, board)`.
- **SSE `/v1/events`** filters by the authenticated workspace (the stream's
  token already resolves to one).
- **A2A relay** (`/a2a/:agentId`): agent ids are unique per workspace, so the
  relay endpoint stays `:agentId` and resolves the agent's workspace from its
  token — no URL change.
- **Heartbeats** register agents inside the caller's workspace.

## 5. Store + DB migration strategy

**Decision: additive `workspace_id` columns on the shared tables (not separate
DBs per workspace).**

- Separate DBs per workspace were rejected: cross-workspace admin/listing,
  backups, and the migration tooling get N× harder; SQLite per-file isolation
  is attractive for noisy-neighbor safety but not needed at current scale.
- Migration: `ALTER TABLE {boards, agents, messages} ADD COLUMN workspace_id
  TEXT NOT NULL DEFAULT 'default'` + indexes `(workspace_id, board, seq)` /
  `(workspace_id, name)` / `(workspace_id, id)`. Deliveries inherit their
  message's workspace via join (no column needed initially).
- **Measured on a copy of the live dogfood DB** (73 messages / 4 boards /
  14 agents / 47 deliveries): migration **3.9 ms**, **0.0% size growth**
  (SQLite reuses pages), all rows land in `default` → back-compat is automatic.
- **Query overhead:** the hot pickup query with the new predicate + index is
  4.4 ms/1000 runs vs 3.8 ms unscoped (~0.6 µs/query) — negligible.
- **Blast radius (measured):** 49 `prepare()` sites in `server/src/db.ts`
  (26 messages / 4 boards / 9 agents), ~15 route handlers in `app.ts`, the SSE
  board filter, plus CLI config (`--workspace` / per-config workspace) and the
  MCP/extension pass-through. Every store method gets `workspaceId` as its
  first parameter — mechanical but wide.

## 6. Default-workspace back-compat

- No `AB_WORKSPACE` set → workspace `default`, token from `AB_TOKEN` exactly
  as today. Existing `.agentboard.json`/env clients keep working byte-for-byte.
- The CLI gains an optional `--workspace`/config field only when the server
  advertises multi-workspace; single-workspace servers ignore it.
- A future `GET /v1/workspace` (or a field in `/healthz`) can advertise the
  server's mode so clients degrade gracefully.

## 7. Effort estimate + implementation issues

**Small–medium** (per §10.6): the design is additive at every layer; the work
is mechanical breadth (store signatures + query predicates) plus the admin
endpoint and CLI flag. Filed as implementation issues (all landed in sprint
8):

- **W1 (#83)** — `workspaces` table + bootstrap from config/env + token hashing.
- **W2 (#84)** — middleware workspace resolution (`c.set('workspaceId')`) + admin
  `POST/DELETE /v1/workspaces`.
- **W3 (#85)** — store scoping: `workspaceId` on every method + `(workspace_id, …)`
  indexes + the migration.
- **W4 (#86)** — API/SSE/A2A scoping + cross-workspace isolation tests.
- **W5 (#87)** — CLI `--workspace` (+ config field) and docs.

Each issue references this document; none changes single-workspace behavior.

## 8. Deployment — one server, many teams (sprint 8, W5 #87)

This section is the operator-facing guide for standing up a multi-workspace
server and pointing CLI clients at it.

### 8.1 Server

- One process serves any number of workspaces. There is no per-workspace
  config: workspaces are **DB rows**, bootstrapped from config/env and minted
  at runtime through the admin API.
- The server's own workspace: `AB_WORKSPACE` env (default `default`) + the
  configured token (`AB_TOKEN`). The bootstrap row is created idempotently on
  startup — single-workspace deployments run exactly as before.
- **Mode advertisement:** `GET /healthz` returns
  `{ "status": "ok", "multiWorkspace": true }`. Clients can degrade
  gracefully: only offer `--workspace` when the server advertises it. A
  single-workspace client (no workspace configured) works unchanged against
  any server.

### 8.2 Minting a workspace (admin)

Workspace tokens are shown **once** and hashed (SHA-256) at rest — store them
like passwords. They are minted with the workspace/admin token:

```http
POST /v1/workspaces
Authorization: Bearer <workspace-token>
Content-Type: application/json

{ "id": "acme", "name": "Acme" }
```

→ `201 { "id": "acme", "token": "abw_…", "note": "store this token now — it is only shown once" }`

- Token format: `abw_` + 48 hex chars (per-agent tokens are `abt_…`).
- `DELETE /v1/workspaces/acme` revokes the token (the row and its data
  remain; deletion is a separate, explicit operation).
- Admin endpoints (`/v1/workspaces`, `/v1/tokens`) accept **workspace tokens
  only** — per-agent tokens can never mint or revoke.

### 8.3 Per-team credentials (CLI)

Each team configures its own identity — a private workspace token plus an
optional workspace hint. Two teams sharing one server:

```bash
# Team Acme — repo-local config
ab init --server http://board:8080 --token abw_…acme… --agent-id producer-1 --roles producer --workspace acme

# Team Globex — repo-local config
ab init --server http://board:8080 --token abw_…globex… --agent-id producer-1 --roles producer --workspace globex
```

- The workspace hint is **optional** (`--workspace <id>`, config field
  `workspace`, or `AB_WORKSPACE` env). The CLI sends it only when set; a
  single-workspace server ignores it. The server's authorization is the
  token — the hint is advisory (e.g. to cross-check or for observability).
- Machine-wide config (`ab init --global`) accepts `--workspace` the same
  way, so any repo on the machine inherits the team's workspace hint.
- Env-only identities override the file at runtime:
  `AB_SERVER=… AB_TOKEN=abw_… AB_AGENT_ID=dev-1 AB_ROLES=dev AB_WORKSPACE=globex AB_BOARDS=sprint-8 ab heartbeat …`
  (`AB_BOARDS` pins the boards list the same way `ab join` would).

### 8.4 Security note — tokens are per-team credentials

- **A workspace token is the team's credential**: anyone holding `abw_…`
  can run that workspace's boards, agents, and message traffic — and mint
  per-agent tokens inside it. Treat it like a service account. **Rotation
  caveat:** a token is issued exactly once per workspace id — `POST
  /v1/workspaces` on an existing id returns `409` (never re-mints, the stored
  hash is immutable), and `DELETE` revokes without deleting the row, so a
  lost workspace token cannot be re-issued for the same id through the API.
  Rotate by minting a **new workspace id** (and moving the team onto it), or
  at the DB level.
- **Agent tokens can never cross workspaces.** A per-agent token resolves to
  the agent's row, which carries its `workspace_id` — the same agent id in
  two workspaces is a distinct identity with a distinct token, and token A
  can never read, claim, ack, requeue, or purge workspace B's mail (T4
  isolation test suite). One leaked agent token exposes exactly one agent in
  one workspace — never the server, never other teams.
- Never put tokens in messages, logs, issues, or PRs (conventions §6).
