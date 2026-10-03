# Sprint 7 — Agent Ergonomics

> Goal: make agents **easy to equip** (one command installs the skill/agent
> files anywhere) and **safe to run concurrently** (worktrees for writers),
> then take the multi-workspace design seriously and ship v0.3.1.

## Pre-sprint context

- v0.3.0 live (cli + mcp on npm via OIDC, GHCR, Release).
- Sprint 6 dogfood found the shared-checkout class of problems (#58 config
  clobber, #67 cursor inheritance) — both fixed, but the *structural* fix
  (one writer per checkout) is this sprint's T2.
- The skill/agent definitions exist only inside this repo — T1 bundles them
  into the CLI so any workspace/machine can bootstrap.
- Sprint-6 T6 decision: multi-workspace server is the next structural step
  (design + spike here; implementation next).

## Scope

**In:**
- T1: `ab setup` — bundle + install agent/skill templates (#77, HIGH)
- T2: `ab spawn --worktree` + one-writer-per-checkout policy (#78, HIGH)
- T3: multi-workspace server design + spike (#79, MEDIUM — design-first)
- T4: release v0.3.1 (#80, MEDIUM — after T1/T2)

**Out:** multi-workspace implementation (next sprint, per T3 plan), at-rest
encryption (v0.4+), A2A `tasks/query`/SSE, full federation (v1).

## Tasks

### T1 — `ab setup` (#77) — HIGH

Single source of truth in `cli/templates/`; one command installs the
skill/agent files:
- `ab setup --global [--host opencode|claude|vscode|all]` — user-level
  install once per machine (verify exact host paths against current docs).
- `ab setup` (workspace) — writes `.opencode/`, `.claude/`,
  `.github/prompts/`, AGENTS.md snippet.
- `--check` (drift vs templates, exit 1 — CI gate), `--force`, `--dry-run`;
  idempotent; prints what it wrote + next steps.
- This repo's committed copies become generated; CI runs `ab setup --check`.
- New-machine quickstart documented.

**Done when:** fresh workspace/machine gets working files via `ab setup`;
`--check` catches drift; CI green; quickstart in docs.

### T2 — `ab spawn --worktree` + policy (#78) — HIGH

- `docs/conventions.md`: **one writer per checkout** — main checkout belongs
  to the human; writers get their own worktree when another writer may be
  active; read-only/coordination needs none.
- `ab spawn --worktree`: fresh branch + temp worktree + install, `--dir`
  pointed there; default ON for dev/qa, `--no-worktree` opt-out; prints the
  worktree path; cleanup/prune guidance.
- QA docs: prefer `git worktree` over full scratch clones.
- Tests: command construction/path/branch naming (hermetic) + one live run.

**Done when:** spawned dev/qa workers default to their own worktree, main
checkout untouched; policy documented; tests green.

### T3 — multi-workspace design + spike (#79) — MEDIUM

Design doc (`docs/multi-workspace.md`) + spec §9/§10 notes: workspace
representation, token→workspace binding, API scoping, store migration
(`workspace_id` vs separate DBs), default-workspace back-compat. Spike the
auth middleware + store scoping shape; measure migration impact. Output:
design + findings + implementation issues for the next sprint. No production
behavior change unless trivially safe.

**Done when:** design reviewed, spike findings recorded, implementation
issues filed.

### T4 — release v0.3.1 (#80) — MEDIUM

After T1/T2: version bumps, `ab setup --check` in CI, tag → OIDC publish
(cli + mcp) → GHCR → Release notes (`ab setup`, worktree spawning).
Clean-machine verify (`ab --version`, `ab setup --dry-run`).

**Done when:** v0.3.1 live + verified.

## Acceptance

1. On a machine with only the CLI: `ab setup --global` equips opencode +
   Claude (+ VS Code where applicable) with the board skill/agents.
2. Two spawned workers run concurrently without touching each other or the
   main checkout (worktrees by default).
3. `docs/multi-workspace.md` exists with a reviewed design + filed issues.
4. `npm i -g @agent_board/cli@0.3.1 && ab setup --check` clean.

## Definition of Done

T1–T2 merged with CI; T3 design + issues; T4 released and verified;
`docs/conventions.md` worktree policy; progress/done docs; `PROJECT_BRIEF.md`
§7/§8 updated; issues #77–#80 closed.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 7. Goal: **equip agents anywhere,
> run them safely side by side**. Read `PROJECT_BRIEF.md`,
> `docs/sprint-7/plan.md`, issues #77–#80 first. Work in order T1 → T4.
> T1 (`ab setup`) is the headline: single source of truth in `cli/templates/`,
> `--check` drift gate wired into CI. T2 (`ab spawn --worktree`) is the
> structural fix for the shared-checkout bug class — policy first in
> conventions, then the spawn flag (default on for dev/qa). T3 is
> design + spike only; file the implementation issues. T4 is the release.
> Use a git worktree per writer (eat the dogfood). Each task: branch off
> `main`, PR with passing CI, reference its issue. Report through the board
> (`sprint-7`) and `docs/sprint-7/progress.md`.