# Sprint 9 — QA Sign-off

> QA-gated tasks per `docs/sprint-9/plan.md`. Verdicts appended per task as
> they complete.

## T1 — wake lazy binding + global-config fallback (PR #103, issue #101)

- **QA:** `qa-8` (branch `review/pr-103` = `feat/wake-lazy-101` head
  `7b0c631`; commits `1b77c64` + `56a6544` + `7b0c631`; base `cb6ee55`).
- **Verdict: PASS** — no blocking findings.
- **Scope reviewed:** `.opencode/lib/wake-core.js` (`resolveConfig`,
  `defaultGlobalConfigPath`, `LazyResolver`, `createWakeController`,
  `BoardWatcher`), `.opencode/plugins/agentboard-wake.js` (thin wrapper),
  `.opencode/lib/test/wake-core.test.js` (10 new tests),
  `docs/sprint-9/progress.md`.

### Evidence

1. **`resolveConfig` mirrors `cli/src/config.js` precedence** — env `AB_*` →
   workspace `.agentboard.json` → machine-wide global config; board =
   `AB_BOARD` ?? file/global `boards[0]`; `null` when no source yields
   server + token + agentId (plugin stays inert). `defaultGlobalConfigPath`
   mirrors the CLI exactly: win32 `%APPDATA%\agentboard\config.json` (Node
   convention), posix `$XDG_CONFIG_HOME/agentboard/config.json` or
   `~/.config/agentboard/config.json`. Covered by 6 hermetic tests (env
   wins; file over global + `boards[0]`; virgin repo → global; `AB_BOARD`
   override + partial env merge; null on missing trio; platform path).
2. **`LazyResolver` re-resolve loop** — default ~5s (`AB_WAKE_RESOLVE_MS`),
   restart-guard via watch-key `server|token|agentId|board`: `onChange` fires
   only on a key change (inert → configured → rebind; unchanged config never
   re-fires; config disappearance → inert again). Resolve errors are
   swallowed (`onLog`, no crash when server/config read fails). Covered by 3
   hermetic tests incl. a deterministic fake-timer state machine.
3. **Plugin is a thin wrapper; core factored** — `agentboard-wake.js` is 54
   lines of pure wiring (`createWakeController` + `controller.start()`);
   `createWakeController` owns resolver/watcher lifecycle + session
   injection and is exported for hermetic tests. Loader constraint (plugins
   dir exports all run as plugins) documented and respected.
4. **Read-only discipline preserved** — `BoardWatcher` uses the
   identity-less observability GET (`/v1/boards/{board}/messages?since=`);
   no claim/ack calls anywhere. Hermetic tests assert the woken message
   stays `state: pending`, `claimAgent: null` after wake fires; the
   `createWakeController` end-to-end test re-asserts the same after the
   mid-session `ab join` flow. Matches the live test observation (message
   kept pending).
5. **Back-compat + full suite** — configured-at-load regression green
   (sprint-5 wake-core tests pass unchanged). `npm test` at repo root on PR
   head in a clean worktree: **186/186 passed (17 files)** — exactly the
   176 baseline + 10 new wake-core tests; wake-core alone 14/14. `npm run
   build` (server tsc) clean; `ab setup --check` → up to date (11 files,
   exit 0 — plugin/lib intentionally NOT in the drift set, untouched).
6. **CI green** — `gh pr checks 103`: build-and-test ✅, extension-ui ✅,
   docker ✅ (all SUCCESS on run 37236478822).
7. **win32-path fix (`7b0c631`) correct and platform-appropriate** — the
   pre-fix test asserted the win32 `%APPDATA%` path unconditionally, which
   fails on Linux CI (the function branches on `process.platform`, so the
   posix branch resolves `~/.config/...` instead). The fix branches the
   assertion on `process.platform` and adds the posix `XDG` + `~/.config`
   fallback coverage. Verified by diff + green CI on Linux; win32 branch
   passes on this machine.
8. **Option C (`/ab wake` command) skipped — in-process-state argument
   holds.** An opencode command hook runs outside the plugin's process and
   cannot reach the `LazyResolver`'s in-process state, so it could not force
   a rebind the 5s lazy loop wouldn't already do within ~5s; and the plugin
   files are deliberately outside the `ab setup` template/drift set, so a
   command file would add drift-set churn for zero functional gain. Lazy
   binding (A) fully subsumes it.

### Findings

- **Blocking:** none.
- **Non-blocking (minor, follow-up candidate):** `AB_WAKE_RESOLVE_MS` is
  coerced with `Number(...)` without validation — a non-numeric value yields
  `NaN`, and `setInterval(fn, NaN)` becomes a ~0ms hot loop of
  `resolveConfig` (file reads every tick). Only reachable via misconfigured
  env; suggest `Number.isFinite` clamp/fallback in a follow-up.
- **Non-blocking (informational):** `defaultGlobalConfigPath` branches on
  `process.platform` directly (env is injectable, platform is not), so the
  win32 branch is not exercisable on Linux CI — acceptable; mirrors the CLI
  (`cli/src/config.js`) which has the same shape.