# Sprint 3 — Done

> Handoff from the dev team. Sprint goal: **equip every platform and ship
> v0.2.1** — MCP as the universal tool layer, release plumbing, OpenDevin docs,
> VS Code sidebar + host-wiring tests, git archive, per-agent credentials, and
> dogfooding our own board. Achieved (release tag + publish pending Producer
> actions — see T2 notes).

## What landed (branch `feature/sprint-3`)

| Task | Deliverable | Status |
|---|---|---|
| T8 | **npm v12 install-script allowlist** — `allowScripts` (pinned better-sqlite3/esbuild) in root package.json; verified under **npm v12 defaults** (`npx npm@12 ci` → native module loads, 69/69 at the time); Docker builds and boots. Done early as the CI-health prerequisite. | ✅ |
| T1 | **`agentboard-mcp`** — official MCP SDK (1.31), stdio transport, 9 tools (`whoami`·`heartbeat`·`send`·`read`·`ack`·`list_agents`·`list_boards`·`requeue`·`purge`), env-only config (reuses CLI rules, never writes files). Gap fixed: env-only agents couldn't declare roles → `AB_ROLES` env + `roles` heartbeat param. New read-only `GET /v1/boards` (spec §5.8) powers `list_boards`. `docs/mcp.md` covers OpenCode/Claude Code/VS Code/Cursor + JSON-RPC smoke test. 8 unit + 3 stdio end-to-end tests. | ✅ |
| T2 | **Release v0.2.1 (prepared)** — versions bumped to 0.2.1 everywhere; `release.yml` rewritten for **trusted publishing (OIDC)**: `id-token: write`, no token, `--provenance`; ghcr job with `packages: write` pushes `<tag>`+`:latest`; GitHub Release. `docs/releasing.md` (chosen path, npm-side setup steps, stage-only GAT fallback, checklist). Verified: pack → clean install → `ab 0.2.1`; Docker build. **Producer actions:** bind the npm trusted publisher + tag `v0.2.1`. | ⏳ (blocked on account owner) |
| T3 | **OpenDevin docs** — `docs/opendevin/quickstart.md`: MCP mount via `config.toml` or `ab` in the sandbox; conventions references. | ✅ |
| T4 | **VS Code sidebar + UI tests** — activity-bar tree view (agents ●/○ presence, messages with state/payload), Refresh command, welcome view; **host-wiring UI tests** (`@vscode/test-electron` + mocha in the extension host, xvfb CI job) — spawns a real server, drives settings+SecretStorage+join command, asserts the tree, proves SSE-driven refresh. Caught real bugs: `withDescription` API absence, `ab.cmd` EINVAL on Windows, Electron `execPath`. **4/4 UI tests pass locally.** | ✅ |
| T5 | **Git archive** — `ab archive --board <b> --git <dir>`: threads → markdown (`threads/<root>.md` + index), git init, **one commit per changed thread** (`(closed)` when terminal), idempotent via content hashes. Test: fresh board, per-thread commits, no-op rerun, thread-close commit. | ✅ |
| T6 | **Per-agent credentials** — model proposed on issue #32, implemented: server-side SHA-256 hashes, `POST /v1/tokens` + `DELETE /v1/tokens/{agentId}` (workspace-token only), identity **bound to the token** (X-Agent-ID + heartbeat body must match — a CLI test caught the heartbeat impersonation hole). CLI `ab token --agent-id <id> [--revoke]`. Spec §4 rewritten, §5.9 added, **v0.2.1**. | ✅ |
| T7 | **Dogfood** — bootstrapped local board (server left running for the Producer), `dev-1` identity, 3 coordination notes on `sprint-3` (evidence in `progress.md`); added `ab whoami` (AGENTS.md/demo) + `--key` alias (persona used it, CLI lacked it). | ✅ |
| Stretch | **A2A spike** — `docs/a2a-spike.md`: bridge = relay on the reference server (Agent Card + `/a2a/:agentId`, tasks↔thread mapping, agent-token auth); recommended as a sprint-4 task. | ✅ (writeup) |

## Verification

- **86/86 vitest green** (was 81) + **4/4 extension host-wiring UI tests** (local; CI job `extension-ui` added).
- Build clean; Docker image builds and boots (T8).
- npm v12 clean-`ci` verified; `ab 0.2.1` pack+install verified.
- T6 done-when proven in tests: an agent with only its own token **cannot** act as another agent (impersonation → 401 on X-Agent-ID mismatch and heartbeat body mismatch; minting is admin-only; revoke kills the token).

## Decisions & deviations (in `progress.md`)

1. Sprint ships as **v0.2.1** (T2 said tag v0.2.0; T6 says v0.2.1 — auth change included; flagged to Producer).
2. T2 release mechanics need account owner: npm trusted-publisher binding + the tag; ghcr push via workflow (`packages: write`) since the dev token lacks `write:packages`.
3. T7 dogfood bootstrapped locally (no shared server/config existed); server left running + config ignored (`tokens never in PRs`).
4. `GET /v1/boards` added (spec §5.8) — `list_boards`/dashboards need it.
5. T6 model proposed on #32 before coding, per plan; implemented per the plan's recommendation.
6. T8 allowlist is **pinned** (`pkg@version` — npm's default), in the root manifest.

## Follow-ups for sprint 4 (suggested)

- A2A relay (from the spike), OpenDevin client polish, dashboard delivery detail rendering, broadcast read-state (spec §10.4), token rotation/expiry.
- Release v0.2.1 when the Producer completes the trusted-publisher binding + tag.

## Open items for the Producer

- Merge the sprint-3 PR (regular merge), close issues #27–#35.
- **T2:** per your board decision (#5): install the **stage-only GAT** as `NPM_TOKEN` in a `release` environment, then tag `v0.2.1` → workflow stages the package → `npm stage approve` (2FA). Migrate to OIDC after the first publish (`docs/releasing.md`).
- QA sign-off per the plan's DoD (blocker #39 fixed + live-verified; signoff re-review pending).
- Dogfood continues: the local server on :8080 (`dogfood-token`) has `dev-1` on `sprint-3` waiting for dispatches.

## Dogfood remediation round (2026-10-01)

The board dogfood looped: producer-1 broadcast decisions (#5), QA filed the **#39 blocker** (per-agent token impersonation via pickup `?for=`) and reported via response (#6), signoff doc landed. Remediated, committed (`786c797`), pushed, and replied on the board (response #7):

- **#39:** pickup `for` is now bound to the authenticated identity (401 on mismatch) for both token and workspace flows; regression tests + **live re-verified** on the dogfood server. **88/88 green.**
- **Release:** `release.yml` → stage-only GAT (`environment: release`, `NODE_AUTH_TOKEN`, `npm stage publish`) per Producer decision; OIDC migration documented.
- **Kinks:** env-only `join` persists boards (token never on disk); help text lists `AB_ROLES` + `--key`.
- **QA non-blocking notes:** MCP `send` errors on message+payload conflict; `docs/mcp.md` documents the watermark resume discipline.