# Sprint 1 — QA Sign-off

> QA review of `docs/sprint-1` implementation (branch `feature/sprint-1`, PR #7).
> Reviewer: QA Engineer (Ivy) · Date: 2026-09-30 · Scope: T1–T6

## Verdict

**❌ BLOCKED** — do not merge PR #7 until the two `severity: major` server bugs (#8, #9) are fixed and re-verified. The core agent loop (the sprint's goal) works; the blockers are correctness bugs in shipped features, not demo-path failures.

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` (integration) | 17 | 17 | 0 | full lifecycle, idempotency, addressing, retry→dead, lease, long-poll, ttl, ack conflicts, validation, presence, directory filters |
| `server/test/dashboard.test.ts` | 3 | 3 | 0 | static page, SSE auth, SSE events — **does not exercise the dashboard's own REST fetches** |
| `cli/test/cli.test.js` (CLI as subprocess) | 6 | 6 | 0 | init, auth, full lifecycle, idempotency 409, retry→dead, auto-ack/conflicts, validation |
| **Total** | **26** | **26** | **0** | |

- `npm run build` (tsc, strict): clean.
- CI on PR #7 (`build-and-test`): latest run **success** (two earlier failures fixed by the lockfile-sync commit `4634c82`).
- Docker: not re-run locally this review (Windows host); Dockerfile review is sound (multi-stage, node:22-bookworm-slim, `/data` volume, healthcheck). Dev team reports a full container lifecycle pass in `progress.md`.

## 2. Manual verification (live server, port 8099)

Happy path — **passed**: heartbeat → send → pickup (claimed, attempts=1, claimAgent) → ack done → no redelivery. SSE `hello` event confirmed. Idempotency 409, retry→dead, lease expiry, long-poll wake, presence derivation all verified by the integration suite and spot-checked live.

## 3. Bugs filed (all reproduced)

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#8](https://github.com/kennymudiaga/agent-board/issues/8) | **major** | Dashboard cannot load any data — REST fetches 401 (missing `X-Agent-ID`; middleware requires it on `/v1/agents` + messages GET; dashboard JS only sends `Authorization`). Presence/board sections never render. | open |
| [#9](https://github.com/kennymudiaga/agent-board/issues/9) | **major** | `ttl: 0` messages expire instantly — sweep treats `created_at + 0 < now` as expired; spec §3.1 says `0` = no expiry. Message goes terminal `expired`, never delivered. | open |
| [#10](https://github.com/kennymudiaga/agent-board/issues/10) | minor | Heartbeat accepts invalid board names (`"BAD BOARD!"`) → permanent unreachable board row; spec §2 requires identifier regex. CLI `ab join` also unvalidated. | open |
| [#11](https://github.com/kennymudiaga/agent-board/issues/11) | **major** | `ab read --ack claimed` advances the persisted cursor past a lease-renewed (not finalized) message; after crash + lease expiry the redelivery is silently skipped — violates spec §6.2 client watermark rule and at-least-once. Reproduced end-to-end. | open |

## 4. What passed review (no issues found)

- Spec (`docs/spec.md`) is complete and internally consistent; deviations in §10 are documented and raised on issue #1.
- Core lifecycle: pending → claimed (5-min lease) → done/failed → retry (max 3) → dead; lazy lease/ttl sweep; idempotency 409 with `originalMessageId` — all correct.
- Presence derivation (TTL = 3×interval), directory filters, server-side timestamps, error envelope/codes per spec §8.
- CLI watermark rule for `read` **without** `--ack` (cursor only advances on ack done/failed) — correct; only the `--ack claimed` path is wrong (#11).
- SSE stream (`/v1/events`): auth via query param, `hello`/`message`/`agent`/`ping` events — correct (dashboard's *use* of it is broken, #8).
- T4 deliverables (`.opencode/agent/board.md`, `quickstart.md`): accurate against the actual CLI surface; troubleshooting table matches observed behavior.
- T5 CI: workflow correct; status check green on the PR.

## 5. Claim vs. reality check (progress.md / done.md)

| Claim | Reality |
|---|---|
| "26 tests green" | ✅ confirmed |
| "build clean" | ✅ confirmed |
| "CI green on PR" | ✅ confirmed (latest run) |
| "Docker build/run + demo executed" | ⚠️ not re-run locally (Windows); consistent with code and dev-team report |
| "Dashboard smoke test: page 200, agents online/busy with currentTask visible" | ❌ **not reproducible** — dashboard data fetches always 401 (#8). Page 200 yes; data rendering no. |
| "Full lifecycle + zero-paste demo" | ✅ core loop verified live (send → pickup → ack → response via reply-to) |

## 6. Blockers & recommendation

- **Blocker 1 (#8):** T6 dashboard is effectively non-functional (no data ever renders). Fix (dashboard identity / read-only GET exemption) + add a dashboard integration test that exercises the REST fetches.
- **Blocker 2 (#9):** `ttl: 0` silently destroys messages (spec violation, data loss). Normalize `0` → `NULL` at insert or exclude from sweep; add a regression test.
- **Recommendation:** fix #11 in the same pass (small, one-line + test) and #10 if time permits. All four are low-risk, well-scoped fixes.

## 7. Sign-off

- Automated tests: 26/26 pass (but coverage gap: dashboard REST fetches untested).
- Manual playthrough: happy path green; 4 bugs filed, 3 major, 1 minor.
- Blocker status: **BLOCKED** until #8 and #9 are fixed and re-verified (re-run full suite + dashboard render check).
- Sign-off: ❌ **BLOCKED**

Reported to Producer: sign-off doc + issue links.
