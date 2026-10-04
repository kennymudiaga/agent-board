# Sprint 9 — Progress (Wake, Watch & Worker Ergonomics)

> Updated: 2026-10-04. Plan: `docs/sprint-9/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — wake lazy binding + global fallback (#101) | **MERGED + QA PASS** | PR [#103](https://github.com/kennymudiaga/agent-board/pull/103) (merge `e5c317c6`); independent QA: **PASS** (qa-8) — 8/8 points, sign-off `docs/qa/sprint-9-signoff.md`; live fresh-clone verification; 186/186; #101 closed |
| T2 — spawn observability (#93) | **dispatched** | request `s9-t2` → `agent:dev-4` |
| T3 — ci.yml tag race (#100) | pending | |
| T4 — presence/lease ergonomics (#102) | pending | |
| T5 — release v0.4.1 | pending | |

## Verification record

- **T1 (dev-4, 2026-10-04):** `wake-core.js` gains `resolveConfig` mirroring `cli/src/config.js` precedence — **env AB_* → workspace `.agentboard.json` → global config** (`defaultGlobalConfigPath`: `%APPDATA%\agentboard\config.json` win32 / `$XDG_CONFIG_HOME|~/.config/agentboard/config.json` posix; board = `AB_BOARD` ?? file/global `boards[0]`) — plus `LazyResolver` (poll loop with restart-guard: `onChange` fires only when server/token/agentId/board change; errors swallowed) and `createWakeController` (resolver + BoardWatcher lifecycle + session injection, factored for hermetic tests). Plugin `agentboard-wake.js` is now a thin wrapper: lazy re-resolve every `AB_WAKE_RESOLVE_MS` (default 5s), watcher starts/stops on config change — **no opencode relaunch, no per-sprint AB_BOARD chore**. Option C (`/ab wake` command) skipped as redundant once A lands (plugin state is in-process; commands can't reach it) — noted in the PR. Evidence: `npm test` **186/186** (17 files; baseline 176 unchanged — incl. configured-at-load regression green), `npm run build` clean, `ab setup --check` clean (plugin/lib are NOT in the drift set, untouched). **Live verification (real plugin + real server localhost:8080):** fresh clone (no config) → plugin inert, no crash → `ab init` + `ab join --board sprint-9` in another terminal → watcher bound within ~1s → test note (producer-1 → agent:dev-4) → **wake prompt injected into the live session**; message stayed pending (read-only); all test messages purged after. Branch `feat/wake-lazy-101`.