# Sprint 7 — Progress (Agent Ergonomics)

> Updated: 2026-10-03. Plan: `docs/sprint-7/plan.md`.

## Status — ALL TASKS SHIPPED, v0.3.1 LIVE

| Task | State | Evidence |
|---|---|---|
| T1 — `ab setup` (#77) | **MERGED** | PR #81 (`7fd53c3`); `cli/templates/` single source (shared SKILL.md — dual-copy drift class closed); workspace + `--global` install (verified host paths), `--check`/`--force`/`--dry-run`/`--host`; CI runs `ab setup --check`; 138/138; #77 closed |
| T2 — `ab spawn --worktree` (#78) | **MERGED** | PR #82 (`a22a048`); policy in `docs/conventions.md` §10 (one writer per checkout); default ON for dev/qa (fresh `spawn/<agentId>` branch + temp worktree + npm ci), `--no-worktree` opt-out; 140/140 incl. live worktree run; #78 closed |
| T3 — multi-workspace design + spike (#79) | **MERGED** | PR #88 (`53756dd`); `docs/multi-workspace.md` + spec §1/§10.6; spike on a copy of the live DB (73 msgs): migration 3.9 ms / 0.0% growth, hot pickup +0.6 µs, middleware ~15 additive lines; implementation issues #83–#87 filed; #79 closed |
| T4 — release v0.3.1 (#80) | **SHIPPED** | PR #89 (`0b4f5d8`) + tag `v0.3.1`; release run all-green (needs: chain held); cli + mcp `0.3.1` live with provenance; GHCR `v0.3.1`+`latest`; Release notes live; #80 closed |

## Verification record

- Producer side: `npm i -g @agent_board/cli@0.3.1` (temp prefix) → `ab 0.3.1`;
  `ab setup --dry-run` in-repo → **11 unchanged** (drift gate green against the
  published package); `opencode agent list` discovers `board-producer` +
  `board-worker` from the new plural layout.
- Dev side: npx version check, npm provenance (sigstore attestation), GHCR
  pull (digest `sha256:45a06e45…`), Release live.

## Dogfood findings

- **dev-3 dogfooded its own T2**: T1/T2/T3 work happened in a worktree
  (`ab-wt-s7`), and the one-writer policy held — no shared-checkout
  collisions this sprint.
- **Long turns lapse presence/claims**: multi-minute implementation turns
  stop heartbeating and let request leases expire (they returned to
  `pending`; the work was unaffected). Candidate follow-up: longer default
  leases for claimed work, or heartbeat-on-tool-use for worker sessions.
- `ab setup --global` host paths verified against current docs (opencode
  `~/.config/opencode/{agents,commands,skills}`, Claude `~/.claude/{commands,skills}`;
  VS Code workspace-only for now).

## Mid-sprint (merged on main)

- Role substance restored into `board-worker`/`board-producer` + SKILL.md §10
  (`a22acf2`, `d2d4236`) — dev/qa/explore definitions, file ownership,
  risk-based review, evidence rules.