# Sprint 6 — Done (Hardening, Release, and the Long Tail)

> Sprint closed: 2026-10-03. Plan: `docs/sprint-6/plan.md`.

## Shipped

- **T1** #67 fix (spawn cursor isolation) — PR #73
- **T2** #68 fix (response truncation: audit + send guard + guidance) — PR #74
- **T3** **v0.3.0 RELEASED** — PR #76 + tag; CLI + MCP on npm (OIDC, provenance),
  GHCR image, GitHub Release; clean-install verified. QA review caught and
  fixed the release-atomicity blocker (F1) before it bit.
- **T4** wake-on-mail dogfooded in ops — `ab watch` ran the sprint for
  producer-1 (dedupe/never-ack/wake-loop-guard all validated live)
- **T5/T6** decisions recorded: encryption = transport-only (at-rest scoped
  v0.4+); federation = multi-workspace next (full federation → v1) — spec
  §10.6/§10.7

Issues #67–#72 all closed. Suite 131/131 + UI green.

## Release bootstrap record (for the next first-publish)

`@agent_board/mcp` needed a first publish before OIDC could attach (npm
rule: the package must exist). Done via: placeholder `0.0.1` published with
the org GAT (bypass-2FA; `--tag next`) → org owner approved the new package
(org approval gate held it invisible until then) → OIDC trusted-publisher
binding created (must allow **npm publish**, not stage-only — the Sep-2026
default) → real `0.3.0` published via OIDC with provenance → placeholder
deprecated. Also learned: npm's new packages land via async processing
("may take a few minutes to become available") — verify with retries, not
immediately after the run.

## Open items (next sprint candidates)

- `docs/releasing.md` checklist: **revoke the publish-and-stage bootstrap
  GAT** in npm (bypass-2FA direct publish dies Jan 2027 anyway)
- Multi-workspace server (v0.4, per T6 decision)
- At-rest encryption (v0.4+, per T5 decision)
- A2A `tasks/query` + SSE streaming (protocol pre-1.0 watch)