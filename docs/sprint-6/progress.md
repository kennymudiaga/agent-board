# Sprint 6 — Progress (Hardening, Release, and the Long Tail)

> Updated: 2026-10-03. Plan: `docs/sprint-6/plan.md`.

## Status — ALL TASKS DONE, v0.3.0 SHIPPED

| Task | State | Evidence |
|---|---|---|
| T1 — #67 spawn cursor isolation | **MERGED** | PR #73 (`082b3bf`); env-identity sessions never inherit file cursors; regression test; #67 closed |
| T2 — #68 response truncation | **MERGED** | PR #74 (`e52622f`); audit: pipeline never truncates (display previews only); loud 4096-char send guard + "reply IN FULL" guidance; >300-char hermetic test; #68 closed |
| T3 — release v0.3.0 | **SHIPPED** | PR #76 (`ae14025`) + tag `v0.3.0` (release run 37127949647 all-green); QA review caught F1 (release jobs lacked `needs: npm-publish`) + F2 (mojibake) — fixed before merge |
| T4 — dogfood wake-on-mail | **DONE** | `ab watch` ran the whole sprint for producer-1 (see findings below); #70 closed |
| T5 — encryption decision | **DONE** | PR #75 — transport-only for v0.x, at-rest scoped v0.4+; spec §10.6; #71 closed |
| T6 — federation decision | **DONE** | PR #75 — multi-workspace server next (small-medium), full federation deferred to v1; spec §10.7; #72 closed |

## Release v0.3.0 — verification record

- `@agent_board/cli@0.3.0` live (bin `ab` ✓, provenance ✓, transparency log signed)
- `@agent_board/mcp@0.3.0` live (bin `agentboard-mcp` ✓ — npm normalized the `./bin/server.js` path; provenance ✓)
- GHCR `v0.3.0` + `latest` ✓ · GitHub Release ✓ (generated notes)
- Clean install verified (temp prefix): `ab --version` → `ab 0.3.0`; mcp shim + stdio server boot OK
- First-publish bootstrap: `@agent_board/mcp@0.0.1` placeholder (GAT, bypass-2FA) → approved → OIDC binding → deprecated after 0.3.0 (tag `next`)
- OIDC worked end-to-end for BOTH packages (no tokens in CI)

## T4 dogfood findings (ab watch, sprint-6 ops)

- Fired exactly once per response message id (#69/#72/#73/#75) — dedupe ✓
- Never claimed/acked anything — all 4 responses were claimed by the interactive producer read; watcher stayed read-only ✓
- Wake-loop guard: producer's own kickoff broadcast never fired ✓
- Stayed alive for the whole sprint on SSE push; zero polling ✓
- Follow-up: none — T1's cursor fix also verified in practice (spawned QA workers claimed their mail this sprint)