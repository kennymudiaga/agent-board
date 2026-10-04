# Sprint 8 — Multi-Workspace Server (v0.4)

> Goal: one server process hosts **many workspaces** — boards, agents,
> messages, deliveries, tokens, the SSE stream, and the directory all
> workspace-scoped — with existing single-workspace deployments
> byte-for-byte unchanged (`default` workspace).

## Pre-sprint context

- v0.3.1 live (cli + mcp on npm via OIDC, GHCR, Release).
- Sprint 7 T3 delivered the reviewed design + spike (`docs/multi-workspace.md`):
  migration on a copy of the live DB **3.9 ms / 0.0% size growth**, hot pickup
  **+0.6 µs/query**, middleware ~15 additive lines; implementation issues
  **#83–#87** filed with a dependency chain.
- Decision (sprint 6 §10.6): multi-workspace server is the next structural
  step; full board-to-board federation stays a v1 concern.
- Board `sprint-8` created; `producer-1` joined; all workers offline (spawned
  per task).

## Scope

**In:**
- T1: W1 — workspaces table + bootstrap + token hashing (#83, HIGH; no
  behavior change)
- T2: W2 — middleware workspace resolution + admin endpoints (#84, HIGH)
- T3: W3 — store scoping + migration + indexes (#85, HIGH)
- T4: W4 — API/SSE/A2A scoping + cross-workspace isolation tests (#86, HIGH —
  **security gate**, independent QA sign-off)
- T5: W5 — CLI `--workspace` + server-mode advertisement + docs (#87, MEDIUM)
- T6: release v0.4.0 (#90, MEDIUM — after T1–T5 + QA sign-off)

**Out:** long-turn presence/lease ergonomics, at-rest encryption (v0.4+),
A2A `tasks/query`+SSE, GAT revocation hygiene (ops item, any time), full
federation (v1).

## Tasks

### T1 — W1: workspaces table + bootstrap + token hashing (#83) — HIGH

`docs/multi-workspace.md` §2/§7. **No behavior change until this lands.**
- `workspaces(id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, created_at INTEGER)`
  in `server/src/db.ts` + the lightweight-migration helper.
- Workspace tokens hashed SHA-256 (same as agent tokens §5.9); plaintext only
  from `AB_TOKEN`/config bootstrap.
- Startup bootstrap: `AB_WORKSPACE` (default `default`) + the configured token
  create the row idempotently if missing.
- Store: `createWorkspace`, `listWorkspaces`, `workspaceForToken`,
  `revokeWorkspaceToken`.

**Done when:** the table exists, the bootstrap workspace is created on
startup, token→workspace resolution works in unit tests, and a single-
workspace server behaves identically to today (existing tests unchanged).

### T2 — W2: middleware resolution + admin endpoints (#84) — HIGH (after T1)

`docs/multi-workspace.md` §3/§7.
- Auth middleware (`server/src/app.ts`): resolve bearer → workspace
  (workspace tokens via `workspaceForToken`; agent tokens via the agent row's
  `workspace_id`) and `c.set('workspaceId', …)`; spike-proven ~15 additive lines.
- Admin endpoints: `POST /v1/workspaces {id, name}` → `201 {id, token}` (shown
  once, hashed at rest); `DELETE /v1/workspaces/:id` revokes the token (data
  untouched). Workspace-token (admin) only.
- `Variables` type gains `workspaceId`; 401 semantics unchanged.

**Done when:** middleware tests cover workspace-token + agent-token resolution
and cross-workspace rejection; admin endpoints mint/revoke workspace tokens.

### T3 — W3: store scoping + migration + indexes (#85) — HIGH (after T1; parallel with T2)

`docs/multi-workspace.md` §5/§7.
- `ALTER TABLE {boards, agents, messages} ADD COLUMN workspace_id TEXT NOT NULL
  DEFAULT 'default'` + indexes `(workspace_id, board, seq)`, `(workspace_id, name)`,
  `(workspace_id, id)` — measured 3.9 ms / 0% growth on the live DB copy.
- Every store method takes `workspaceId` first; board lookups become
  `(workspace_id, board)`; deliveries inherit via their message's workspace.
- Blast radius: 49 `prepare()` sites (26 messages / 4 boards / 9 agents) — mechanical.

**Done when:** the migration runs on an existing DB, every store method is
workspace-scoped, and existing single-workspace tests pass unchanged (`default`).

### T4 — W4: API/SSE/A2A scoping + isolation tests (#86) — HIGH (after T2+T3) — security gate

`docs/multi-workspace.md` §4/§7.
- API surface (boards list, messages/pickup/ack/requeue/purge/archive, agents
  directory, heartbeat) filtered by the caller's workspace.
- SSE `/v1/events` filters by the authenticated workspace; A2A relay stays
  `:agentId` (ids unique per workspace; resolves via token's workspace).
- Isolation tests: two workspaces with identical board names; assert no
  message/agent/board leaks; token A cannot read or claim B's mail.
- Single-workspace deployments behave identically (workspace `default`).

**Done when:** cross-workspace isolation tests pass, full suite green, and
**independent QA sign-off** on the isolation/auth evidence.

### T5 — W5: CLI `--workspace` + mode advertisement + docs (#87) — MEDIUM (after T4)

`docs/multi-workspace.md` §6/§7.
- CLI: optional `--workspace <id>` / config field; env `AB_WORKSPACE`; the CLI
  only sends it when set (single-workspace servers ignore it).
- Advertise server mode (e.g. `multiWorkspace` on `/healthz` or
  `GET /v1/workspace`) so clients degrade gracefully.
- Docs: multi-workspace deployment (one server, many tokens),
  `.agentboard.json`/`ab init --global` guidance, security note (workspace
  tokens are per-team credentials).

**Done when:** a multi-workspace server serves two teams from one process with
the CLI, and single-workspace clients need no changes.

### T6 — release v0.4.0 (#90) — MEDIUM (after T1–T5 merged + QA sign-off)

- Version bumps (cli, mcp, spec header), CI green.
- Tag → OIDC publish (cli + mcp, npm provenance) → GHCR `v0.4.0`+`latest` →
  GitHub Release notes (multi-workspace server).
- Clean-machine verify (`ab --version`, `ab setup --dry-run`, GHCR pull).

**Done when:** v0.4.0 live + verified. Human approval required before publish.

## Acceptance

1. One server process serves two workspaces with identical board names; no
   cross-workspace leaks in boards/agents/messages/SSE/directory; token A
   cannot read or claim B's mail (isolation tests + QA sign-off).
2. Existing single-workspace deployments behave identically: current tests
   pass unchanged; live dogfood DB migrates cleanly (3.9 ms class).
3. Workspace tokens hashed at rest; admin `POST/DELETE /v1/workspaces`
   mint/revoke; per-agent tokens cannot cross workspaces.
4. CLI: `--workspace`/`AB_WORKSPACE` optional and only sent when set; server
   mode advertised; docs updated.
5. v0.4.0 released with provenance + verified.

## Definition of Done

T1–T5 merged with CI (QA sign-off on T4); T6 released and verified;
`docs/sprint-8/progress.md`/`done.md`; `PROJECT_BRIEF.md` §7/§8 updated;
issues #83–#87 + #90 closed; worktrees cleaned up.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 8. Goal: **multi-workspace server
> (v0.4)**. Read `PROJECT_BRIEF.md`, `docs/sprint-8/plan.md`,
> `docs/multi-workspace.md`, and issues #83–#87 first. Work in order
> T1 → (T2 ‖ T3) → T4 → T5. T1 lands first (no behavior change); T2 and T3 run
> in parallel after it; T4 is the security gate — isolation tests + QA
> sign-off before T5/release. Work in YOUR worktree (`spawn/<agentId>`), never
> the main checkout (one writer per checkout). Each task: branch off `main`,
> PR with passing CI, reference its issue. Report through the board
> (`sprint-8`) and `docs/sprint-8/progress.md`.