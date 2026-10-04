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
