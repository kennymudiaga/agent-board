# Sprint 9 — Done (Wake, Watch & Worker Ergonomics)

> Sprint closed: 2026-10-04. Plan: `docs/sprint-9/plan.md`.

## Shipped — v0.4.1 LIVE

- **T1 wake lazy binding + global-config fallback** (#101, PR #103) — `resolveConfig` mirrors the CLI (env → workspace file → **global config**); `LazyResolver` re-resolves every `AB_WAKE_RESOLVE_MS` (default 5s) with a restart-guard; plugin is a thin wrapper; **live fresh-clone verification: `ab init`+join in another terminal → watcher bound ~1s → wake prompt injected, no relaunch**; **QA PASS** (qa-8). 186/186.
- **T2 spawn observability** (#93, PR #104) — `ab spawn --visible` (win32 new console that stays open; posix inherit foreground) + `--log <file>` tee (both platforms, incl. the win32 shim shell-redirect path) + win32 quoting hardening + **hermetic test pinning spawnWorker detached/stdio** (qa-7 finding); docs updated; **QA PASS** (qa-8, incl. live win32 shim smoke). 190/190.
- **T3 ci.yml tag docker-push race** (#100, PR #105) — GHCR login/push gated to `refs/heads/` (build/drift-check stays unconditional); `release.yml` confirmed as the sole tag publisher; **QA Ready** (qa-8). Tag runs now green — proven at the v0.4.1 release.
- **T4 presence/lease ergonomics** (#102, PR #106) — decision: **worker discipline adopted** (heartbeat `--interval 60` + renew claim before the 5-min lapse; persona/SKILL/AGENTS/conventions), **lease kept at 300s** (`ack claimed` renews without incrementing attempts — pinned by a hermetic test; verified in code: `attempts++` only on claim), sleeping presence deferred (wake:* caps cover it), watch-heartbeats rejected (presence must not lie); contract recorded spec §6.1/§7 + conventions §3; **no server behavior change**; **QA PASS** (qa-8). 191/191.
- **T5 release v0.4.1** (#107, PR #108 + tag `v0.4.1` → `cfc91c98`) — cli + mcp `0.4.1` on npm with SLSA provenance, GHCR `v0.4.1`+`latest`, GitHub Release; **tag CI green** (the #100 fix held); clean-machine + producer-side verification. **Human-approved publish.**

Issues #93, #100, #101, #102 + #107 closed (all QA-signed). Suite **191/191** + CI 3/3.

## Dogfood record

- **The recurring external-directory wall**: three spawned workers died writing scratch to `%TEMP%` (outside their worktree → auto-reject). Work survived every time (PRs were up); resume/verify flow handled the rest. Launcher-level workaround applied for future spawns: point `TEMP`/`TMP` inside the worktree.
- **dev-4's own long turns lapsed claims** (attempts→2/3) before the T4 guidance existed — the exact gap T4 closed (guidance, not server behavior).
- **Wake now works without ceremony**: fresh clone → `ab init`+join mid-session → bound in ~1s (live-proven, T1). Spawned workers carry `AB_BOARD` (from sprint 8 T5), so even they are wake-bindable.
- **Release CI stayed green on the tag run** — the #100 fix validated in production.
- Non-blocking follow-ups recorded: `AB_WAKE_RESOLVE_MS` NaN coercion; `--log` missing parent dir → raw ENOENT.

## Next (sprint 10 candidates)

- At-rest encryption (v0.4+, per sprint-6 decision)
- A2A `tasks/query` + SSE streaming
- `sleeping` presence value (deferred in #102; needs protocol change)
- The two non-blocking follow-ups above (small CLI/plugin hardening)
- Federation (v1)
- Hygiene: revoke the bootstrap GAT in npm (human)