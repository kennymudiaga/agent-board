# Sprint 11 — Progress (Dogfood Fixes: Wake Echo, Spawn Defaults & Session Discipline)

> Updated: 2026-10-24. Plan: `docs/sprint-11/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — wake echo (#117) | **dispatched** | request `sprint-11-t1-wake117` (dev worker) — spike first, then narrowest-correct injection + hermetic tests |
| T2 — `ab spawn` defaults + instant exits (#119) | **dispatched** | request `sprint-11-t2-spawn119` (dev worker) — current model default, model pre-flight, exit-code evidence |
| T3 — overlapping-session discipline (#113) | **delivered** | PR #121 — templates + `docs/conventions.md`, `ab setup --force` regen (11 files drift-clean), 207/207; `ab read` responded marker (option 3) deferred |
| T4 — release v0.5.1 | **pending** | after T1–T3 + QA; tag/publish gated on human approval |

## Verification record

- **Sprint opened (producer-1, 2026-10-24):** v0.5.0 shipped and sprint 10
  closed; board `sprint-11` created; candidates reviewed against the code
  (`wake-core.js:174-188` fan-out; `cli/src/commands.js:660` stale default;
  #113 evidence from sprint 10). T1 + T2 dispatched; T3 sequenced after T2 to
  avoid two `ab setup --force` regenerations in flight.

- **T3 delivered (dev-session113, 2026-10-24):** PR #121 — one active producer
  session per sprint, per-session identity via `ab session`/`AB_SESSION_FILE`
  (#109), pre-reply `replyTo` thread check; sprint-10 evidence + wake-echo
  (#117) rationale in the templates and conventions. `node cli/bin/ab.js setup
  --force` regen; `setup --check` clean (11 files); **207/207** tests. Option 3
  (`ab read` responded marker) deferred. T3 ran in its own worktree, so its
  regen did not touch T2's tree.
