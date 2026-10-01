# Sprint 4 — The A2A Front Door (chunk 1)

> Goal: make AgentBoard reachable from the **synchronous A2A ecosystem** (the
> spike said "we remain the async layer under A2A"), finish the bootstrap
> experience (`ab init --global`), and restore suite health (#46). Chunk 1 =
> the headline feature + tooling; chunk 2 (later) = token rotation/expiry,
> broadcast read-state, dashboard delivery detail, federation/encryption.

## Pre-sprint context (already on `main`)

- `ab agents` directory command (#43, PR #45-adjacent work) — landed
- `ab spawn` tiered transient worker spawning (#42 part 2, PR #45) — landed
- Producer two-phase kickstart + `/ab` bootstrap command — landed
- vscode-ext missing-CLI warning → `@agent_board/cli` (#40/#44) — landed
- v0.2.1 published (npm `@agent_board/cli`, GHCR, GitHub Release); OIDC active

## Scope

**In (chunk 1):**
- T1: Fix #46 — MCP test "list_agents and list_boards are read-only" fails on
  clean main (suite health, HIGH, do first)
- T2: `ab init --global` — machine-wide config, env > local > global (#41, MEDIUM)
- T3: A2A relay on the reference server (spike → task, HIGH — the headline)
- T4: OpenDevin polish (MEDIUM — verify quickstart against the current release)

**Out (chunk 2 / later):** token rotation & expiry, broadcast read-state,
dashboard delivery detail, federation, encryption.

## Tasks

### T1 — Fix #46: MCP read-only test fails on clean main — HIGH

The full workspace suite is 91/92: `mcp/test/tools.test.js`
("list_agents and list_boards are read-only") fails on a clean tree. Root
cause not yet investigated — may be a stale assertion, env-dependence, or a
server behavior change since the test was written.

- Investigate root cause; fix the implementation or correct the assertion to
  match spec'd behavior (§4/§5.2/§5.8: read-only GETs are identity-less
  observability — never claim, never long-poll).
- Spec note from QA (sprint 3, non-blocking): spec §5.4 still describes `for=`
  as free-form — amend to bound-identity wording while in here if touching spec.

**Done when:** the test passes on a clean `main` and the suite is 92/92; PR
references #46.

### T2 — `ab init --global` (#41) — MEDIUM

Machine-wide config so any repo on the machine can join boards without
re-entering credentials, and `/ab` bootstrap works with zero human credential
entry.

- `ab init --global --server <url> --token <t> --agent-id <id> --roles <r>`
  writes the per-OS config dir (`%APPDATA%\agentboard\config.json` on Windows
  or `os.homedir()/.config/...` — dev team's call, keep Node conventions).
- `loadConfig` resolution: **env vars > `.agentboard.json` in cwd > global**.
  Local `ab init` overrides global; env overrides both.
- Token rules from #25/#26 apply to the global file too: never written from
  env, never erased, file never inside a repo.
- `ab whoami` reports the identity source (`env` | `local` | `global`).
- Help text: `ab init --global` + `ab --help` env/global note.

**Done when:** fresh clone on a machine with global config → `ab whoami`
resolves from global; local `ab init` overrides; `/ab join sprint-8 as dev`
works without the human pasting credentials.

### T3 — A2A relay on the reference server (spike → task) — HIGH

Per `docs/a2a-spike.md` recommendation — scoped to:

1. `/.well-known/agent.json` + `/a2a/:agentId` on the reference server
   (JSON-RPC 2.0; `tasks/send` + `tasks/get` + `tasks/cancel` first).
2. Thread→task mapping: `request`/`question` only; `response` = result;
   `failed`/`dead`/`expired` = failed with the ack error; broadcast has no
   single task — not mappable (documented).
3. Agent-token auth (§5.9) for the relay — the relay impersonates the agent
   with its own token; no admin escalation.
4. Demo: an A2A client (e.g. the Python A2A SDK) sends a task; a board worker
   answers via `ab`; the client polls to `completed`.

Defer `tasks/query`, SSE streaming, registry integration (protocol still
pre-1.0). Server tests + a demo script; `docs/a2a.md` (or extend the spike
doc) records the mapping + demo steps.

**Done when:** a task sent by an A2A client lands as a board request, a board
agent answers it with `ab`, and the client sees `completed` — live demo +
tests green; QA signs off.

### T4 — OpenDevin polish — MEDIUM

`docs/opendevin/quickstart.md` exists from sprint 3; verify it against the
published v0.2.1 (`npm i -g @agent_board/cli`, MCP mount) and fix any drift
(CLI flags, board names, MCP tool names).

**Done when:** a human can join an OpenDevin agent to a board following the
doc against the released version.

## Acceptance: The A2A Demo

1. One server, board `sprint-8`.
2. A2A client (Python SDK) discovers the board agent card and `tasks/send`s a
   review request.
3. The request appears on the board as a `request` to `role:qa`; a QA session
   picks it up via `ab`, answers, acks.
4. The A2A client polls `tasks/get` → `completed` with the response payload.
5. No human paste between steps 2–4. `ab init --global` used by the worker
   machine (no local config needed for join).

## Definition of Done (chunk 1)

T1–T2 merged with passing CI (92/92); T3 merged with QA sign-off
(`docs/qa/sprint-4-signoff.md`) and the demo executed; T4 merged; progress in
`docs/sprint-4/progress.md`; `PROJECT_BRIEF.md` §7/§8 updated; #46 and #41
closed.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 4 chunk 1. Goal: **open the A2A
> front door**. Read `PROJECT_BRIEF.md`, `docs/sprint-4/plan.md`,
> `docs/a2a-spike.md` first — they are the client story this chunk serves.
> Work in order T1 → T4. T1 (#46) is suite health — do it first, small PR.
> T2 (#41) is self-contained CLI work. T3 (A2A relay) is the headline — follow
> the spike's scoping exactly, defer query/streaming/registry. Each task:
> branch off `main`, PR with passing CI, reference its issue number. Report
> through the board (sprint-4) and to `docs/sprint-4/progress.md`.