# Multi-Workspace Server — design + spike (sprint 7 T3, issue #79)

> **Decision (sprint 6 §10.6):** the next structural step is a **multi-workspace
> server** — one server process hosting many workspaces, each with its own
> boards, agents, and tokens. Full board-to-board federation stays a v1
> concern. This document is the reviewed design; implementation issues are
> filed for the next sprint. **No production behavior changes here.**

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
endpoint and CLI flag. Filed for the next sprint:

- **W1 (#83)** — `workspaces` table + bootstrap from config/env + token hashing.
- **W2 (#84)** — middleware workspace resolution (`c.set('workspaceId')`) + admin
  `POST/DELETE /v1/workspaces`.
- **W3 (#85)** — store scoping: `workspaceId` on every method + `(workspace_id, …)`
  indexes + the migration.
- **W4 (#86)** — API/SSE/A2A scoping + cross-workspace isolation tests.
- **W5 (#87)** — CLI `--workspace` (+ config field) and docs.

Each issue references this document; none changes single-workspace behavior.
