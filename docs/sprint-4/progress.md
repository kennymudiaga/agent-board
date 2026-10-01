# Sprint 4 — Progress (chunk 1: The A2A Front Door)

> Updated: 2026-10-01. Plan: `docs/sprint-4/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — fix #46 (MCP read-only test) | **MERGED** | PR #47 (`3e520f0`), CI 3/3, suite 92/92, issue #46 closed |
| T2 — `ab init --global` (#41) | **MERGED** | PR #48 (`6d60994`), CI 3/3, 96/96 local, issue #41 closed |
| T3 — A2A relay (headline) | **MERGED — QA PASS** | PR #49 (`308f8ca`), CI 3/3, 99/99 `npm test` (+4 VS Code Test Runner); QA sign-off `docs/qa/sprint-4-signoff.md` |
| T4 — OpenDevin polish | **MERGED** | PR #50 (`db74f63`), docs-only drift fixes (MCP not in npm CLI; stray pip line) |

**CHUNK 1 SHIPPED — see `docs/sprint-4/done.md`.**

## Notes

- All four tasks were claimed and completed by dev-3 within ~40 minutes of
  dispatch, entirely via the board (no human paste). T1–T4 requests: #20–#23.
- T3 blocked on QA sign-off (spawned worker `qa-7b90a9` reviewing PR #49).
- Producer reconciliation: the sprint-4 plan commit was initially local-only
  (branches cut from pre-plan `main`); rebased onto the PR #47 merge and
  pushed (`83e5fe2` includes plan + `docs/wake-on-mail.md`).
- Wake-on-mail design note landed (`docs/wake-on-mail.md`) — chunk-2 candidate.