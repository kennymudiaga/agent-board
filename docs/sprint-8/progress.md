# Sprint 8 — Progress (Multi-Workspace Server)

> Updated: 2026-10-04. Plan: `docs/sprint-8/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — W1 workspaces table + bootstrap (#83) | **MERGED + QA PASS** | PR [#91](https://github.com/kennymudiaga/agent-board/pull/91) (merge `3cd3519`); independent QA: **PASS** — `docs/qa/sprint-8-signoff.md` (via PR [#92](https://github.com/kennymudiaga/agent-board/pull/92)); #83 closed |
| T2 — W2 middleware + admin endpoints (#84) | **dispatched** | request `s8-t2` → `agent:dev-4` (branch `feat/workspaces-84`) |
| T3 — W3 store scoping + migration (#85) | **dispatched** | request `s8-t3` → `agent:dev-5` (spawned, branch `feat/store-scoping-85`) |
| T4 — W4 API/SSE/A2A scoping + isolation tests (#86) | pending (after T2+T3) | |
| T5 — W5 CLI `--workspace` + docs (#87) | pending (after T4) | |
| T6 — release v0.4.0 (#90) | pending (after T1–T5 + QA) | |

## Verification record

- **T1 (dev-4, 2026-10-04):** `workspaces(id, name, token_hash, created_at)` in `server/src/db.ts` SCHEMA (CREATE TABLE IF NOT EXISTS — no column migration needed for a new table); store methods `createWorkspace` (idempotent INSERT OR IGNORE, returns `{workspace, created}`), `listWorkspaces`, `workspaceForToken` (SHA-256 hash lookup, mirrors agent §5.9), `revokeWorkspaceToken`, `bootstrapWorkspace`; `server/src/index.ts` bootstraps `AB_WORKSPACE` (default `default`) + `AB_TOKEN` (default `dev-token`) idempotently at startup (existing rows untouched — no rotation). Evidence: `npm test` 147/147 (14 files; was 140 — existing tests unchanged), `npm run build` clean, live smoke test verified row + hash + no boards created. dev-4 (spawned worker) died after claiming `s8-t1`; session resumed as dev-4, claim renewed, work delivered on branch `feat/workspaces-83`.
- **T1 QA (qa-3, spawned, 2026-10-04):** independent review of PR #91 → **PASS**, no blockers. Baseline-vs-PR suite delta (140/140 → 147/147 = exactly the 7 new tests); hash invariant (raw token in `token_hash` never resolves); bootstrap idempotency (no rotation on restart); default-token consistency (`index.ts` ⇄ `app.ts` both `AB_TOKEN ?? 'dev-token'`); live legacy-DB boot (pre-T1 schema migrated, `default` row seeded, legacy board/agent intact). Non-blocking W2-bound note: middleware must switch to `workspaceForToken` hash lookup (that is T2's job). Sign-off: `docs/qa/sprint-8-signoff.md`.

## Dogfood findings (sprint 8)

- **Spawned worker died mid-turn (dev-4, T1)** after claiming `s8-t1` — work was resumed by a fresh dev-4 session (config re-init, claim renewed, delivered). Cause unconfirmed (headless `opencode run`); candidates: permission auto-reject loop or provider/model failure. Watch daemon + visible-session spawn would make this observable (see follow-up ideas).
- **Producer did not wake on the T1 response** — no `ab watch` was running for `producer-1`; polling only happens while a session is active. Fix applied mid-sprint: `ab watch` daemon (notify + popup) for producer-1 on sprint-8.
- **`agentboard-wake` plugin inert in spawned sessions**: `ab spawn` sets `AB_SERVER/AB_TOKEN/AB_AGENT_ID/AB_ROLES` but not `AB_BOARD`, so the wake plugin's board binding can't initialize in the child. Candidate follow-up.
- **Env-identity heartbeats inherit the file's boards list** (config.js `boards` is not env-overridable): an env-only session (e.g. producer) heartbeating from a repo with a local config registers the FILE identity's boards, clobbering its own server-side membership. Workaround used: session-scoped config dir + explicit `--board`. Candidate fix: `AB_BOARDS` env override.