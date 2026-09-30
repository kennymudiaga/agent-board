# Sprint 3 — Progress

> Updated continuously by the dev team during the sprint. Final handoff in `done.md`.

## 2026-09-30 — Session start

- **Branch:** `feature/sprint-3` (single branch/PR for the sprint, same model as sprints 1–2).
- **Concerns raised to Producer (non-blocking):**
  1. T2 release needs account-owner action: npm-side trusted-publisher binding + the `v0.2.0`/`v0.2.1` tag. My `gh` token lacks `write:packages` → ghcr push must run via the workflow (`packages: write` permission being added).
  2. **Version tension:** T2 says tag `v0.2.0`, T6 says `v0.2.1`. Both land in this release → defaulting to **v0.2.1** as the sprint's release (auth-model change included).
  3. T7 dogfood: no board config in this environment (no `.agentboard.json`, no `AB_*` env) — will bootstrap a local server + `dev-1` identity and record evidence.
  4. T1's `list_boards` needs a boards-listing endpoint the spec lacks → adding read-only `GET /v1/boards` (spec §5.8, same v0.2.1 bump).
  5. T6: model proposal will be posted on issue #32 before coding.
- **T8 (npm v12 allowlist) — done:**
  - `npm approve-scripts better-sqlite3 esbuild` → `allowScripts` (pinned entries) committed in root `package.json`.
  - **Verified under npm v12 defaults** (`npx npm@12 ci`): clean install, better-sqlite3 native module loads, build clean, **69/69 tests green**.
  - Docker: image builds and boots (healthz ok) with the allowlist committed.
- **Next:** T1 MCP server.