# Sprint 2 — QA Sign-off

> QA review of `docs/sprint-2` implementation (branch `feature/sprint-2`, PR #20).
> Reviewer: QA Engineer (Ivy) · Date: 2026-09-30 · Scope: T1–T7 (spec v0.2.0)

## Verdict

**❌ BLOCKED (one major)** — the core protocol work (T1 watermark, T2 fan-out, T3 deadlines, T7 dead-letter) is verified solid and the sprint demo scenarios all pass live. One major defect in the T4 VS Code extension (#21) blocks sign-off per sprint-1 precedent (major bug in a shipped feature). The fix is small and well-scoped; all other findings are minor.

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` | 42 | 42 | 0 | incl. watermark suite (4), fan-out suite (9), deadline suite (6), dead-letter suite (4) |
| `server/test/dashboard.test.ts` | 5 | 5 | 0 | |
| `vscode-ext/test/board.test.js` | 4 | 4 | 0 | fetchBoardState, watchBoard, formatters |
| `cli/test/cli.test.js` | 12 | 12 | 0 | incl. fan-out E2E, deadline E2E, dead/requeue/purge E2E, #12 watermark crash regression |
| **Total** | **63** | **63** | **0** | |

- `npm run build` (tsc, strict): clean.
- CI on sprint-2 head `284ffc0`: **both jobs green** — `build-and-test` + the new `docker` job (T6).
- `ab --version` → `ab 0.2.0` (T5). npm pack/install path verified by dev team.

## 2. Manual verification (live server, fresh DB)

All sprint-2 core scenarios reproduced live and passed:

- **Fan-out (T2):** broadcast → 3 deliveries (producer/qa/reviewer); each reader picked up **its own copy** (`delivery.state=claimed, attempts=1`); qa-1 failed 3× to `dead` while reviewer-1's copy stayed claimed — per-reader independence confirmed; observability shows per-reader delivery detail; zero-member broadcast → immediate `dead`; late joiner gets nothing.
- **Watermark crash test (T1, #12):** qa-1 claimed msg (watermark blocked at seq−1), "crashed"; newer message arrived and was finalized by reviewer-1; lease expired; qa-1 restart → **redelivery received, attempts=2**. The exact #12 scenario passes.
- **Deadlines (T3):** past-deadline question expires and is never delivered; response to expired question accepted with `late: true`; deadline on non-question → 422.
- **Dead-letter (T7):** 3 fails → dead → non-sender requeue **403** → sender requeue → pending (attempts=0) → redelivered (attempts=1) → non-sender purge **403** → sender purge ok.
- **Sprint-1 regressions:** identity-less GETs still work and never claim; `ttl: 0` still normalized to no-expiry; `ab join` still validates board names.

## 3. Bugs filed (all reproduced or code-confirmed)

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#21](https://github.com/kennymudiaga/agent-board/issues/21) | **major** | VS Code board panel goes permanently stale when the SSE stream drops — no reconnect, no poll fallback (comment claims a fallback that doesn't exist); zombie heartbeat timer after panel close | open |
| [#22](https://github.com/kennymudiaga/agent-board/issues/22) | minor | Broadcast aggregate wrong after TTL expiry: `expired` overrides a completed `done` delivery — violates spec §6.1 "any done wins" (verified live) | open |
| [#23](https://github.com/kennymudiaga/agent-board/issues/23) | minor | Requeue of a zero-member broadcast returns 200 but stays dead — silent no-op vs spec §5.7 (verified live) | open |
| [#24](https://github.com/kennymudiaga/agent-board/issues/24) | minor | `deadline` validation accepts non-ISO strings; timezone-less deadlines parsed in server-local time, not UTC (verified live) | open |
| [#25](https://github.com/kennymudiaga/agent-board/issues/25) | minor | Env-only identity: `ab read`/`ab join` write `.agentboard.json` with the **plaintext token** to disk, defeating the env-only design (verified live) | open |

## 4. What passed review (no issues found)

- T1 server watermark design (server-computed, not client heuristic) — correct and authoritative; the plan's client-side design note was rightly rejected (it cannot see crashed-run claims).
- T2 fan-out implementation — deliveries table, aggregate transitions, per-reader leases/retries, watermark interplay with deliveries — all consistent with spec §6.1/§6.2.
- T3 deadline/late semantics, T7 sender-gating (403/409 codes), SSE stream, spec v0.2.0 amendments — consistent with implementation.
- CI/release workflows (T5/T6): correct; Docker job green on CI.

## 5. Claim vs. reality check

| Claim | Reality |
|---|---|
| "63 tests green" | ✅ confirmed |
| "Build clean" | ✅ confirmed |
| "CI incl. Docker job green" | ✅ confirmed |
| "Broadcast reaches two readers independently" | ✅ confirmed live |
| "Crash test: redelivery after lease expiry (attempts=2)" | ✅ confirmed live |
| "Deadline question expires; late responses flagged" | ✅ confirmed live |
| "VS Code extension: live via SSE" | ⚠️ works while the stream is healthy; **goes permanently stale on any SSE drop** (#21) |
| "Demo executed (panel leg simulated via CLI)" | ⚠️ honest caveat in progress.md — extension host wiring not demo-verified (that's where #21 lives) |

## 6. Blockers & recommendation

- **Blocker (#21):** add SSE reconnect (backoff loop) or a poll fallback to `watchBoard`; clear the heartbeat timer on panel dispose. One file, ~15 lines, plus a reconnect unit test.
- **Recommended same-pass fixes:** #22 (recompute aggregates after expiry sweep), #23 (honest 409 or documented no-op), #24 (strict ISO-8601-UTC validation), #25 (don't persist env-provided tokens).
- **Non-blocking observations (not filed):** CLI `data.watermark ?? cursor` fallback does not fall back to `data.cursor` as the comment claims (v0.1-server compat only — functionally safe, never advances); broadcast ttl sweep vs "done wins" (#22) is the only aggregate inconsistency found.

## 7. Sign-off

- Automated tests: 63/63 pass.
- Manual playthrough: all core sprint-2 scenarios verified live; 5 bugs filed (1 major, 4 minor).
- Blocker status: **BLOCKED on #21** (VS Code extension SSE liveness).
- Sign-off: ❌ **BLOCKED** — core protocol clears; extension fix + re-verify #21, then PASS.
