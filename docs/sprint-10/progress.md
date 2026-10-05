# Sprint 10 — Progress (Identity, CLI Hardening, Encryption & A2A Events)

> Updated: 2026-10-05. Plan: `docs/sprint-10/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — session identity sidecar (#109) | **MERGED + QA PASS** | PR [#114](https://github.com/kennymudiaga/agent-board/pull/114) (`feat/session-sidecar-109`, merge `62da63ce`) — `ab session` / `AB_SESSION_FILE` sidecar (precedence env > session > local > global; source:`session`; `--delete` sidecar-only); `.agentboard.json` byte-unchanged producer-1; 8 new hermetic tests; suite 198/199 (1 pre-existing archive timeout on baseline). qa-1 **PASS** at `d69b644` (no findings); CI green at `915d600`. #109 closed. |
| T2 — CLI hardening bundle (#110 + follow-ups) | **MERGED + QA PASS** | same PR #114: win32 `--exec` split guard (`execSplitWarnings`, non-fatal) + docs, `AB_WAKE_RESOLVE_MS` NaN coercion, `--log` missing-parent-dir friendly error; hermetic tests. #110 closed. |
| T3 — at-rest encryption (spec §10.7) | **MERGED + QA PASS** | PR [#112](https://github.com/kennymudiaga/agent-board/pull/112) (`feat/encryption-at-rest`, merge `3bec8895`, #111): field-level AES-256-GCM behind `AB_ENCRYPTION_KEY` (spike: SQLCipher EBADPLATFORM on win32 → rejected); 5 hermetic tests; `docs/encryption-at-rest.md` + spec §10.7. qa-1 **APPROVE** at `c020049` (crypto.ts envelope/scrypt/pass-through/tamper + db.ts keyed paths verified). #111 closed. |
| T4 — A2A `tasks/query` + SSE (docs/a2a.md) | **MERGED + QA PASS** | PR [#115](https://github.com/kennymudiaga/agent-board/pull/115) (`feat/a2a-query-sse`, merge `b22c1bc`) — `tasks/query` (filters) + `GET /a2a/:agentId/events` SSE (created/updated/canceled, per-agent-token auth, emit-time W4 workspace scoping); 3 hermetic tests incl. cross-workspace negative; 198/199 suite. qa-1 **PASS** at `7d24227`. |
| T5 — release v0.5.0 | **claimed (dev-1, in work)** | request #233 `sprint-10-t5` (claimed dev-1): version bumps 0.5.0 (root+cli+server+mcp+vscode-ext) + spec header + `ab setup --force/--check` + **ci.yml GHCR fix (#116)**; **ONE release PR, no tag/publish**; suite+build green. Tag → OIDC publish → GHCR → Release notes = producer step after the PR (human approval before publish). |

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
  responses (QA dispatch ×4, spike approval ×5, reassignment ×4) — filed
  #113.** Secondary symptom: `progress.md` merge conflict markers landed on
  main from parallel ledger edits (resolved in this commit).

- **T3 spike (dev-361f18, 2026-10-05):** **field-level AES-256-GCM over
  SQLCipher** — SQLCipher (`@journeyapps/sqlcipher@6.0.0`) uninstallable on
  win32 (npm EBADPLATFORM); node:crypto zero-dep envelope
  `abenc1:<iv>.<tag>.<ct>` (32k enc/s, round-trip integrity, READ-MIXED
  rows, in-place migration). Approved with gates: no-key pass-through stays
  byte-identical, spec 10.7 states the boundary (payload cells only),
  key-removal destructive (documented), independent QA before merge.

- **T1/T2 handoff (producer-1, 2026-10-05):** dev-1's claims lapsed
  mid-turn (long multi-file turn vs 5-min lease, #102 discipline) and
  dev-361f18 reclaimed them (attempts 2). dev-1 flagged in-flight WIP
  (branch `feat/session-sidecar-109`, T1 coded+tested). **Producer
  reassigned #154/#155 back to dev-1** (code delivery beats claim
  ownership); dev-361f18 stood down. dev-1 delivered PR #114.

- **T3 QA (qa-1, 2026-10-05):** **APPROVE** — independent security review of
  PR #112 at `c020049` (scratch worktree, full suite + build). crypto.ts
  (AES-256-GCM, scrypt key, `abenc1:` envelope, no-key pass-through,
  explicit missing-key error, GCM tamper detection) and db.ts keyed
  read/write paths verified. T3 complete.

- **T4 QA (qa-1, 2026-10-05):** **PASS** — consolidated, at `7d24227`
  (scratch worktree). tasks/query filters + validation, SSE lifecycle
  (submitted→working→completed), cross-workspace negative (B sees none of
  A's tasks; B's stream silent while A emits), demo client, docs/a2a.md.
  No findings.

- **Merges (producer-1, 2026-10-05):** T3 `3bec8895`, T1/T2 `62da63ce`,
  T4 `b22c1bc` (all regular merges; QA PASS on record). #109/#110/#111
  closed. Open findings: #113 (overlapping producer sessions), #116
  (ci.yml GHCR push failing on main pushes — must be fixed before the
  v0.5.0 release). Dead T1/T2/T4 requests purged by the producer session
  handling the ledger (deliveries on record via PRs/responses).