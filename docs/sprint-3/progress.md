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
  - **Producer actions:** (1) bind the npm trusted publisher (npmjs → Access → Trusted Publishers → `@agent_board/cli` → repo/workflow), (2) tag `v0.2.1`. The workflow then publishes + pushes + releases unattended.
- **Next:** T3 OpenDevin docs.

## 2026-09-30 — T3 + T4 + T5 + T6 done

- **T3 (OpenDevin docs):** `docs/opendevin/quickstart.md` — MCP mount via `config.toml` (`mcp_servers`) or `ab` in the sandbox; agent instructions referencing `docs/conventions.md`; transient-session notes.
- **T4 (VS Code sidebar + UI tests):**
  - Activity-bar container + `agentboard.boardView` tree (Agents ●/○ presence, Messages with state+payload), Refresh command, welcome view; webview panel unchanged.
  - **Host-wiring UI tests** (sprint-2 done.md follow-up): `@vscode/test-electron` + mocha suite inside the extension host — spawns a real server (dist build, `:memory:`), drives settings + SecretStorage + `joinBoard` command, asserts the sidebar tree, and proves **SSE-driven refresh** (a posted message appears in the tree). CI job `extension-ui` (xvfb).
  - Bugs caught by the UI suite: `TreeItem.withDescription` doesn't exist (set `.description`); `execFile('ab.cmd')` EINVAL on Windows (shell:true); `process.execPath` in the extension host is Electron (spawn `node` from PATH).
  - Local run: **4/4 UI tests pass**; vitest 81 → suite excluded via `vitest.config.js`.
- **T5 (git archive):** `ab archive --board <b> --git <dir>` — identity-less full-board fetch, threads grouped by `replyTo` chains, markdown per thread (`threads/<root>.md`) + index README; `git init` if needed; **one commit per changed thread** (`board <b>: thread <root> (closed)` when all terminal); idempotent via content hashes (dropped a run-timestamp from the index that broke idempotency — caught by the test). CLI test: fresh board, per-thread + index commits, second run no-op, thread close commit. **82/82 → now 86/86.**
- **T6 (per-agent credentials):** model proposal posted on issue #32 (minted admin-side, hashed server-side, identity bound to token) — implemented per the plan's recommendation:
  - Server: `agents.token_hash` (SHA-256) + migration; `POST /v1/tokens` + `DELETE /v1/tokens/{agentId}` (workspace token only); auth middleware resolves agent tokens first — identity from token, `X-Agent-ID` must match; heartbeat body must match the token's agent (a CLI test caught this impersonation hole: the CLI doesn't send X-Agent-ID on heartbeat).
  - CLI: `ab token --agent-id <id> [--revoke]`.
  - Spec §4 rewritten + §5.9 added; **v0.2.1**.
  - Tests: 3 server (mint/use/impersonation 401/revoke; provisioning; validation) + 1 CLI end-to-end (mint → act as qa-1 → impostor 401 → no mint with agent token → revoke → dead). **86/86 green.**
- **Next:** T7 dogfooding (bootstrap board + dev-1 identity), then stretch A2A spike + handoff.

## 2026-09-30 — T7 + stretch + final verification

- **T7 (dogfood) — evidence recorded:**
  - No shared board existed in this environment, so we bootstrapped (as flagged): local server (`AB_TOKEN=dogfood-token`, persistent DB, **left running** on :8080 — Producer's session can join), `dev-1` identity via `ab init`/`join`/`whoami` (new `ab whoami` command added — AGENTS.md + demo reference it), heartbeat busy, board `sprint-3`.
  - Board evidence (visible via identity-less observability): **3 coordination notes** `dev-1 → role:producer` (T1–T6 done, 86 tests, A2A spike next, then PR); `dev-1 [online] busy — implementing sprint 3` in the directory; `GET /v1/boards` lists `sprint-3`.
  - Dogfooding caught a doc/code mismatch: the board-producer persona uses `ab send --key <task-key>` but the CLI flag is `--idempotency-key` → added **`--key` alias**.
  - `.agentboard.json` gitignored (tokens never in PRs — conventions §6).
- **Stretch (A2A bridge spike):** `docs/a2a-spike.md` — feasibility writeup: A2A needs addressable always-on agents; board agents are transient, so the bridge must be a **relay on the reference server** (Agent Card + `/a2a/:agentId`, `tasks/send|get|cancel` mapping to board threads, agent-token auth). Recommended as a real sprint-4 task; findings only, no code (per plan).
- **Final verification:** build clean; **86/86 vitest green** (was 81) + **4/4 extension host-wiring UI tests** (ran locally; CI `extension-ui` job added).
- **Next:** handoff — done.md, PROJECT_BRIEF §7/§8, README, push, PR (#27–#35).

## 2026-10-01 — Dogfood loop round 2: QA blocker #39 + Producer decisions remediated

The board came alive: producer-1 broadcast a status/decision (#5), QA (as dev-1) filed **#39** and reported via response (#6), and the signoff doc (`docs/qa/sprint-3-signoff.md`) landed with the blocker.

- **#39 (major, merge blocker) — fixed + live-verified:** per-agent token could impersonate any agent via pickup `?for=` (claims in the victim's name). Fix: pickup rejects `for` unless it equals the authenticated identity — for **both** token-bound and workspace-token (X-Agent-ID) callers (401). Regression test covers the exact QA repro (mint → `for=other` → 401, victim's mail untouched/pending, `for=self` works, workspace bound too). **Live re-verified on the dogfood server** with the exact repro: `qa-1 token + for=dev-1` → 401; workspace `dev-1 + for=qa-1` → 401. Test token revoked after verification (hygiene).
- **Release path (Producer decision via board #5):** first publish v0.2.1 via **stage-only GAT** — `release.yml` npm job now uses `environment: release` + `NODE_AUTH_TOKEN` (secret in the release environment) + `npm stage publish` (human 2FA approve); OIDC migration documented for after the package exists. `docs/releasing.md` restructured (two-phase checklist).
- **Two dogfood kinks (from #5, details inferred + fixed):**
  1. **env-only membership** — `ab join` under an env-only identity wrote `{cursors}` only, silently dropping the joined board → `saveConfig` now persists `boards` + `cursors` (non-secret) for env-only runs; token still never written. Regression test.
  2. **help text** — `AB_ROLES` (added in T1) was missing from `--help` env overrides; also documented the `--key` alias.
- **QA non-blocking notes fixed:** MCP `send` with both `message`+`payload` now errors (mirrors the CLI); `docs/mcp.md` documents the watermark resume discipline for stateless MCP agents.
- **88/88 vitest green.** Committed + pushed (`786c797`); CI re-running on PR #36.
- **Next:** reply on the board to producer-1 (thread #5) with the remediation summary; re-check mail; hand off.