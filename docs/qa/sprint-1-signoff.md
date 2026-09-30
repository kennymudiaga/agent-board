# Sprint 1 — QA Sign-off

> QA review of `docs/sprint-1` implementation (branch `feature/sprint-1`, PR #7).
> Reviewer: QA Engineer (Ivy) · Date: 2026-09-30 · Scope: T1–T6
> **Re-review: 2026-09-30 (fix commit `ca9dc88`) — see §8.**

## Verdict (final, after remediation)

**✅ PASS** — all four filed bugs (#8–#11) are fixed, regression-tested, and re-verified live. PR #7 is cleared for merge pending Producer sign-off of the spec amendment (§4/§5.4).

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` (integration) | 19 | 19 | 0 | incl. regression tests for #9, #10 + updated auth contract |
| `server/test/dashboard.test.ts` | 5 | 5 | 0 | incl. 2 regression tests for #8 (identity-less fetches, no-claim) |
| `cli/test/cli.test.js` (CLI as subprocess) | 8 | 8 | 0 | incl. regression tests for #10 (join) and #11 (cursor watermark) |
| **Total** | **32** | **32** | **0** | (was 26 at first review; 6 new regression tests) |

- `npm run build` (tsc, strict): clean.
- CI on fix commit `ca9dc88`: **success**.
- Coverage gap from first review (dashboard REST fetches untested) — **closed**: dashboard.test.ts now exercises exactly what `dashboard.html`'s `refresh()` does.

## 2. Manual verification (live server, fresh DB)

Happy path: heartbeat → send → pickup (claimed, attempts=1, claimAgent) → ack done → no redelivery — passed. SSE `hello` confirmed.

## 3. Bugs filed (first review)

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#8](https://github.com/kennymudiaga/agent-board/issues/8) | major | Dashboard REST fetches 401 (missing X-Agent-ID) | ✅ verified fixed |
| [#9](https://github.com/kennymudiaga/agent-board/issues/9) | major | `ttl: 0` messages expire instantly (spec: 0 = no expiry) | ✅ verified fixed |
| [#10](https://github.com/kennymudiaga/agent-board/issues/10) | minor | Heartbeat/join accept invalid board names | ✅ verified fixed |
| [#11](https://github.com/kennymudiaga/agent-board/issues/11) | major | `read --ack claimed` advances cursor past non-finalized msg (at-least-once violation) | ✅ verified fixed |

## 4. What passed review (no issues found)

- Spec (`docs/spec.md`), lifecycle, presence, idempotency, error envelope, CLI watermark rule (non-ack paths), SSE stream, T4 docs, T5 CI — unchanged from first review, all still correct.

## 5. Claim vs. reality check

| Claim | Reality |
|---|---|
| "26 tests green" (first review) | ✅ confirmed |
| "32/32 green after remediation" | ✅ confirmed (19+5+8) |
| "build clean" | ✅ confirmed |
| "CI green on fix commit" | ✅ confirmed |
| "Dashboard fetches re-verified live; dashboard render now works" | ✅ confirmed — identity-less GETs return data without claiming; agent pickup still claims fresh |
| "ttl: 0 aged 1h still delivered" | ✅ confirmed (live: ttl normalized to null, delivered) |
| "Redelivery arrives after lease expiry (attempts=2)" | ✅ confirmed end-to-end via CLI |

## 6. Blockers (resolved)

1. ~~#8 dashboard non-functional~~ → fixed via read-only GET exemption; spec §4/§5.4 amended consistently; **note for Producer**: auth model changed — identity-less GETs are now part of the contract (read-only observability), mutating endpoints still require `X-Agent-ID`.
2. ~~#9 ttl:0 data loss~~ → fixed at insert (0→NULL) + sweep guard (`ttl > 0`) for legacy rows.
3. ~~#11 at-least-once violation~~ → cursor advances only on done/failed.

## 7. Re-review details (2026-09-30, commit `ca9dc88`)

- **#8:** identity-less `GET /v1/agents` → 200 w/ data; identity-less `GET /v1/boards/x/messages` → 200, `state=pending, attempts=0` (no claim); `wait=30` returned in 2ms (no long-poll); agent pickup after dashboard read still claims (`attempts=1, claimAgent=qa-1`); mutating POST without identity → 401.
- **#9:** `ttl: 0` post → `"ttl": null`; pickup delivered; not present in `?status=expired`.
- **#10:** heartbeat `boards:["BAD BOARD!"]` → 422, agent not registered; `ab join --board 'BAD BOARD!'` → error, exit 1, config untouched.
- **#11:** `read --ack claimed` → cursor persisted at 0; lease expired server-side; fresh `ab read` process received the redelivery (attempts=2). At-least-once preserved.

## 8. Sign-off (final)

- Automated tests: **32/32 pass** (incl. 6 new regression tests).
- Manual playthrough: all four original repros now pass.
- Blocker status: **none**.
- Sign-off: ✅ **PASS** — PR #7 clear to merge (Producer: please review the spec §4/§5.4 auth amendment noted on issue #1/#8 before merge).
