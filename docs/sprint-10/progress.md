# Sprint 10 — Progress (Identity, CLI Hardening, Encryption & A2A Events)

> Updated: 2026-10-05. Plan: `docs/sprint-10/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — session identity sidecar (#109) | **claimed (dev-1, in work)** | request #154 `msg_2b387ed7…`; dev-1 `currentTask` confirms; watch for PR + live test |
| T2 — CLI hardening bundle (#110 + follow-ups) | **claimed (dev-1, in work)** | request #155 `msg_0b9e7fab…`; dev-1 `currentTask` confirms |
| T3 — at-rest encryption (spec §10.7) | dispatched | request #156 `msg_ca43b1d8…`; queued for dev (design-first, independent QA) |
| T4 — A2A `tasks/query` + SSE (docs/a2a.md) | dispatched | request #157 `msg_2da3b605…`; queued for dev |
| T5 — release v0.5.0 | planned | after T1–T4 + QA; human approval before publish |

## Verification record

- **Kickoff (producer-1, 2026-10-05):** wake-up feature live-tested on
  `sprint-10` (5 probes + organic mail: agent/role addressing fire, role
  filter + wake-loop guard silent, never-claims — all messages stayed
  `pending` until producer pickup, `attempts:1`). Dogfood findings filed:
  #109 (bootstrap `as <role>` clobbers workspace identity — reproduced at
  kickoff, dev-1 contributed via board note) and #110 (win32 `--exec`
  multi-word quoting gap). Sprint-9 non-blocking follow-ups carried in
  (T2): `AB_WAKE_RESOLVE_MS` NaN, `--log` ENOENT. Plan approved by human;
  T1 + T2 dispatched 2026-10-05.