# Sprint 2 — QA Sign-off

> QA review of `docs/sprint-2` implementation (branch `feature/sprint-2`, PR #20).
> Reviewer: QA Engineer (Ivy) · Date: 2026-09-30 · Scope: T1–T7 (spec v0.2.0)
> **Re-review: 2026-09-30 (fix commit `9d17433`) — see §8.**

## Verdict (final, after remediation)

**✅ PASS** — all five filed bugs (#21–#25) are fixed, regression-tested, and re-verified live. PR #20 is cleared for merge. One minor follow-up regression (#26) was found in the #25 fix and filed; it does not block.

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` | 45 | 45 | 0 | incl. regressions for #22 (done-wins), #23 (409 requeue), #24 (strict ISO) |
| `server/test/dashboard.test.ts` | 5 | 5 | 0 | |
| `vscode-ext/test/board.test.js` | 5 | 5 | 0 | incl. #21 reconnect regression (flaky SSE endpoint) |
| `cli/test/cli.test.js` | 13 | 13 | 0 | incl. #24 CLI validation, #25 env-token regression |
| **Total** | **68** | **68** | **0** | (was 63; 5 new regression tests) |

- `npm run build` (tsc, strict): clean.
- CI on fix commit `9d17433`: **both jobs green** (`build-and-test` + `docker`).

## 2. Manual re-verification (live server, fresh DB)

All five original repros re-run and passing:

- **#21 (major):** watcher connected → server process killed → restarted on the same port → watcher **reconnected** (`connect` event) → post-restart broadcast delivered (`message` event). Full SSE recovery confirmed live, not just via the flaky-endpoint unit test.
- **#22:** broadcast `ttl:60`, one reader `done` before expiry → after sweep `state: "done"` with deliveries `{qa-1:done, reviewer-1:expired}` — "any done wins" holds.
- **#23:** zero-member broadcast requeue → **409 `state_conflict`** (honest), message still `dead`; spec §5.7 updated.
- **#24:** `"March 5, 2025"` → 422, timezone-less → 422, `...Z` / `...+02:00` → 201. Server + CLI both strict; spec §3.1 clarified.
- **#25:** env-only `read` → config contains cursors only (no token, no server). ✅

## 3. Bugs filed across both review rounds

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#21](https://github.com/kennymudiaga/agent-board/issues/21) | major | VS Code panel stale on SSE drop (no reconnect) | ✅ verified fixed |
| [#22](https://github.com/kennymudiaga/agent-board/issues/22) | minor | Broadcast aggregate: expired overrides done on TTL expiry | ✅ verified fixed |
| [#23](https://github.com/kennymudiaga/agent-board/issues/23) | minor | Zero-member requeue silent no-op | ✅ verified fixed |
| [#24](https://github.com/kennymudiaga/agent-board/issues/24) | minor | Lax deadline validation (non-ISO, local-time parsing) | ✅ verified fixed |
| [#25](https://github.com/kennymudiaga/agent-board/issues/25) | minor | Env-only identity writes plaintext token to disk | ✅ verified fixed (reported case) |
| [#26](https://github.com/kennymudiaga/agent-board/issues/26) | minor | **New regression from #25 fix:** `AB_TOKEN` set in env silently erases a stored token from an existing config | open — non-blocking |

## 4. What passed review (no issues found)

- #21 fix: reconnect backoff (1s→2s→…cap 30s, reset on connect), `close()` aborts in-flight stream + clears retry timer, heartbeat timer cleared on panel dispose — correct.
- #22 fix: sweep recomputes aggregates for all broadcasts (not just pending/claimed) — correct.
- #23 fix: zero-delivery broadcast → `wrongState` → 409; spec §5.7 documents it.
- #24 fix: `isValidIso8601Utc` regex + `Date.parse` — rejects natural language and timezone-less strings; accepts `Z`/`±hh:mm` (1–3 fractional digits).
- #25 fix: `fromEnv`/`tokenFromEnv` tracking; pure-env runs persist cursors only.
- All core protocol work from the first review round (watermark, fan-out, deadlines, dead-letter) — unchanged, still verified.

## 5. Claim vs. reality check (remediation round)

| Claim | Reality |
|---|---|
| "68/68 green" | ✅ confirmed |
| "Build clean" | ✅ confirmed |
| "CI re-run pending" | ✅ confirmed green on `9d17433` |
| "#21 reconnect regression test" | ✅ confirmed + **verified live with real server kill/restart** |
| "#22/#23/#24/#25 regression tests" | ✅ all confirmed live |

## 6. Open item (non-blocking)

- **#26:** `saveConfig` drops a *stored* file token whenever `AB_TOKEN` is present in the environment (the #25 guard is broader than intended). Recoverable via `ab init`; recommend fixing in the next pass with a test for "existing config + env var set". Not a merge blocker.

## 7. Sign-off (final)

- Automated tests: **68/68 pass** (5 new regression tests).
- Manual playthrough: all five original repros pass; #21 verified with a real kill/restart cycle.
- Blocker status: **none**.
- Sign-off: ✅ **PASS** — PR #20 clear to merge. Producer: triage #26 (minor) for the next pass.
