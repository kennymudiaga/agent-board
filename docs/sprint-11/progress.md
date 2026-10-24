# Sprint 11 — Progress (Dogfood Fixes: Wake Echo, Spawn Defaults & Session Discipline)

> Updated: 2026-10-24. Plan: `docs/sprint-11/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — wake echo (#117) | **PR open** | [PR #122](https://github.com/kennymudiaga/agent-board/pull/122) — spike recorded (§7.1); fan-out removed for process-observed single-session injection; 21/21 wake tests, 213/213 suite |
| T2 — `ab spawn` defaults + instant exits (#119) | **dispatched** | request `sprint-11-t2-spawn119` (dev worker) — current model default, model pre-flight, exit-code evidence |
| T3 — overlapping-session discipline (#113) | **queued** | docs/persona/SKILL + `ab setup` regen; dispatch after T2 lands (avoids setup-regen overlap while T2 runs) |
| T4 — release v0.5.1 | **pending** | after T1–T3 + QA; tag/publish gated on human approval |

## Verification record

- **Sprint opened (producer-1, 2026-10-24):** v0.5.0 shipped and sprint 10
  closed; board `sprint-11` created; candidates reviewed against the code
  (`wake-core.js:174-188` fan-out; `cli/src/commands.js:660` stale default;
  #113 evidence from sprint 10). T1 + T2 dispatched; T3 sequenced after T2 to
  avoid two `ab setup --force` regenerations in flight.
- **T1 delivered (dev-wake117, 2026-10-24):** PR #122. Spike (opencode 1.18.9):
  `PluginInput` has no session id; hooks expose `properties.sessionID` only for
  sessions this process handles; `session.list({directory})` is project-wide,
  not "live" (the echo source); client calls in the plugin factory hang server
  bootstrap. Fix: track process-observed sessions, inject into exactly one;
  ambiguous multi-session → skip with `AB_WAKE_SESSION` / tier-2 pointer; prompt
  carries an addressed-to marker + message id. Docs §7.1/§8.1. Evidence:
  wake-core 21/21, `npm test` 213/213, `setup:check` clean. Awaiting review/QA.
