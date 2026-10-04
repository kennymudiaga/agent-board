# Sprint 8 — QA Sign-off

> QA-gated tasks per `docs/sprint-8/plan.md`. Verdicts appended per task as
> they complete. T1 is the first QA-gated task (per `docs/sprint-8/plan.md`,
> T6 release also gates on QA sign-off of T4).

## T1 — W1 workspaces table + bootstrap + token hashing (PR #91, issue #83)

- **QA:** spawned worker `qa-3` (branch `review/pr-91` =
  `origin/feat/workspaces-83`, PR #91 head; base `e616062`).
- **Verdict: PASS** — no blocking findings.
- **Scope reviewed:** `server/src/db.ts` (schema + 5 store methods),
  `server/src/index.ts` (startup bootstrap), `server/test/workspaces.test.ts`
  (7 new tests), `docs/sprint-8/progress.md`.

### Evidence

1. **Table + methods match design** (`docs/multi-workspace.md` §2/§7): schema
   `workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT,
   created_at INTEGER NOT NULL)` created via `CREATE TABLE IF NOT EXISTS`
   (lightweight migration — no column-ALTER needed for a new table).
   `createWorkspace` = `INSERT OR IGNORE` returning `{workspace, created}`
   (`created` = `info.changes > 0`); `listWorkspaces` = `ORDER BY id ASC`;
   `workspaceForToken` = SHA-256 hash lookup (mirrors agent-token §5.9),
   `null` on miss; `revokeWorkspaceToken` = clears hash, row remains;
   `bootstrapWorkspace` = idempotent bootstrap wrapper.
2. **Hash invariant:** unit test inserts a raw `'plaintext-token'` directly
   into `token_hash` and asserts `workspaceForToken('plaintext-token')` is
   `null` (lookups always hash the bearer — a raw token in the column never
   resolves). Live: fresh-DB startup shows `token_hash` =
   `sha256(<token>)`, no plaintext anywhere at rest.
3. **Bootstrap idempotency:** unit test + live restart — boot with
   `AB_TOKEN=smoke-token-a`, restart with `smoke-token-b`: row untouched
   (hash remains `sha256(smoke-token-a)`), `b` does not resolve. No rotation
   on restart.
4. **Default-token consistency:** `server/src/index.ts` bootstraps
   `AB_TOKEN ?? 'dev-token'`; `server/src/app.ts:80` `opts.token ??
   process.env.AB_TOKEN ?? 'dev-token'`. `index.ts` calls `createApp(store)`
   with no opts → effective auth token === bootstrap token. Live default boot
   (no env): heartbeat + boards list with `dev-token` succeed, row hash =
   `sha256('dev-token')`.
5. **No single-workspace behavior change:** canonical `npm test` at repo
   root on PR head → **147/147 (14 files)**; baseline `main` `e616062` in a
   scratch worktree → **140/140 (13 files)**. Delta is exactly the 7 new
   `workspaces` tests; all 140 pre-existing tests pass unchanged. Auth
   middleware/git-ignored config untouched by the diff (additive only).
   Live legacy-DB boot (pre-T1 schema with 1 board + 1 agent): server starts,
   `/healthz` ok, `workspaces` table auto-added, `default` row bootstrapped,
   legacy board/agent intact and served via API with `dev-token`.
   `npm run build` clean.
6. **CI green:** `gh pr checks 91` → build-and-test ✅, docker ✅,
   extension-ui ✅.
7. **Edge cases:** revoke stops resolution (hash cleared → lookups `null`,
   unit test); `INSERT OR IGNORE` never clobbers (same id → `created:false`,
   name + token hash preserved, unit test + live restart).

### Findings

- **Blocking:** none.
- **Non-blocking (informational, W2-bound):** `workspaceForToken` is not yet
  consumed by the auth middleware — `app.ts` still compares the plaintext
  bearer to the configured token. That is *by design* for T1 (middleware
  workspace resolution is T2/#84); no behavior change and no security gap at
  this stage. Watch in T2 review that the middleware switches to the hash
  lookup once multi-workspace auth lands.
- **Non-blocking:** `createWorkspace` defaults `name` to the id when omitted
  (design: `name TEXT NOT NULL`) — reasonable; matches the unit test's
  expectation.

## T2 — W2 middleware workspace resolution + admin workspace endpoints (PR #94, issue #84)

- **QA:** spawned worker `qa-4` (branch `review/pr-94` =
  `origin/feat/workspaces-84` head `1f91715`; base `main` incl. `3cd3519` +
  `d92ea62`).
- **Verdict: PASS** — no blocking findings.
- **Scope reviewed:** `server/src/app.ts` (auth middleware + admin routes +
  SSE), `server/src/db.ts` (`workspaceForToken`, `workspaceForAgent`,
  `mintWorkspaceToken`, `revokeWorkspaceToken`, `bootstrapWorkspace`),
  `server/test/workspaces-admin.test.ts` (9 new tests), `docs/sprint-8/progress.md`.

### Evidence

1. **Middleware resolves every bearer via SHA-256** (`app.ts:101-158`): the
   plaintext compare against the configured token is gone. Workspace tokens →
   `store.workspaceForToken(bearer)` (hash lookup, `db.ts:402-406`); on hit,
   `c.set('workspaceId', ws.id)` and admin prefixes (`/v1/tokens`,
   `/v1/workspaces`) proceed **workspace-token only**. Agent tokens →
   `store.tokenAgent(bearer)` + `c.set('workspaceId',
   store.workspaceForAgent(agentId))` = `'default'` until W3 (#85); an agent
   token on an admin path returns 401 `workspace token required for admin
   endpoints`; X-Agent-ID mismatch 401s (impersonation impossible). SSE
   `/v1/events` (`app.ts:241-248`) authenticates the query/header token via
   the same `workspaceForToken` hash lookup; missing/invalid → 401.
2. **Back-compat (single-workspace deployments):** canonical `npm test` at
   repo root on PR head **1f91715** → **156 tests: 155 pass / 1 known flake**
   (below). `workspaces-admin.test.ts` contributes the 9 new tests;
   `workspaces.test.ts` (7) and all pre-existing suites pass unchanged —
   delta matches baseline 147 → 156. `npm run build` clean.
3. **Admin endpoints** (`app.ts:320-346`): POST `/v1/workspaces` validates id
   (ID_RE) and name (1..128) → 422; mints once via `mintWorkspaceToken` —
   `abw_` + 48 hex, SHA-256 hashed at rest, plaintext shown once in the 201
   response; duplicate id → 409 (`workspace_exists`, never re-mints); the
   minted token works as a workspace credential. DELETE `/v1/workspaces/:id`:
   invalid id → 422, unknown → 404, known → revokes (clears `token_hash`,
   **row remains** — data untouched); revoked token 401s immediately.
4. **Legacy-DB boot:** `createApp` bootstraps the configured workspace
   (`AB_WORKSPACE` ?? `default`) idempotently via `INSERT OR IGNORE`
   (`bootstrapWorkspace`) — existing row never clobbered, no rotation on
   restart; the app's own token (`AB_TOKEN` ?? `dev-token`) resolves through
   the hash lookup (test 1: heartbeat 200, `token_hash` = sha256(token), no
   plaintext at rest). Custom `workspaceId` bootstraps that workspace instead
   (test 2).
5. **Admin-scope nuance (design §3):** any workspace token is admin-capable —
   by design (workspace token = admin credential; a future server-admin
   token). Cross-workspace probe: alpha's token cannot mint `beta` once it
   exists (409) — admin reach is bounded by workspace existence. True
   cross-workspace isolation is W3/W4 (#85); **I agree with the design, no
   flag.**
6. **CI green:** `gh pr checks 94` → build-and-test ✅, docker ✅,
   extension-ui ✅. PR #94 open, MERGEABLE.

## T3 — W3 store scoping + migration + indexes (PR #95, issue #85)

- **QA:** spawned worker `qa-5` (branch `review/pr-95` =
  `origin/feat/store-scoping-85`, PR #95 head `a86f7c1`, exactly the 2 PR
  commits `d799f8c` feat + `a86f7c1` docs; base pre-T2 `main` — per-request
  `workspaceId` wiring is T4's job, so only the `'default'` constant path was
  in scope).
- **Verdict: PASS** — no blocking findings; back-compat and scoping evidence
  below. Follow-ups are T4-bound (not reachable on this branch).
- **Scope reviewed:** `server/src/db.ts` (schema + migration + 19 scoped
  methods), `server/src/app.ts` + `server/src/a2a.ts` + `server/src/index.ts`
  (call sites), `server/test/workspace-scoping.test.ts` (5 new tests),
  `mcp/test/tools.test.js` (blast-radius fix), `docs/sprint-8/progress.md`
  (a86f7c1).

### Evidence

1. **Migration on an existing DB (independent, 30/30 checks):** constructed a
   legacy-schema DB seeded to the live-dogfood shape (4 boards / 14 agents /
   73 messages / 47 deliveries) and opened it through `Store`. `workspace_id
   TEXT NOT NULL DEFAULT 'default'` added to `{boards, agents, messages}` via
   the additive `ensureColumn` helper; a check on all three tables shows
   **every row in `'default'` (0 non-default)**. Scoped lookups correct:
   `boardExists('default','board-a')` true, `boardExists('other-ws','board-a')`
   false, `getAgent('other-ws','agent-00')` undefined, `listMessages('default',
   'board-a')` = 19, `listBoards('default')` = 4 boards with message counts
   intact. Fresh DBs get composite PKs `(workspace_id, name)` on boards and
   `(workspace_id, id)` on agents; messages keep `id` PK (ids globally unique
   — correct per design).
2. **Indexes:** `idx_messages_ws_board_seq`, `idx_boards_ws_name`,
   `idx_agents_ws_id`, `idx_workspaces_token_hash` present on **both** fresh
   and migrated DBs; on fresh DBs `idx_messages_idem` is the workspace-scoped
   unique index `(workspace_id, from_agent, idempotency_key)`. dev-5's
   documented boundary **confirmed**: migrated legacy DBs keep the old
   `(from_agent, idempotency_key)` index (same name, `IF NOT EXISTS` skips).
   Probe: on a migrated DB, inserting the same `(from_agent, idempotency_key)`
   in a second workspace throws `UNIQUE constraint failed:
   messages.from_agent, messages.idempotency_key`; the same probe on a fresh
   DB succeeds. **Assessment: non-blocking** — the only workspace reachable on
   this branch is `'default'`, so the old global index cannot misbehave before
   T4. It becomes a real (narrow) constraint only for a multi-workspace
   deployment grown *from a migrated legacy DB* where two workspaces use the
   same agent id with the same idempotency key — then `insertMessage` would
   500 on the UNIQUE violation. Fix is a one-line migration addition
   (`DROP INDEX IF EXISTS idx_messages_idem` before the workspace-scoped
   create; safe because all legacy rows are in `'default'`).
3. **Store scoping:** every store data method takes `workspaceId` first
   (verified all 19 public method signatures); board lookups are
   `(workspace_id, board)`; deliveries inherit their message's workspace via
   the broadcast-member join (`workspace_id` + `json_each` on the member's
   boards) and `listBoards` joins `m.workspace_id = b.workspace_id`; id-based
   lookups are cross-workspace invisible (`getMessage('globex', acmeId)` →
   undefined; ack/delete against the wrong workspace → `notFound`). All
   `prepare()` sites in `db.ts` scoped (54 lines contain `prepare(` — the
   design's "49 sites" estimate is the same class; message/board/agent methods
   are the 26/4/9 split). Call sites verified in `app.ts` (14), `a2a.ts` (9)
   and `index.ts` (createApp now passes `workspaceId` from `AB_WORKSPACE`,
   default `'default'`); no stale old-signature call sites remain (build +
   grep).
4. **Back-compat:** canonical `npm test` at repo root on PR head →
   **152/152 (15 files)** = 147 unchanged + 5 new
   `server/test/workspace-scoping.test.ts` (legacy migration, index existence,
   same board/agent across 2 workspaces, isolation, role/reader scoping). `npm
   run build` (`tsc`) clean; `ab setup --check` up to date (11 files).
5. **Blast-radius fix:** `mcp/test/tools.test.js` cleanup now calls
   `deleteMessage('default', row.id, 'mcp-agent')` — correct: the MCP app is
   `createApp(store, { token })` with no `workspaceId`, i.e. workspace
   `'default'` (verified in `mcp/test/tools.test.js` + `e2e.test.js`, both
   pass).
6. **CI green:** `gh pr checks 95` → build-and-test ✅, docker ✅,
   extension-ui ✅. PR #95 open, base `main`, head `a86f7c1` = my checkout,
   mergeable.

### Findings

- **Blocking:** none.
- **Non-blocking (pre-existing, unrelated to PR #94):** `cli/test/cli.test.js`
  "archive exports the board to markdown with one commit per thread (T5)"
  times out at the default 5 s per-test cap — it takes ~5.1 s. Re-verified:
  `vitest run cli/test/cli.test.js -t "archive exports the board"
  --testTimeout 15000` → **PASS (5137 ms)**. Deterministic near-threshold
  timing flake in the CLI archive test (no workspace code involved);
  recommend raising that test's timeout to ~10 s in a later cleanup.
- **Non-blocking (informational):** `workspaceForAgent` hardcodes `'default'`
  until W3 (#85) and any workspace token is admin-capable per design §3 —
  both by design for W2; revisit when W3/W4 land.
- **Non-blocking (T4-bound, same class as dev-5's documented boundary):**
  migrated legacy DBs keep two single-workspace-shaped uniqueness constraints:
  (a) the old `(from_agent, idempotency_key)` idempotency index (probe above),
  and (b) the single-column `agents.id` PK — `upsertAgent`'s bare
  `ON CONFLICT DO UPDATE` on a migrated DB keys agents by `id` only, so a
  second workspace registering the same agent id post-T4 would overwrite the
  first workspace's row (its `workspace_id` never changes — the update SET
  list omits it — but its roles/boards/status would be hijacked). Both are
  unreachable until T4 wires per-request workspaces + T2 creates real
  workspaces; neither affects single-workspace behavior (verified). Recommend
  T4 handle migrated-DB multi-workspace safely: either rebuild the three
  tables' keys in the migration path (`DROP INDEX` + table-rebuild recipe) or
  refuse non-`'default'` writes on legacy-schema DBs until rebuilt.
- **Non-blocking (measurement):** migration measured **avg 7.8 ms (7.4–8.2,
  3 runs) and +24 KB (+35% on the 68 KB fixture)** on a checkpointed file
  versus the design's 3.9 ms / 0.0% — dev-5's 8.5 ms / +24 KB is confirmed.
  The design's 0.0% was measured pre-checkpoint (WAL-buffered; my first run
  reproduced 0.0% before `close()`). Honest read: single-digit-ms, +24 KB — a
  one-time startup cost in the "3.9 ms class" the acceptance criterion asks
  for; not blocking. Hot-path pickup overhead (+0.6 µs/query, design §5) not
  re-measured — no new per-query joins on the hot path beyond the index-backed
  `workspace_id` predicate (+1 indexed column).
- **Non-blocking (informational):** `messages.seq` remains a global sequence
  (unchanged from v0.3, still `UNIQUE`) — correct for isolation (no seq
  collisions across workspaces), though cross-workspace seq gaps are a
  cosmetic quirk only.

## T4 — W4 API/SSE/A2A scoping + isolation tests — SECURITY GATE (PR #96, issue #86)

- **QA:** spawned worker `qa-6` (branch `review/pr-96` = `origin/feat/isolation-86`
  head `dffa490`, commits `e251926` + `44478ad` + `dffa490`; base `main` `4c64a61`).
- **Verdict: PASS** — no blocking findings. Security gate clears: no genuine
  isolation leaks across workspaces; legacy-DB hardening (qa-5 T3 findings a/b)
  verified; full back-compat preserved (170/170).
- **Scope reviewed:** `server/src/app.ts` (per-request scoping), `server/src/db.ts`
  (`tokenAgent`/`workspaceForAgent` + legacy hardening), `server/src/a2a.ts`
  (relay/card workspace resolution), `server/src/index.ts`, `server/test/isolation.test.ts`
  (6 new), `server/test/workspace-scoping.test.ts` (3 new hardening tests),
  `docs/sprint-8/progress.md`.

### Evidence

1. **Per-request scoping (`app.ts`).** Every authenticated route scopes the
   caller's workspace from the T2 middleware via `c.get('workspaceId')`
   (grep: boards, messages/pickup/ack/requeue/purge, agents directory,
   heartbeat, mint/revoke token, SSE). The bare `opts.workspaceId` constant
   survives at exactly two sites — `store.bootstrapWorkspace(workspaceId, token)`
   (line 103) and `createA2ARoutes(..., workspaceId)` (line 622, the
   identity-less card fallback) — matching the acceptance criterion. Middleware:
   workspace token → `workspaceForToken(bearer)` → `c.set('workspaceId', ws.id)`;
   agent token → `tokenAgent(bearer)` → `c.set('workspaceId', tokenAgent.workspaceId)`
   — always the token's OWN row.
2. **Token-bound resolution (`db.ts`).** `tokenAgent(bearer)` now selects
   `id, workspace_id, token_expires_at` and returns `{ agentId, workspaceId,
   expired }`; `workspaceForAgent` reads `agents.workspace_id` (T2 `'default'`
   stub gone). Probes: two tokens minted for the same `dev-1` in `acme` and
   `globex` resolve to `acme` / `globex` respectively (never ambiguous);
   `workspaceForAgent('dev-1')` with rows in both returns one of the real
   rows' workspaces (row read, not the stub).
3. **SSE `/v1/events`.** Stream authenticated via `workspaceForToken` (hash
   lookup; missing/invalid → 401); `hello` gains `"workspace":"<ws>"` (probe:
   acme stream hello carries `"workspace":"acme"`); `message`/`updated`/`agent`
   emitters carry the workspace and the stream filters on it. Probe beyond the
   suite: after an acme `message` event flows, a **globex post to the same
   board name produces no stream event** (400 ms silence window, single
   reader) — no cross-workspace feed.
4. **A2A (`a2a.ts`).** JSON-RPC relay resolves its task space from the caller's
   agent-token row (`bound.workspaceId`) — a token can never address another
   workspace's board/threads; suite asserts cross-workspace `tasks/get` →
   `-32002` TASK_NOT_FOUND both directions. Cards (`/a2a/:agentId` +
   `/.well-known/agent.json`): `resolveWorkspace` uses token-if-present else
   the server's configured workspace fallback. Probes: card with acme's
   `dev-1` token → boards `['team-a']`; with globex's token → `['team-g']`
   (per-token workspace resolution works); identity-less GET → falls back to
   `'default'`, returns an **empty card** (agent lives elsewhere). **Assessed
   against design §4 — non-blocking:** cards are public, identity-less
   observability (name/description/boards/roles only — no tokens, no message
   content); an anonymous reader only ever sees the server-own-workspace
   surface, exactly as a single-workspace deployment does today. No leak.
5. **Isolation suite + beyond.** The 6 `isolation.test.ts` tests pass:
   identical board names + identical agent ids in two workspaces — no
   board/agent/message/directory leaks in either direction; same agent id =
   distinct identity per token (heartbeat `workspaceId` = own ws; rows are
   distinct, `SELECT COUNT(*) WHERE id='dev-1'` = 2); token A cannot
   read/ack/requeue/purge B's mail — cross-workspace 404 on every id route
   including a same-id agent token from B; role/reader scoping (same role
   name, other ws never claims); SSE feeds only the authenticated workspace;
   A2A tasks invisible cross-workspace (`-32002`) with per-workspace board
   counts. Beyond the suite (11 independent probes, all green): **reverse**
   direction 404s (acme token on globex mail — ack/requeue/purge 404, same-id
   acme agent token 404, globex's own token still claims+acks its mail 200);
   board-route leak (acme `GET /v1/boards/team-b/messages` → 404 unknown
   board, boards list scoped); fresh-DB same-(agent, idempotency_key) across
   workspaces both insert, same-ws dedupe intact.
6. **Legacy hardening (qa-5 findings).** (a) `DROP INDEX IF EXISTS
   idx_messages_idem` runs in the constructor **before** the workspace-scoped
   recreate (`WORKSPACE_INDEXES`); on a migrated DB the surviving
   `idx_messages_idem` SQL is `(workspace_id, from_agent, idempotency_key)`;
   probe: cross-workspace same-(agent,key) insert succeeds (pre-T4 this was a
   UNIQUE 500), same-workspace dedupe returns `duplicate`. (b) `rebuildLegacyKeys()`
   rebuilds `boards`/`agents` onto `PRIMARY KEY (workspace_id, name|id)` when
   the migrated PK is single-column (PRAGMA-introspected, column defs
   re-emitted, per-column NOT NULL/DEFAULT preserved); data survives (row
   count + content + scoped lookups intact). **Transactional rollback
   (independent injection):** a legacy DB carrying a column whose PRAGMA-echoed
   type (`varchar(5`, from `"varchar(5"`) makes the rebuild's CREATE TABLE fail
   **after** BEGIN+RENAME executed — `new Store(path)` throws loudly; a fresh
   connection then shows `boards` still `PRIMARY KEY (name)` with its row
   intact and **no `boards_legacy` half-state**; the same-batch pattern
   reproduced on one connection proves ROLLBACK restores the pre-rebuild table
   and closes the transaction. Second injection (poison on `agents`): `boards`
   rebuild COMMITS (composite PK), `agents` rebuild rolls back (legacy PK
   kept); after removing the poison the DB opens and migrates cleanly.
   **Fresh DB skipped:** fresh stores show composite PKs, no `_legacy` tables,
   same board/agent ids across workspaces coexist. **B cannot hijack A's
   same-id row:** `upsertAgent('acme'/'globex', 'a-1', …)` on a migrated DB
   keeps both rows' roles/boards distinct; `mintToken` resolves each token to
   its own workspace.
7. **Back-compat.** Canonical `npm test` at repo root on `dffa490` →
   **170/170 (17 files)** = 161 baseline unchanged + 9 new (6 isolation + 3
   legacy hardening). `npm run build` (`tsc`) clean. `ab setup --check` up to
   date (11 files). Single-workspace behavior unchanged — every pre-existing
   suite (incl. cli + mcp against `default`) passes untouched.
8. **CI green:** `gh pr checks 96` → build-and-test ✅, docker ✅,
   extension-ui ✅. PR #96 open, base `main`, head `dffa490` = my checkout,
   MERGEABLE.

### Findings

- **Blocking:** none. **Verdict: PASS** — recommend merge + close #86 after
  merge (v0.4.0 release gate clears on this task).
- **Non-blocking (informational):** the A2A identity-less card fallback
  resolves to the server's own workspace (design §4, documented known
  limitation in the PR) — verified non-leaking (empty card when the agent
  lives elsewhere; cards carry no secrets).
- **Non-blocking (informational):** `workspaceForAgent(agentId)` is a bare-id
  lookup and is documented as ambiguous when the same id exists in two
  workspaces — all auth paths (middleware, A2A relay) correctly use
  `tokenAgent().workspaceId`; no caller uses the ambiguous path for auth.
- **Non-blocking (robustness):** the table-rebuild preserves per-column
  NOT NULL/DEFAULT but not table-level constraints (CHECK/UNIQUE) — the
  shipped v0.3.1 schema has none, so no practical impact; a hand-modified
  legacy schema could lose such constraints during the one-time rebuild.
- **Non-blocking (robustness):** when `rebuildLegacyKeys` throws, the
  `Store` constructor fails loudly (correct — startup aborts) but leaves
  `this.db` open until GC/process exit (no `finally`-close); cosmetic on the
  failure path only, unreachable on healthy DBs.
- **Non-blocking (informational):** the SSE route continues to authenticate
  workspace tokens only (agent tokens 401) — unchanged T2 semantics, fine for
  the dashboard surface; agent-token SSE observers are not a requirement.

## T5 — W5 CLI `--workspace` + mode advertisement + deployment docs (PR #98, issue #87; #93 a/b/c)

- **QA:** spawned worker `qa-7` (branch `review/pr-98` =
  `origin/feat/cli-workspace-87` head `8e36852`; base `main` `9aa8c26`). Note:
  the ambient `ab` on this machine is the **global 0.3.1 build** — it does not
  carry `--workspace`. All CLI probes below ran the **PR's own CLI**
  (`node cli/bin/ab.js`), so they exercise the diff, not the global binary.
- **Verdict: PASS** — no blocking findings. The `x-workspace-id` header is
  advisory-only and is **not a leak** (design intent, confirmed below).
- **Scope reviewed:** `cli/src/api.js` (header), `cli/src/config.js`
  (workspace/boards resolution + persistence), `cli/src/index.js` (usage),
  `cli/src/commands.js` (`init --workspace`, `whoami`, `spawnWorker` +
  `AB_BOARD`), `cli/test/cli.test.js` + `setup.test.js`, `server/src/app.ts`
  (`/healthz`), `server/test/workspaces-admin.test.ts` (+2), `server/Dockerfile`
  (healthcheck), `docs/multi-workspace.md` §8, `docs/sprint-8/progress.md`.

### Evidence

1. **Suite (repo root, PR head `8e36852`):** `npm test` → **176/176 (17
   files)** = 170 baseline unchanged + 6 new (4 CLI: init persists + whoami +
   env-wins, header only-when-set via capture server, AB_BOARDS override,
   two-teams-one-process E2E; 2 server: healthz advertisement + minted-second-
   workspace reachable). `npm run build` (`tsc`) clean; `ab setup --check` up
   to date (11 files). CI green: `gh pr checks 98` → build-and-test ✅, docker
   ✅, extension-ui ✅; PR `{state: OPEN, mergeable: MERGEABLE, head: 8e36852}`.
2. **CLI probes (worktree-scoped `scratch/`, PR CLI, ambient AB_* scrubbed):**
   `ab init --workspace acme` → `.agentboard.json` gains `"workspace": "acme"`
   (persisted) and `whoami` reports `workspace: acme` (JSON + text).
   `AB_WORKSPACE=globex` env → `whoami` reports `globex` with
   `env.workspace=true` and the **file stays `acme`** (env/global overrides are
   session-scoped, never written — verified in `config.js` `fileValues`
   persistence + probe). `ab init --global --workspace globex` (sandboxed
   `APPDATA`) → global `config.json` gains `"workspace": "globex"` (§8.3 claim
   holds for machine-wide config). `AB_BOARDS=alpha,beta` env → `whoami`
   reports `boards: [alpha,beta]` with `env.boards=true`; file boards list
   untouched (also covered by the suite's `AB_BOARDS overrides… (#93c)` test).
3. **Header only-when-set:** the capture-server test (`cli/test/cli.test.js`
   "the CLI sends the workspace hint only when configured (#87)") proves three
   states against a recording HTTP server: no flag/config/env → **no**
   `x-workspace-id` header; `AB_WORKSPACE` env → header present; config field
   (`init --workspace`) → header present. `cli/src/api.js` sends the header
   only under `if (cfg.workspace)`.
4. **Advisory-header assessment (acceptance item 6):** `x-workspace-id` is
   **purely advisory** — grep of `server/src` finds **zero** references to
   `x-workspace-id`; the server authorizes solely by the bearer token
   (`workspaceForToken` SHA-256 lookup, T2 middleware). The header discloses
   nothing the token doesn't already bind (the caller's workspace), carries no
   secret, and is ignored by the server entirely. Matching docs §8.3 ("the hint
   is advisory — e.g. to cross-check or for observability"). **Not a leak —
   design intent confirmed.**
5. **Mode advertisement:** `/healthz` → `{status:"ok", multiWorkspace:true}`
   (server test asserts 200 + `toMatchObject`). Docker healthcheck
   (`server/Dockerfile`) only evaluates `r.ok`
   (`fetch(...).then(r=>process.exit(r.ok?0:1))`) — the extra field is
   invisible to it. Live-localhost note: the ambient dev server on :8080 runs a
   pre-T5 binary (`{"status":"ok"}` only) — not evidence against the PR; the
   hermetic server test above is the authoritative check.
6. **#93 items:** (a) `cmdSpawn` child env gains `AB_BOARD` (commands.js);
   wake-plugin binding needs no join round-trip. (b) `spawnWorker` spawns
   **detached + `stdio:'ignore'`** on **both** win32 (`cmd.exe /d /s /c`) and
   POSIX (plain `opencode` exec) — a clean `ab spawn` exit can no longer kill
   the worker via EPIPE (the shared `/d /s /c` quoting is preserved). (c)
   `AB_BOARDS` env override — evidence in (2).
7. **Docs §8 cross-check** (`docs/multi-workspace.md` §8 vs `server/src/app.ts`
   + `db.ts` + `cli/src/commands.js`): §8.1 server (one process, `AB_WORKSPACE`
   default `'default'`, healthz) — accurate. §8.2 minting: `POST
   /v1/workspaces` → 201 `{id, token: abw_…, note}` with `abw_` + 48 hex
   (`db.ts mintWorkspaceToken`: 24 random bytes → 48 hex), token shown once +
   SHA-256 at rest, duplicate → 409; `DELETE /v1/workspaces/:id` revokes
   (clears hash, row + data remain); admin endpoints accept workspace tokens
   only; per-agent tokens are `abt_…` (db.ts) — all accurate. §8.3 per-team
   CLI: `ab init --workspace` / `--global --workspace`, hint optional + sent
   only when set, env-only identity example (`AB_WORKSPACE`, `AB_BOARDS`) —
   accurate (probes (2)). §8.4 security note — **one inaccuracy**, below.

### Findings

- **Blocking:** none. **Verdict: PASS** — recommend merge + close #87 (release
  gate T6 v0.4.0 is the only remaining gate).
- **Non-blocking (docs accuracy, §8.4):** "rotate by re-minting (`POST` again
  atomically replaces the stored hash)" is **inaccurate**. The code never
  re-mints: `POST /v1/workspaces` on an existing id → 409 `workspace_exists`
  (`mintWorkspaceToken` returns `null` when the row exists; `createWorkspace`
  is `INSERT OR IGNORE` — an existing row's hash is never clobbered), and
  `DELETE` revokes **without removing the row**, so revoke-then-re-POST also
  409s. A lost workspace token cannot be re-issued for the same id through the
  API — minting a *new* workspace id (or a DB-level intervention) is the only
  rotation path. The *behavior* is the secure default (tokens shown exactly
  once, never replaced), so this is a **docs fix**, not a code fix: suggest
  rewording §8.4 to "a minted workspace token is shown exactly once and is
  never re-issued for the same id — POST on an existing id is rejected (409);
  rotate by minting a new workspace id (e.g. `acme-2`) or by DB-level
  intervention after revoke."
- **Non-blocking (test coverage, #93b):** `spawnWorker`'s `detached +
  stdio:'ignore'` fix is verified by code review only — no hermetic unit test
  pins the spawn options (the suite's spawn tests cover dry-run/validation/
  worktree). Low risk (two-line option change on a non-hot path), but a small
  unit test asserting the resolved spawn opts would lock the EPIPE fix in.
