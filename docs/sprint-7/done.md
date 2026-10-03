# Sprint 7 — Done (Agent Ergonomics)

> Sprint closed: 2026-10-03. Plan: `docs/sprint-7/plan.md`.

## Shipped

- **T1 `ab setup`** (#77, PR #81) — agent/skill templates bundled in the CLI
  (`cli/templates/`, single source of truth incl. the shared SKILL.md);
  `ab setup` workspace/`--global` install, `--check` drift gate wired into CI,
  `--force`/`--dry-run`/`--host`; new-machine quickstart documented.
- **T2 `ab spawn --worktree` + one-writer-per-checkout** (#78, PR #82) —
  policy in `docs/conventions.md` §10; spawn defaults dev/qa to a fresh-branch
  worktree + install; QA prefers worktrees over scratch clones.
- **T3 multi-workspace design + spike** (#79, PR #88) — `docs/multi-workspace.md`
  + spec §1/§10.6; spike on a live-DB copy measured a 3.9 ms / 0.0% migration
  and a ~15-line additive middleware; implementation split into **#83–#87**
  (W1 workspaces table → W5 CLI `--workspace`).
- **T4 release v0.3.1** (#80, PR #89 + tag) — cli + mcp `0.3.1` on npm with
  OIDC provenance, GHCR `v0.3.1`+`latest`, GitHub Release; verified from both
  sides.

Issues #77–#80 closed; #83–#87 open for the next sprint. Suite 140/140 + CI
(including the new `ab setup --check` gate).

## Dogfood record

dev-3 used a worktree for its own T1–T3 work before the tooling existed — the
policy is now automatic. Long implementation turns lapse heartbeats/leases
(harmless here; flagged as a follow-up).

## Next (sprint 8 candidates)

- Multi-workspace implementation: #83 (workspaces table) → #87 (CLI flag)
- Long-turn presence/lease ergonomics (heartbeat on tool use? longer leases?)
- At-rest encryption (v0.4+, per sprint-6 decision)
- A2A `tasks/query` + SSE streaming
- Hygiene: revoke the bootstrap GAT in npm (human)