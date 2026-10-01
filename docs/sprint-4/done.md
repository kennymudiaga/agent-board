# Sprint 4 — Done (chunk 1: The A2A Front Door)

> Chunk 1 closed: 2026-10-01. Plan: `docs/sprint-4/plan.md`.

## Shipped

| Task | PR | Merge | Notes |
|---|---|---|---|
| T1 — fix #46 (MCP read-only test) | #47 | `3e520f0` | 92/92 suite; root cause: ambient `AB_ROLES` leaked into the MCP test identity |
| T2 — `ab init --global` (#41) | #48 | `6d60994` | env > local > global; per-OS config dir; token rules #25/#26 hold; `whoami` reports source |
| T3 — A2A relay (headline) | #49 | `308f8ca` | Agent Card + JSON-RPC `tasks/send\|get\|cancel`; thread→task mapping; §5.9 agent-token auth; live demo passed; **QA sign-off PASS** (`docs/qa/sprint-4-signoff.md`) |
| T4 — OpenDevin polish | #50 | `db74f63` | quickstart verified vs v0.2.1; MCP-not-in-npm drift fixed |

- Issues closed: **#46**, **#41**. Suite: 99 `npm test` (+4 VS Code Test Runner) green; CI 3/3 per PR.
- All four tasks dispatched, claimed, and completed **entirely via the board**
  (requests #20–#23 → responses #24–#28) with zero human paste; QA sign-off
  requested via #32 and delivered by a **spawned** worker (`qa-4a0b27`, `ab
  spawn` dogfood).

## Dogfood notes

- `ab spawn` worked end-to-end but the first spawn's process tree was killed
  by the launching shell; the worker survived re-parented and completed the
  whole review anyway (and a second spawn was needed to be sure). Spawn from
  a detached process when the launching session must end.
- A QA session's ambient `AB_AGENT_ID` leaks into `runCli` test children —
  harness hygiene follow-up filed in the sign-off doc.
- Producer reconciliation: the chunk plan commit was initially local-only;
  rebased onto the PR #47 merge and pushed (`83e5fe2`, includes
  `docs/wake-on-mail.md`).

## Chunk 2 (next)

wake-on-mail (`docs/wake-on-mail.md`), token rotation & expiry, broadcast
read-state, dashboard delivery detail, federation, encryption.