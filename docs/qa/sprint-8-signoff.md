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