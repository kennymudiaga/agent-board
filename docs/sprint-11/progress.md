# Sprint 11 — Progress (Dogfood Fixes: Wake Echo, Spawn Defaults & Session Discipline)

> Updated: 2026-10-24. Plan: `docs/sprint-11/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — wake echo (#117) | **MERGED + QA PASS** | [PR #122](https://github.com/kennymudiaga/agent-board/pull/122), merge `86e2c13` (head `d184ac7`) — spike recorded (§7.1): `PluginInput` has no session id, `session.list` is project-wide; fan-out removed for process-observed single-session injection, ambiguous multi-session skip with `AB_WAKE_SESSION`/tier-2 pointer; 21/21 wake tests, 213/213 suite; qa-t1 **PASS** at `d184ac7`. Docs-only merge with main resolved here. |
| T2 — `ab spawn` defaults + instant exits (#119) | **MERGED + QA PASS** | PR [#120](https://github.com/kennymudiaga/agent-board/pull/120) (merge `2e299f3`): default model `opencode-go/deepseek-v4.1-flash`, model pre-flight with available ids, instant-exit trailer/warning; 214/214 tests; qa-t2 **PASS** at `28f007f` (independent repro of both behaviors); main CI green `40046337112`. Non-blocking: `cli/README.md` stale default line -> fold into T4. |
| T3 — overlapping-session discipline (#113) | **MERGED + QA PASS** | PR [#121](https://github.com/kennymudiaga/agent-board/pull/121) (merge `e2f800c`): templates + `docs/conventions.md`, `ab setup --force` regen (11 files drift-clean), 207/207; qa-t3 **PASS** at `b6e5768`; `ab read` responded marker (option 3) deferred. |
| T4 — release v0.5.1 | **PR open (ready for QA)** | [PR #123](https://github.com/kennymudiaga/agent-board/pull/123) (head `69faf23`) — versions → 0.5.1 (root + `cli/` + `server/` + `mcp/` + `vscode-ext/` + lock), `spec.md` header v0.5.1 (changelog #117/#119/#113), `ab setup --force` regen (11 files, `--check` clean), stale `cli/README.md` spawn default fixed (qa-t2 finding); suite **220/220**, build clean; **no tag / no publish** (producer + human own tag → OIDC → GHCR → Release). |
| T5 — workspace-local worktrees + briefs | **dispatched** | request `sprint-11-t5-worktrees` (dev-worktrees): `_worktrees/<agentId>` + `_briefs/` convention, help/docs/tests; `.gitignore` already updated |

## Verification record

- **Sprint opened (producer-1, 2026-10-24):** v0.5.0 shipped and sprint 10
  closed; board `sprint-11` created; candidates reviewed against the code
  (`wake-core.js:174-188` fan-out; `cli/src/commands.js:660` stale default;
  #113 evidence from sprint 10). T1 + T2 dispatched; T3 sequenced after T2 to
  avoid two `ab setup --force` regenerations in flight.

- **T2 delivered + QA (dev-spawn119 / qa-t2, 2026-10-24):** PR #120 merged
  (`2e299f3`) — model default + pre-flight + instant-exit evidence; suite
  **214/214**; qa-t2 PASS at `28f007f` (independent repro: stale id fails with
  available ids; silent child leaves an exit trailer + early-exit warning;
  healthy worker stays detached; win32 `--visible` unaffected). Non-blocking:
  `cli/README.md` still documents the old default -> T4.

- **T3 delivered + QA (dev-session113 / qa-t3, 2026-10-24):** PR #121 merged
  (`e2f800c`) — one active producer session per sprint, per-session identity
  via `ab session`/`AB_SESSION_FILE` (#109), pre-reply `replyTo` thread check;
  sprint-10 evidence + wake-echo (#117) rationale in templates/conventions.
  `ab setup --force` regen; `setup --check` clean (11 files); **207/207**
  tests; qa-t3 PASS at `b6e5768`. Option 3 (`ab read` responded marker)
  deferred. T3 ran in its own worktree, so its regen did not touch T2's tree.

- **T1 delivered + QA (dev-wake117 / qa-t1, 2026-10-24):** PR #122 at
  `d184ac7` — spike (opencode 1.18.9): `PluginInput` has no session id; hooks
  expose `properties.sessionID` only for sessions this process handles;
  `session.list({directory})` is project-wide, not "live" (the echo source);
  client calls in the plugin factory hang server bootstrap. Fix: track
  process-observed sessions, inject into exactly one; ambiguous multi-session
  -> skip with `AB_WAKE_SESSION` / tier-2 pointer; prompt carries an
  addressed-to marker + message id. Docs §7.1/§8.1. Evidence: wake-core
  **21/21**, `npm test` **213/213**, `setup:check` clean; qa-t1 **PASS** at
  `d184ac7`. Merged with main here (docs-only conflict in this ledger); merged
  to `main` as `86e2c13` (PR #122) — sprint 11 task code complete.

- **T4 release prep (dev-release051, 2026-10-24):** release-only PR; versions
  → **0.5.1** in root/cli/server/mcp/vscode-ext `package.json` + lock (lock
  regenerated with `npm install --package-lock-only --ignore-scripts`),
  `docs/spec.md` header v0.5.1 with the #117/#119/#113 changelog entry,
  `ab setup --force` regen (11 files, version marker only) and the stale
  `cli/README.md` spawn default (`deepseek-v4-flash` →
  `deepseek-v4.1-flash` + pre-flight note, qa-t2 non-blocking). Verification:
  `npm test` **220/220** (19 files; 214 + 6 wake-core tests), `npm run build`
  clean, `setup --check` up to date (11), `node cli/bin/ab.js --version` →
  `ab 0.5.1`. No tag, no publish. Note: two `cli.test.js` cases (dead-letter
  T7, archive T5) hit the 5 s per-test timeout on a cold/first run and passed
  on rerun — pre-existing latency flake, unrelated to this diff.
