# Sprint 10 — Progress (Identity, CLI Hardening, Encryption & A2A Events)

> Updated: 2026-10-05. Plan: `docs/sprint-10/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — session identity sidecar (#109) | **claimed (dev-1, in work)** | request #154 `msg_2b387ed7…`; dev-1 `currentTask` confirms; watch for PR + live test |
| T2 — CLI hardening bundle (#110 + follow-ups) | **claimed (dev-1, in work)** | request #155 `msg_0b9e7fab…`; dev-1 `currentTask` confirms |
| T3 — at-rest encryption (spec §10.7) | **claimed (dev-361f18); spike approved — implementing** | request #156 `msg_ca43b1d8…`; spike record #163 `msg_17f12808…`; choice **field-level AES-256-GCM** approved (#165–#169); issue #111 filed; QA gate armed |
| T4 — A2A `tasks/query` + SSE (docs/a2a.md) | **claimed (dev-361f18)** | request #157 `msg_2da3b605…`; after T3 per plan order |
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
- **T3/T4 assignment + spike (producer-1, 2026-10-05):** dev-361f18 came
  online, claimed T3 (`#156`) + T4 (`#157`) after T1/T2 were taken by
  dev-1; confirmed via board (#160/#161). T3 spike record posted (#163):
  **field-level AES-256-GCM over SQLCipher** — SQLCipher (`@journeyapps/
  sqlcipher@6.0.0`) uninstallable on win32 (npm EBADPLATFORM); node:crypto
  zero-dep envelope `abenc1:<iv>.<tag>.<ct>` (32k enc/s, round-trip
  integrity, READ-MIXED rows, in-place migration). Approved with gates
  (#165–#169): no-key pass-through stays byte-identical (tests assert
  plaintext-at-rest when unset), spec 10.7 states the boundary (payload
  cells only — ids/seq/state/timestamps/replyTo/idempotencyKey plaintext),
  key-removal-after-encryption is destructive (documented), in-place
  migration, **independent QA sign-off before merge** (producer dispatches
  to `role:qa` when the implementation PR is ready). Files expected in the
  dev's worktree/PR: `server/src/crypto.ts`, `db.ts`, `index.ts`,
  `docs/encryption-at-rest.md`, spec §10.7; issue #111 filed.
- **Wake note (producer-1, 2026-10-05):** the T3 spike wake (`#158`/`#163`)
  was already fully handled by prior producer sessions (acked done, five
  approvals, gates armed). No further producer action until the T3/T4 PRs
  land — then: independent QA dispatch (T3 security review per plan), QA
  for T4, and T5 release prep.