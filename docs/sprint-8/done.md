# Sprint 8 — Done (Multi-Workspace Server)

> Sprint closed: 2026-10-04. Plan: `docs/sprint-8/plan.md`.

## Shipped — v0.4.0 LIVE

- **T1 W1 workspaces table + bootstrap + token hashing** (#83, PR #91) — `workspaces(id, name, token_hash, created_at)`; SHA-256-hashed workspace tokens; idempotent `AB_WORKSPACE`/`AB_TOKEN` startup bootstrap; **QA PASS** (qa-3). 147/147.
- **T2 W2 middleware resolution + admin endpoints** (#84, PR #94) — every bearer resolves via SHA-256 (`workspaceForToken` / `tokenAgent`); `c.set('workspaceId')`; `POST/DELETE /v1/workspaces` (mint `abw_` once, hashed at rest, 409/422/404); SSE hash lookup; **QA PASS** (qa-4). 156/156.
- **T3 W3 store scoping + migration + indexes** (#85, PR #95) — `workspace_id` columns + composite PKs (fresh DBs) / additive migration (existing DBs, rows → `default`); 49 store sites `workspaceId`-first; ws-scoped indexes incl. idempotency; **QA PASS** (qa-5) with 2 T4-bound findings. 161/161 after rebase onto T2.
- **T4 W4 API/SSE/A2A scoping + isolation tests** (#86, PR #96 — **security gate**) — per-request `c.get('workspaceId')`; `workspaceForAgent` real; SSE/A2A workspace-scoped; legacy hardening (idempotency index drop; composite-PK rebuild, transactional+rollback); isolation suite 6/6 + 11 QA probes; **QA PASS** (qa-6). 170/170.
- **T5 W5 CLI `--workspace` + advertisement + docs** (#87, PR #98) — `--workspace`/`AB_WORKSPACE`/config field sent only when set (`x-workspace-id`); `/healthz` `multiWorkspace: true`; deployment guide `docs/multi-workspace.md` §8; plus #93 items a/b/c (`AB_BOARD` in spawn env, **spawnWorker detached+stdio-ignore (EPIPE fix)**, `AB_BOARDS` override); **QA PASS** (qa-7; docs-only rotation-caveat finding fixed on main `255d20d`). 176/176.
- **T6 release v0.4.0** (#90, PR #99 + tag `v0.4.0` → `b8587ea`) — cli + mcp `0.4.0` on npm with SLSA provenance, GHCR `v0.4.0`+`latest`, GitHub Release; clean-machine + producer-side verification. **Human-approved publish.**

Issues #83–#87 + #90 closed (all QA-signed). Suite **176/176** + CI 3/3. Follow-ups: #93 (spawn observability remainder), #100 (ci.yml tag docker-push race).

## Dogfood record

- **Spawned workers died repeatedly mid-turn** (dev-4 ×2, dev-5, qa-4, qa-7) — root-caused the on-arrival deaths to a **win32 spawn EPIPE hazard** (`spawnWorker` `stdio:'inherit'`; a clean `ab spawn` exit closed the parent's pipes and killed the worker) — **fixed in T5** (#93b: detached + `stdio:'ignore'`). Work survived every death (commits on branches; resumed sessions verified byte-identical).
- **Workers kept hitting the external-directory wall** (probes outside their worktree → auto-reject → session death). Resume briefs now carry the constraint explicitly.
- **Producer wake gap**: `ab watch` notify+popup wakes the human, not the producer session (plugin needs board env at session start — documented on #93).
- Env-identity heartbeats inherited the file's boards list (clobbered membership) — **fixed in T5** (#93c `AB_BOARDS`).
- Release dogfood: tag CI's docker job raced the Release workflow's GHCR push (benign; #100).
- Pre-existing archive CLI test flake (~5s timeout) confirmed as near-threshold, unrelated (non-blocking).

## Next (sprint 9 candidates)

- Long-turn presence/lease ergonomics (heartbeat on tool use? longer leases?)
- At-rest encryption (v0.4+, per sprint-6 decision)
- A2A `tasks/query` + SSE streaming
- #93 remainder: visible/UI sessions for spawned workers (`ab spawn --visible`/attach), spawn `--log` tee, hermetic spawn-opts test, producer-wake plugin verification
- #100: ci.yml tag docker-push race
- Hygiene: revoke the bootstrap GAT in npm (human)