# Sprint 5 — Done (Wake-on-Mail)

> Sprint closed: 2026-10-03. Plan: `docs/sprint-5/plan.md`.

## Shipped

| Task | PR | Merge | Notes |
|---|---|---|---|
| T1 — `ab watch` (#51) | #60 | `20c6dd5` | SSE push + poll fallback; read-only never-acks; `AB_WATCH_*` env briefs; `wake:*` vocabulary in conventions §8; extension-ui CI flake re-run green |
| T2 — opencode wake plugin (#52) | #64 | `32381a2` | **QA PASS**; spike findings in `docs/wake-on-mail.md`; live demo: session woken by a board request, answered via `ab`, request `done` — the Autonomous A2A demo |
| T3 — vscode-ext watcher (#53) | #65 | `4d0f368` | notification + sidebar bump + opt-in headless (`vscode.lm` consent-gated); `ab heartbeat --capabilities`; UI host-wiring test |
| T4 — cli.test.js hygiene (#54) | #59 | `e5aa4379` | `runCli` clears all `AB_*`; suite-count methodology note |
| T5 — token expiry + rotation (#55) | #61 | `b5e71af` | **QA PASS**; `ttlDays`, `401 token_expired`, `--rotate`; spec §5.9 amended |
| T6 — broadcast read-state (#56) | #62 | `648a3b2` | decision: keep copy-per-member + `reads` aggregate; spec §10.4 resolved |
| T7 — dashboard delivery detail (#57) | #63 | `e00c37d` | per-reader reads expander |
| — dogfood fix: env-identity config clobber (#58) | #58 | `27041e2` | `saveConfig` persists `fileValues` only |
| — dogfood fix: parseArgs short-flag bug (#66) | #66 | `3482b6e` | `--dry-run -f x` no longer swallows `-f` |

- All 7 sprint issues (#51–#57) closed; suites 124/124 (`npm test`) + UI suite green at close.
- Every task dispatched, claimed, PR'd, and merged **via the board**; QA sign-offs executed by spawned workers (`qa-926f1e`, `qa-7b0046`).

## The Autonomous A2A Demo (sprint acceptance)

Achieved by T2's live demo (recorded in PR #64): an A2A-style board request
landed, the opencode wake plugin **woke a running session** (no polling
session), the agent answered via `ab` (read → send response → ack done), and
the request reached `done`. The stop-the-polling loop is real.

## Follow-ups filed

- **#67** — spawn children inherit file cursors → can miss mail (fix in a follow-up sprint).
- **#68** — spawned-worker response truncation ~280 chars.
- CI note: extension-ui job flaked once on a CLI-only PR (11s infra failure) — re-run cleared; watch for recurrence.