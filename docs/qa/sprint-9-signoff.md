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

## T3 — ci.yml tag docker-push race (PR #105, issue #100)

- **QA:** `qa-8` (branch `review/pr-105` = `fix/ci-tag-push-100` head
  `e0f96dd`; commits `91d0468` + `e0f96dd`; base `main`).
- **Verdict: Ready** — no blocking findings.
- **Scope reviewed:** `.github/workflows/ci.yml` (docker job, 7+/2- — the
  ONLY file changed), `release.yml` (tag-time publisher, unchanged),
  workflow triggers, ci.yml git history since sprint-2.

### Evidence

1. **Tags skipped, drift-check kept** — the docker job's `Login to GHCR` and
   `Build and push to GHCR` steps are now gated on
   `startsWith(github.ref, 'refs/heads/')` (was `refs/tags/v`), so
   tag-triggered CI runs no longer push — the race with the Release
   workflow's `ghcr-push` is gone. The build-only drift-check step
   (`push: false`, `tags: agent-board:ci`) stays unconditional, so the
   Dockerfile-drift gate still runs on every trigger.
2. **release.yml is the sole tag-time GHCR publisher** — unchanged:
   triggers on `push: tags: ['v*']`, `ghcr-push` (needs `npm-publish` —
   the sprint-6 F1 ordering) pushes `:ref_name` + `:latest`. With ci.yml
   skipping tags, exactly one publisher per release. ✅
3. **No new failure mode** — PR runs: `github.ref` is `refs/pull/N/merge`,
   which matches neither `refs/heads/` nor the old `refs/tags/v`, so PRs
   skip push entirely (this is the fix for the intermediate regression:
   `91d0468` used `refs/tags/ == false`, which would have pushed on PR
   refs with the invalid Docker tag `105/merge` — dev-6 caught it;
   `e0f96dd` restricts to `refs/heads/`). Main pushes: workflow-level
   triggers (`push: branches: [main]`, `tags: ['v*']`, `pull_request`)
   mean ci.yml only ever RUNS for PRs, main pushes, and v-tags — so
   `refs/heads/` effectively selects main only, publishing `:main` +
   `:latest`. No other branch can trigger the push path.
4. **CI green + mergeable** — `gh pr checks 105`: build-and-test ✅,
   extension-ui ✅, docker ✅ (run 37241229291); PR OPEN + MERGEABLE.
5. **Zero code/test footprint** — diff is ci.yml-only; nothing else
   touched, so the suite is unaffected (no test run needed for a
   workflow-only change).

### Findings

- **Blocking:** none.
- **Non-blocking (informational — behavior change to be aware of):** the
  request's "main pushes still publish `:main`+`:latest` (pre-existing)"
  is not accurate as *pre-existing*: since sprint-2 (44c26c0) ci.yml
  gated GHCR pushes on `refs/tags/v`, so main pushes NEVER published via
  ci.yml before. This PR deliberately (per its own comment) makes main
  pushes publish `:main` + `:latest`. Effect: `latest` now tracks
  main-head between releases; release.yml still re-publishes `:latest`
  (after npm publish) at each release, so the released image wins at
  release time. If `latest` is meant to mean "latest release" only,
  tighten the gate to `github.ref == 'refs/heads/main'` plus a
  `refs/heads/`-only push step — cosmetic today given the trigger set.
- **Non-blocking (informational):** intermediate commit `91d0468` (the
  `== false` form) would have been a real regression on PR runs (invalid
  Docker tag) — good catch by dev-6; the head commit resolves it. The
  history is fine to merge as-is.

## T4 — long-turn presence/lease ergonomics (PR #106, issue #102)

- **QA:** `qa-8` (branch `review/pr-106` = `feat/presence-lease-102` head
  `9f17fa0`; commits `735e342` + `9f17fa0`; base `7826c3c`).
- **Verdict: PASS** — no blocking findings.
- **Scope reviewed:** `docs/spec.md` (§6.1 lease + §7 presence),
  `docs/conventions.md` §3, `cli/templates/*` + generated copies
  (`.opencode/agents/board-worker.md`, `.opencode/skills/agentboard/SKILL.md`,
  `.claude/skills/agentboard/SKILL.md`, `AGENTS.md`), the new hermetic
  lifecycle test, `server/src` (unchanged — verified), `docs/sprint-9/progress.md`.

### Evidence

1. **Decision matches issue #102 exactly** — verified against the issue
   body's option list:
   - **Option 1 (heartbeat-on-tool-use / periodic re-ack) — adopted** as
     worker discipline guidance: presence via `ab heartbeat --interval 60
     --status busy --task "<what>" --once` every few minutes (TTL 180s),
     claim renewal via `ack --status claimed` before the 5-min lapse.
     Present in the board-worker persona, the agentboard skill (§5.1),
     AGENTS.md, and conventions §3 — all four surfaces consistent.
   - **Option 2 (longer leases) — kept 300s** with the renewal contract
     made explicit: renewal extends `leaseExpiresAt` to `now + 300s`
     WITHOUT incrementing `attempts`. Pinned by the new hermetic test:
     claim (attempts=1) → renew ×2 (attempts stays 1, 200 each) → done
     finalizes with `{state:'done', attempts:1}`. Extending the base lease
     was considered and rejected with rationale (renewal already covers
     long turns; a longer window only delays crash recovery).
   - **Option 3 (`sleeping` presence) — deferred**, recorded in spec §7
     with rationale: `wake:*` capability tags already tell producers a
     session is watched (§5.1); a new status is a protocol change for
     marginal gain.
   - **Option 4 (watch daemon heartbeats for the agent) — rejected** with
     the truthful-presence argument: a daemon heartbeating for a dead
     identity would make presence reflect the watcher, not the agent
     process — presence would lie. Spec §7 now states presence reflects
     heartbeat freshness, not process liveness.
2. **Contract recorded in spec §6.1 + §7 + conventions §3** — §6.1 states
   the renew-or-lapse contract (renew or accept redelivery; at-least-once
   means no loss; 300s intentionally short for fast crash recovery;
   `attempts` bounds pathological loops); §7 states presence freshness vs
   liveness, the keep-heartbeating guidance, and the deferred `sleeping`
   rationale; conventions §3 gives the concrete commands. Presence and
   claims are explicitly independent ("heartbeating does not renew claims,
   renewing does not refresh presence"). No contradictions found.
3. **Templates regenerated + drift clean** — `cli/templates/` updated in
   lockstep with the generated copies (identical line counts per file:
   board-worker +9, SKILL +17, AGENTS +12); `ab setup --check` → up to
   date (11 files, exit 0). CI's drift gate will hold it.
4. **NO server behavior change** — the PR diff is docs/templates/test only;
   `server/src/` untouched. Verified in code: `attempts` increments only
   on CLAIM (`claimMessages`, db.ts), and `ackMessage` status `claimed`
   updates only `lease_expires_at` (db.ts:904-908) — the renewal path was
   already correct, so the new test pins existing behavior, not new
   behavior. ✅
5. **Suite + gates** — `npm test` at repo root on PR head in a clean
   worktree: **191/191 passed (17 files)** — exactly 190 baseline + 1 new
   lifecycle test (renew x2 keeps attempts=1, done finalizes). `npm run
   build` (server tsc) clean; `ab setup --check` clean.
6. **CI green** — `gh pr checks 106`: build-and-test ✅, extension-ui ✅,
   docker ✅ (run 37242557350). PR OPEN + MERGEABLE.

### Findings

- **Blocking:** none.
- **Non-blocking (informational):** guidance documents rely on workers
  actually following the heartbeat/renew commands — there is no
  enforcement mechanism (by design; a watchdog that auto-heartbeats would
  drift into option-4 territory). The skill/persona text is the mechanism;
  the sprint-9 dogfood will show whether workers comply.
- **Non-blocking (informational):** `sleeping` remains a documented
  future option (spec §7 + wake-on-mail §7 Q2 lean) — the deferral note
  gives a clean hook if wake:*-capable agents later want the distinction.