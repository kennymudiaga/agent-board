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

## T2 — spawn observability (PR #104, issue #93)

- **QA:** `qa-8` (branch `review/pr-104` = `feat/spawn-observability-93`
  head `98d1b90`; commits `8ca7502` + `5d89190` (merge main) + `98d1b90`;
  base `main` `4983280`).
- **Verdict: PASS** — no blocking findings.
- **Scope reviewed:** `cli/src/commands.js` (`spawnWorker` + `cmdSpawn`
  flags), `cli/src/index.js` (help), `cli/test/cli.test.js` (4 new tests),
  `docs/wake-on-mail.md` §3.1, `docs/sprint-9/progress.md`.

### Evidence

1. **EPIPE fix intact + default unchanged** — every spawn path keeps
   `detached: true`; default stdio remains `'ignore'` (fire-and-forget).
   Pinned by the new hermetic test (qa-7 finding, #93): asserts
   `detached === true` and `stdio === 'ignore'` for the default spawn on
   both platforms, plus the win32 `.cmd`-shim-via-cmd.exe shape.
2. **`--visible`** — win32: new console window via `start` + inner
   `cmd /k` (stays open after the worker exits, so crashes stay visible);
   outer process keeps stdio `'ignore'` (the window has its own console).
   posix: `stdio: 'inherit'` — inherits the spawner's terminal (foreground,
   still detached). Hermetic test asserts the arg shape (win32 `start` +
   `/k` + title; posix `inherit`) and `detached` on both.
3. **`--log <file>` tee on BOTH platforms** — real executables and posix
   use the fd path (`openSync(logFile, 'a')` passed as stdout+stderr,
   parent closes its copy after spawn); the win32 `.cmd` shim uses shell
   redirection (`> "file" 2>&1`) because cmd.exe reconnects grandchildren
   to the console so a stdio fd does not survive the wrapper — the
   fd/shell asymmetry is documented in-code and was the flagged risk area.
   **Verified live on this machine:** a probe `.cmd` shim in a directory
   WITH spaces, args with spaces, `--log` via the shell-redirect path →
   both stdout (`shim-out-line`) and stderr (`shim-err-line`) landed in the
   log, exit 0. Hermetic test covers the fd path end-to-end (real node.exe
   probe: `tee-out` + `tee-err` in the file).
4. **Win32 quoting hardening** — `windowsVerbatimArguments: true` on both
   cmd paths (Node's `\"` re-quoting is not cmd-compatible); the command
   token is now `cmdQuote`'d too (a shim path with spaces survives argv
   splitting); when the command needs quoting the WHOLE line (command +
   args + redirect) is wrapped in an extra quote pair so `cmd /s` strips
   only the outermost pair, with the closing pair placed AFTER the
   redirect so the strip cannot eat the redirect's own quotes. Real
   executables skip the cmd wrapper entirely (no quoting dance, fd tee
   works). Live shim test above exercised the wrap with a space-containing
   shim path + spaced args — no quoting/injection breakage.
5. **`cmdSpawn` validation + plumbing** — `--log` pointing at an existing
   directory is rejected (`usage`: "must be a file path, not a directory");
   both flags plumbed through json output (`visible`, `log`), text dry-run
   ("visible windows", `(log: <file>)`), and the post-spawn summary.
   Covered by the 4th hermetic test (dry-run + json + directory
   rejection). Edge note: `--log` with a missing parent directory throws a
   raw `ENOENT` from `openSync` — the dispatcher catches it (exit 1,
   `error: ENOENT ...`), acceptable but a cleaner CliError would be nicer.
6. **Suite + gates** — `npm test` at repo root on PR head in a clean
   worktree: **190/190 passed (17 files)** — exactly 186 baseline + 4 new
   hermetic tests; `npm run build` (server tsc) clean; `ab setup --check`
   → up to date (11 files, exit 0).
7. **CI green** — `gh pr checks 104`: build-and-test ✅, extension-ui ✅,
   docker ✅ (all SUCCESS on run 37238290206). PR OPEN + MERGEABLE.
8. **Docs updated** — `ab --help` spawn usage now lists `--visible` and
   `--log <file>` with one-line explanations; `docs/wake-on-mail.md` §3.1
   documents worker observability (win32/posix semantics, log tee, both
   combinable) and points at attachable sessions (`ab watch --opencode`,
   `opencode serve`/`attach`) per the T2 done-when.

### Findings

- **Blocking:** none.
- **Non-blocking (minor):** `--log` with a nonexistent parent directory
  yields a raw `ENOENT` message (still exit 1, no stack trace) rather than
  a clean usage error — candidate follow-up: catch `openSync` ENOENT and
  emit a CliError.
- **Non-blocking (informational):** the win32 shim shell-redirect `--log`
  path is not hermetically testable (needs a real `.cmd` shim), so it is
  covered by code review + this QA's live probe rather than an automated
  test — the fd path is the hermetic one. Acceptable asymmetry, worth
  remembering if a shim-specific regression ever surfaces.