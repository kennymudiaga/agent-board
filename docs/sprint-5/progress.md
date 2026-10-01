# Sprint 5 — Progress (Wake-on-Mail)

> Updated: 2026-10-01. Plan: `docs/sprint-5/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — `ab watch` (#51) | PR #60 up, **conflict vs main needs rebase** (same files as #58/#59); dev-3 notified | 107/107 at PR head; SSE push + polling fallback, read-only never-acks, `AB_WATCH_*` env briefs, `wake:*` vocabulary in conventions §8 |
| T2 — opencode wake plugin (#52) | dev-3 **spike in progress** (`.opencode/plugin/` in tree) | — |
| T3 — vscode-ext watcher (#53) | not started | — |
| T4 — cli.test.js hygiene (#54) | **MERGED** | PR #59 (`e5aa4379`); runCli clears all `AB_*`; suite-count note in conventions |
| T5 — token expiry + rotation (#55) | **MERGED — QA PASS** | PR #61 (`b5e71af3`); QA `qa-926f1e` 110/110, tokens 6/6; #55 closed; sign-off → `docs/qa/sprint-5-signoff.md` |
| T6 — broadcast read-state (#56) | **MERGED** | PR #62 (`648a3b2`); decision: keep copy-per-member + `reads` aggregate; spec §10.4 resolved |
| T7 — dashboard delivery detail (#57) | **MERGED** | PR #63 (`e00c37d`); per-reader reads expander |
| — dogfood fix: env identity clobbering config | **MERGED** | PR #58 (`27041e2`); `saveConfig` persists `fileValues` only — env never leaks into deliberate config |

## Notes

- dev-3 claimed all seven requests within ~10 min of kickoff and shipped 6 PRs
  in under 30 min (fastest sprint yet); all CI 3/3 green.
- #60 (`ab watch`) branch update hit a merge conflict after #58/#59 merged
  (shared files: `cli/src/config.js`, `cli/src/commands.js`, `cli/test/`);
  dev-3 is rebasing (was on `feat/ab-watch-51` with T2 spike files in tree).
- QA sign-off executed by spawned worker `qa-926f1e` (detached `ab spawn`).
  Follow-up: spawned-worker response payloads truncate (~280 chars) — worth
  a hygiene task (long replies should be split or summarized).
- Open: T1 merge (post-rebase), T2 spike + PR, T3 PR, T5 sign-off doc, T6/T7
  issue closes (#56, #57).