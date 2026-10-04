# Sprint 8 — Progress (Multi-Workspace Server)

> Updated: 2026-10-04. Plan: `docs/sprint-8/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — W1 workspaces table + bootstrap (#83) | **PR ready** (dev-4 resumed after spawn death) | PR [#91](https://github.com/kennymudiaga/agent-board/pull/91), commit `f433df1`; suite 147/147 incl. new `server/test/workspaces.test.ts` 7/7; build clean; live startup smoke: `AB_WORKSPACE=smoke-ws` + `AB_TOKEN` → row created with SHA-256 hash, `/healthz` ok, 0 boards (no behavior change) |
| T2 — W2 middleware + admin endpoints (#84) | pending (after T1) | |
| T3 — W3 store scoping + migration (#85) | pending (after T1) | |
| T4 — W4 API/SSE/A2A scoping + isolation tests (#86) | pending (after T2+T3) | |
| T5 — W5 CLI `--workspace` + docs (#87) | pending (after T4) | |
| T6 — release v0.4.0 (#90) | pending (after T1–T5 + QA) | |

## Verification record

- **T1 (dev-4, 2026-10-04):** `workspaces(id, name, token_hash, created_at)` in `server/src/db.ts` SCHEMA (CREATE TABLE IF NOT EXISTS — no column migration needed for a new table); store methods `createWorkspace` (idempotent INSERT OR IGNORE, returns `{workspace, created}`), `listWorkspaces`, `workspaceForToken` (SHA-256 hash lookup, mirrors agent §5.9), `revokeWorkspaceToken`, `bootstrapWorkspace`; `server/src/index.ts` bootstraps `AB_WORKSPACE` (default `default`) + `AB_TOKEN` (default `dev-token`) idempotently at startup (existing rows untouched — no rotation). Evidence: `npm test` 147/147 (14 files; was 140 — existing tests unchanged), `npm run build` clean, live smoke test verified row + hash + no boards created. dev-4 (spawned worker) died after claiming `s8-t1`; session resumed as dev-4, claim renewed, work delivered on branch `feat/workspaces-83`.