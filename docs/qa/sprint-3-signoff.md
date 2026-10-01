# Sprint 3 — QA Sign-off

> QA review of `docs/sprint-3` implementation (branch `feature/sprint-3`, PR #36).
> Reviewer: QA Engineer (Ivy) · Date: 2026-10-01 · Scope: T1–T8 + A2A spike (spec v0.2.1)
> Board dogfood: reviewed while joined to the running dogfood server as `dev-1` on `sprint-3`.

## Verdict

**❌ BLOCKED (one major security bug)** — T1/T2/T3/T4/T5/T7/T8 verified; T6 has a
**per-agent-token impersonation hole** (issue #39) that violates the task's own
done-when ("an agent with only its own token cannot act as another agent").
PR #36 must not merge until #39 is fixed and re-verified.

---

## 1. Test results

| Suite | Tests | Passed | Failed | Notes |
|---|---|---|---|---|
| `server/test/lifecycle.test.ts` | 48 | 48 | 0 | incl. token mint/use/impersonation/revoke (3), boards dir |
| `server/test/dashboard.test.ts` | 5 | 5 | 0 | |
| `mcp/test/tools.test.js` | 8 | 8 | 0 | per-tool, in-process real server |
| `mcp/test/e2e.test.js` | 3 | 3 | 0 | JSON-RPC over stdio: initialize/list/call/error-path |
| `vscode-ext/test/board.test.js` | 5 | 5 | 0 | |
| `cli/test/cli.test.js` | 16 | 16 | 0 | incl. token E2E, archive E2E |
| **Total** | **86** | **86** | **0** | |

- `npm run build` (tsc, strict): clean.
- CI on sprint-3 head `5dbd4f9`: **3/3 jobs green** — `build-and-test`, `extension-ui` (T4 host-wiring), `docker`.
- **npm v12 (T8) re-verified independently:** clean `npx npm@12 ci` in a temp copy → better-sqlite3 native module loads → **86/86 tests pass** under npm v12 defaults.
- Extension host-wiring UI suite (T4): dev team's local run is corroborated by the on-disk VS Code download; CI `extension-ui` green. Not re-run locally (node_modules restore needed first; CI covers it).

## 2. Live verification (dogfood server on :8080 + fresh temp DBs)

- **MCP server (T1):** drove real JSON-RPC over stdio — `initialize` → `tools/list` (9 tools with schemas) → `whoami` → `list_boards` → `heartbeat` (roles via AB_ROLES). All correct.
- **Archive (T5):** `ab archive --board sprint-3 --git` → 4 threads as markdown, one commit per thread, closed-thread `(closed)` marker, **idempotent rerun (no new commits)**.
- **Boards dir (§5.8):** `GET /v1/boards` identity-less → sprint-3 with message count.
- **T6 matrix (before discovering #39):** token mint (admin-only, `abt_` + 24B hex, SHA-256 at rest); agent token + wrong `X-Agent-ID` → 401; agent token cannot mint → 401; heartbeat with mismatched agentId → 401; heartbeat with own agentId → 200; revoke → dead token → 401. **All correct — and then the `for`-param hole (#39).**
- **Sprint-1/2 regressions:** identity-less GETs, ttl:0, watermark crash safety, fan-out, deadlines — unchanged (suite).

## 3. Bugs filed

| Issue | Severity | Summary | Status |
|---|---|---|---|
| [#39](https://github.com/kennymudiaga/agent-board/issues/39) | **major** | **Per-agent token impersonation via `?for=` on pickup** — a token holder claims messages in ANY agent's name (claimAgent = victim), reads their mail, and can run their mail to dead. Reproduced live. Violates T6 done-when and spec §4 binding. | open — merge blocker |

## 4. What passed review (no issues found)

- MCP tool layer: errors-as-text (server survives bad calls), env-only config (never writes files), zod schemas; `read` correctly exposes watermark for resume.
- Token storage: SHA-256 at rest, plaintext once at mint, admin-only mint/revoke, `X-Agent-ID` + heartbeat-body binding checks.
- Release plumbing (T2): trusted-publishing workflow (`id-token: write`, `--provenance`, no token), ghcr `packages: write`, `docs/releasing.md` — sound; blocked only on account-owner setup (Producer action).
- `allowScripts` pinned entries (better-sqlite3@12.11.1, esbuild@0.28.2/0.21.5) — verified working under npm 12.
- `AB_ROLES` env plumbing, `ab whoami`, `--key` alias — correct.
- A2A spike writeup — findings-only, sensible recommendation (relay on server).

## 5. Claim vs. reality check

| Claim | Reality |
|---|---|
| "86/86 vitest green" | ✅ confirmed |
| "Build clean" | ✅ confirmed |
| "CI green ×3 (incl. extension-ui)" | ✅ confirmed |
| "npm v12 clean ci + tests" | ✅ independently re-verified |
| "MCP 9 tools over stdio" | ✅ live-verified |
| "Archive idempotent" | ✅ live-verified |
| "T6: agent cannot act as another agent" | ❌ **false as shipped** — `?for=` impersonation (#39) |
| "4/4 UI tests" | ⚠️ CI job green + local artifact present; not re-run locally this pass |

## 6. Blocker & recommendation

- **Blocker (#39):** in pickup mode, when a per-agent token is in use, reject `for` unless it equals the token's agent (401), or ignore it. One check in `app.ts`; add a regression test (mint token → `?for=other` → 401; `?for=self` → works; workspace token unchanged).
- **Non-blocking:** `read` tool doesn't persist the watermark (agent must pass `since`) — acceptable MCP design, document if desired; `send` with both `message` and `payload` silently prefers payload (CLI errors) — minor inconsistency.

## 7. Sign-off

- Automated tests: 86/86 pass; npm-12 install verified; CI 3/3.
- Manual playthrough: all sprint-3 features verified live except the T6 binding guarantee, which FAILS (#39).
- Blocker status: **BLOCKED on #39** (security).
- Sign-off: ❌ **BLOCKED** — core features pass; #39 must be fixed and re-verified before PR #36 merges.

## 8. Board dogfood notes

- Joined the running server as `dev-1` (workspace config), heartbeat busy, awaiting dispatches.
- Received Producer's broadcast (#5: release-path decision, PR #36 review request, two dogfood kinks pending). Acknowledged; replied with review status + blocker (#6).
- Identity note for the Producer: this QA session runs as `dev-1` (roles [dev]); `qa-1`'s online presence was a test artifact (token revoked). Dispatch to `agent:dev-1` or `role:dev`.
