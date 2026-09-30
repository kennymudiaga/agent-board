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

## 2026-09-30 — T1 + T2 done

- **T1 (agentboard-mcp) — done:**
  - `mcp/` workspace: official `@modelcontextprotocol/sdk` (1.31) + zod, stdio transport, bin `agentboard-mcp`.
  - 9 tools: `whoami` · `heartbeat` (status/task/boards/**roles**) · `send` · `read` (claims, watermark) · `ack` · `list_agents` · `list_boards` · `requeue` · `purge`. Errors return as text — the server never dies.
  - Reuses the CLI's `apiCall` + `loadConfig` (env-only: AB_SERVER/AB_TOKEN/AB_AGENT_ID; **never** writes config files).
  - **Gap found + fixed:** env-only agents couldn't declare roles → role-addressed mail was unreachable. Added `AB_ROLES` env support to the CLI config + `roles` param on the MCP heartbeat tool.
  - **New endpoint:** `GET /v1/boards` (spec §5.8, identity-less, message counts) — `list_boards` needs it.
  - `docs/mcp.md`: mount snippets for OpenCode (opencode.json), Claude Code (`.mcp.json`), VS Code (`.vscode/mcp.json`), Cursor, OpenDevin link, plus a JSON-RPC stdio smoke test.
  - Tests: 8 per-tool unit (in-process, real server) + 3 end-to-end (spawned server, JSON-RPC over stdio: initialize → tools/list → tools/call full lifecycle → error path stays alive). **81/81 green.**
- **T2 (release v0.2.1) — prepared (Producer actions needed):**
  - Version bumps → **0.2.1** everywhere (root/cli/server/mcp/vscode-ext) — the sprint ships as v0.2.1 (T6 auth changes included; flagged to Producer vs plan's v0.2.0).
  - `release.yml` rewritten: **trusted publishing (OIDC)** — `permissions: id-token: write`, no `NODE_AUTH_TOKEN`, `npm publish --provenance`; ghcr job with `packages: write` pushes `<tag>` + `:latest`; GitHub Release with notes.
  - `docs/releasing.md`: chosen path, npm-side trusted-publisher setup steps, stage-only GAT fallback, release checklist, verification commands.
  - Verified locally: `npm pack` → clean-prefix install → `ab 0.2.1`; Docker image builds.
  - **Producer actions:** (1) bind the npm trusted publisher (npmjs → Access → Trusted Publishers → `@agentboard/cli` → repo/workflow), (2) tag `v0.2.1`. The workflow then publishes + pushes + releases unattended.
- **Next:** T3 OpenDevin docs.