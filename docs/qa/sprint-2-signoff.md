# Sprint 2 — QA Sign-off

> QA review of `docs/sprint-2` implementation (branch `feature/sprint-2`, PR #20).
> Reviewer: QA Engineer (Ivy) · Date: 2026-09-30 · Scope: T1–T7 (spec v0.2.0)
> **Re-review 1: 2026-09-30 (fix commit `9d17433`) — §8.**
> **Re-review 2: 2026-09-30 (fix commit `7e7005b`, #26) — §9.**

## Verdict (final)

**✅ PASS** — all six filed bugs (#21–#26) verified fixed. PR #20 is clear to merge.

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` | 45 | 45 | 0 | incl. #22/#23/#24 regressions |
| `server/test/dashboard.test.ts` | 5 | 5 | 0 | |
| `vscode-ext/test/board.test.js` | 5 | 5 | 0 | incl. #21 reconnect regression |
| `cli/test/cli.test.js` | 14 | 14 | 0 | incl. #24, #25, #26 regressions |
| **Total** | **69** | **69** | **0** | (was 63; 6 new regression tests) |

- `npm run build` (tsc, strict): clean.
- CI on head `7e7005b`: **both jobs green** (`build-and-test` + `docker`).

## 2. Manual verification

Round 1 (live, fresh DB): fan-out per-reader independence, watermark crash test (#12), deadlines/late responses, dead-letter sender-gating, sprint-1 regressions — all passed.
Round 1 remediation (commit `9d17433`): #21 SSE reconnect verified with a real server kill/restart; #22 done-wins aggregate; #23 409 requeue; #24 strict ISO; #25 env-token — all re-verified live.
Round 2 (commit `7e7005b`): #26 four-case token matrix verified live (below).

## 3. Bugs filed (all verified fixed)

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#21](https://github.com/kennymudiaga/agent-board/issues/21) | major | VS Code panel stale on SSE drop | ✅ fixed (live kill/restart) |
| [#22](https://github.com/kennymudiaga/agent-board/issues/22) | minor | Broadcast aggregate: expired overrides done | ✅ fixed |
| [#23](https://github.com/kennymudiaga/agent-board/issues/23) | minor | Zero-member requeue silent no-op | ✅ fixed |
| [#24](https://github.com/kennymudiaga/agent-board/issues/24) | minor | Lax deadline validation | ✅ fixed |
| [#25](https://github.com/kennymudiaga/agent-board/issues/25) | minor | Env-only identity writes plaintext token | ✅ fixed |
| [#26](https://github.com/kennymudiaga/agent-board/issues/26) | minor | #25 regression: AB_TOKEN erases stored config token | ✅ fixed (see §9) |

## 8. Re-review 1 details (commit `9d17433`)

All five repros re-verified live; suite 68/68; #21 verified with real server kill/restart (connect → kill → restart → reconnect → message). Full details in the issue comments.

## 9. Re-review 2 details (commit `7e7005b`, issue #26)

Fix: `loadConfig` tracks `fileToken`; `saveConfig` writes `fileToken ?? (tokenFromEnv ? undefined : token)` — stored tokens are never erased, env tokens are never written. Verified live with a four-case matrix:

| Case | Setup | Result |
|---|---|---|
| A (#26 repro) | stored token `stored-token-123` + `AB_TOKEN` set to a different value | ✅ stored token survives, env token not written |
| B (#25 invariant) | env-only read, no config | ✅ cursors only on disk |
| C (edge) | config without token + `AB_TOKEN` set | ✅ env token not leaked |
| D (normal) | stored token, no env | ✅ token + cursors persist, read works |

No regressions found. Suite 69/69; CI green on `7e7005b`.

## 10. Sign-off (final)

- Automated tests: **69/69 pass** (6 new regression tests across the remediation rounds).
- Manual playthrough: all original repros + regression matrix verified live.
- Blocker status: **none**.
- Sign-off: ✅ **PASS** — PR #20 clear to merge; issues #21–#26 ready for the Producer to close.
