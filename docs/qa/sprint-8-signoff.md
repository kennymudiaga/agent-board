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