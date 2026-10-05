# Sprint 10 — Progress (Identity, CLI Hardening, Encryption & A2A Events)

> Updated: 2026-10-05. Plan: `docs/sprint-10/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — session identity sidecar (#109) | **in work (dev-1)** | dev-1 holds branch `feat/session-sidecar-109` (T1 coded + tested); claims at #154 (attempts 2, held by dev-361f18 pending lapse → dev-1 redelivery); reassignment confirmed to dev-1 (multiple producer messages) |
| T2 — CLI hardening bundle (#110 + follow-ups) | **in work (dev-1)** | same branch track; T2 next after T1 (#155, attempts 2) |
| T3 — at-rest encryption (spec §10.7) | **COMPLETE — QA sign-off APPROVE** | PR [#112](https://github.com/kennymudiaga/agent-board/pull/112) (`feat/encryption-at-rest`, issue #111): field-level AES-256-GCM behind `AB_ENCRYPTION_KEY` (spike: SQLCipher EBADPLATFORM on win32 → rejected); 5 hermetic tests, 193/194 full-suite (1 pre-existing archive timeout on baseline); docs/encryption-at-rest.md + spec §10.7. **qa-1 sign-off at `c020049`** (crypto.ts AES-256-GCM/scrypt/abenc1 envelope/no-key pass-through/explicit missing-key error/GCM tamper detection, db.ts keyed paths verified). Merged by producer. |
| T4 — A2A `tasks/query` + SSE (docs/a2a.md) | **in work (dev-361f18)** | #157 claimed; implementation in progress; branch+PR pending |
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

- **Coordination (producer-1, 2026-10-05):** spawned worker `dev-361f18`
  (headless `opencode run --model opencode-go/deepseek-v4-flash`, separate
  session PID verified, works) claimed T3+T4; dev-1 (separate session,
  likely human UI) held T1+T2. Claim-ownership churn: dev-1 lapsed
  (long-turn), dev-361f18 reclaimed (attempts 2), then reassigned back to
  dev-1 (code delivery beats claim ownership; dev-361f18 standing down,
  claims lapsing → dev-1 redelivery). **Finding: overlapping producer-1
  sessions (human UI + woken sessions) all wake on the same mail → duplicate
  responses (QA dispatch ×4, spike approval ×5) — filed #113.**

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

- **T3 delivered + T1/T2 handoff (producer-1, 2026-10-05):**
  - dev-361f18 delivered T3 (PR #112, commit `037ad7c`, 5 hermetic tests;
    suite 195/196 — the archive failure is a pre-existing env timeout,
    repro'd on `origin/main` baseline). PR verified present + sound.
  - **QA dispatched** to `role:qa` for the security-sensitive sign-off
    (dispatched redundantly ×3 — #173/#174/#176; qa-1 picked up and is
    actively reviewing PR #112).
  - **T1/T2 handoff:** dev-1's claims lapsed mid-turn (long multi-file turn
    vs 5-min lease, #102 discipline) and dev-361f18 reclaimed them
    (attempts 2). dev-1 flagged in-flight WIP (branch
    `feat/session-sidecar-109`, T1 coded+tested). **Producer reassigned
    #154/#155 back to dev-1** (code delivery beats claim ownership);
    dev-361f18 stands down, leaving claims to lapse for dev-1 (ack #181).
    dev-1 online, continuing T1/T2 in the worktree; will renew claims
    aggressively going forward.
  - Producer sessions are noisy on this sprint (duplicate QA dispatches,
    duplicate approvals) — noted; the T1 sidecar fix targets the underlying
    shared-identity clobbering (#109).
- **T3 merged (producer-1, 2026-10-05):** PR #112 QA **PASS** (qa-1,
  consolidated — duplicate dispatches acked, single verdict). Both #112 and
  #114 were `CONFLICTING` vs main (conflict confined to
  `docs/sprint-10/progress.md`); #112 resolved by a producer session (head
  `edcc5f3`), **regular merged `3bec8895`**, #111 closed, board note to
  dev-361f18 (#206). #114 conflict resolved by producer (head `525073f`),
  CI running; merge pending T1/T2 QA sign-off + green CI.

- **T3 QA sign-off (qa-1, 2026-10-05):** **APPROVE** — independent security
  review of PR #112 at commit `c020049` (scratch worktree, full suite +
  build). crypto.ts (AES-256-GCM, scrypt key, `abenc1:` envelope, no-key
  pass-through, explicit missing-key error, GCM tamper detection) and db.ts
  keyed read/write paths verified. T3 complete: implementation + QA sign-off.