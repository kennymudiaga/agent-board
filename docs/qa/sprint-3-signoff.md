# Sprint 3 — QA Sign-off

> QA review of `docs/sprint-3` implementation (branch `feature/sprint-3`, PR #36).
> Reviewer: QA Engineer (Ivy) · Date: 2026-10-01 · Scope: T1–T8 + A2A spike (spec v0.2.1)
> **Re-review: 2026-10-01 (fix commits `786c797`/`60db829`, issues #37/#38/#39) — see §8.**

## Verdict (final, after remediation)

**✅ PASS** — the sprint-3 security blocker (#39) is fixed and re-verified live;
both dogfood kinks (#37, #38) verified. PR #36 is clear to merge from QA.

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` | 48 | 48 | 0 | incl. new #39 regression (2 tests: for-mismatch 401 for token + workspace flows) |
| `server/test/dashboard.test.ts` | 5 | 5 | 0 | |
| `mcp/test/tools.test.js` | 8 | 8 | 0 | |
| `mcp/test/e2e.test.js` | 3 | 3 | 0 | |
| `vscode-ext/test/board.test.js` | 5 | 5 | 0 | |
| `cli/test/cli.test.js` | 19 | 19 | 0 | incl. env-only join boards persistence (#37), help text (#38) |
| **Total** | **88** | **88** | **0** | (was 86; 2 new regression tests) |

- `npm run build` (tsc, strict): clean.
- CI on the fix head: **3/3 jobs green** (`build-and-test`, `extension-ui`, `docker`).
- npm v12 clean-`ci` + 86/86 re-verified in a temp copy (earlier round; unaffected by the fix).

## 2. Live re-verification (dogfood server on :8080)

- **#39 (security blocker):** minted a `qa-1` token; `GET .../messages?for=dev-1` with the token → **401 "for must match the authenticated agent id"**. Workspace token with identity producer-1 + `for=dev-1` → **401** (binding tightened for all authenticated callers). `for=self` → works. Identity-less + `for=dev-1` → observability view, `for` ignored, never claims. Victim message claimed fresh by its owner (attempts=1, claimAgent=dev-1). **Impersonation impossible.**
- **#37 (env-only membership):** env-only `ab join --board sprint-3` → config written with `boards` only (**no token on disk**); env-only heartbeat → membership registered; agent visible in `?board=sprint-3` directory; **broadcast delivery reached the env-only member** (delivery rows created, member picked it up).
- **#38 (help text):** `ab --help` lists `AB_ROLES (comma-separated)` in env overrides and the `--key` alias.

## 3. Bugs filed (all resolved)

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#37](https://github.com/kennymudiaga/agent-board/issues/37) | minor | env-only identities couldn't join boards (no membership persisted) | ✅ verified fixed |
| [#38](https://github.com/kennymudiaga/agent-board/issues/38) | minor | `ab --help` omitted AB_ROLES | ✅ verified fixed |
| [#39](https://github.com/kennymudiaga/agent-board/issues/39) | **major** | per-agent token impersonation via pickup `?for=` | ✅ verified fixed |

## 4. Non-blocking notes

- **Spec doc debt:** `docs/spec.md` §5.4 still documents `for` as "Who to fetch for (delivery matching against to)" — the implementation now binds `for` to the authenticated identity (401 on mismatch). Spec should be amended to match (one line).
- **MCP `read` watermark:** not persisted by the tool — the agent passes `since` explicitly. Documented in mcp.md per fix commit `60db829`.
- **MCP `send`:** `message`+`payload` both given → silently prefers payload (CLI errors) — fixed in `60db829` to reject.
- Test pollution cleaned up after verification (test tokens revoked, test messages acked).

## 5. Sign-off (final)

- Automated tests: **88/88 pass** (2 new regression tests).
- Manual playthrough: #39, #37, #38 re-verified live; full sprint-3 feature set verified in the earlier round.
- Blocker status: **none**.
- Sign-off: ✅ **PASS** — PR #36 clear to merge; issues #37–#39 ready for the Producer to close.
