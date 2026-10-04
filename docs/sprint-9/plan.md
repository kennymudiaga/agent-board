# Sprint 9 — Wake, Watch & Worker Ergonomics

> Goal: make wake-on-mail **actually usable** (lazy binding, no relaunch),
> make spawned workers **observable and attachable** (visible sessions, logs),
> fix the release-CI race, and stop the long-turn presence/lease churn this
> sprint's dogfood exposed.

## Pre-sprint context

- v0.4.0 live (multi-workspace server). Sprint 8 dogfood findings:
  - The `agentboard-wake` plugin binds once at load (env else `.agentboard.json`,
    no global fallback) — virgin repos need setup + relaunch (**#101**).
  - Spawned workers died repeatedly; fixed the EPIPE root cause in T5, but
    sessions are still headless/unobservable and a `--log` tee is missing
    (**#93** remainder). Visible/UI sessions remain the open idea from #93.
  - Release tag CI raced the Release workflow's GHCR push (**#100**).
  - Long worker turns lapse presence + request leases (**#102**).
- Board `sprint-9` created; `producer-1` joined.

## Scope

**In:**
- T1: wake plugin lazy binding + global-config fallback (#101, HIGH)
- T2: spawn observability remainder (#93: `--visible`/attachable sessions, `--log` tee, hermetic spawn-opts test; HIGH)
- T3: ci.yml tag docker-push race (#100, LOW)
- T4: long-turn presence/lease ergonomics (#102, MEDIUM — design + decision + implementation subset)
- T5: release v0.4.1 (after T1–T4 + QA)

**Out:** at-rest encryption (v0.4+, sprint 10 candidate), A2A `tasks/query`+SSE (sprint 10 candidate), federation (v1), GAT revocation hygiene (human ops, any time).

## Tasks

### T1 — wake lazy binding + global fallback (#101) — HIGH

Design is filed in #101: (A) lazy re-resolve loop in `agentboard-wake.js` (timer ~5s or `fs.watch` on `.agentboard.json`; start watcher when config appears; restart-guard on change; also handles mid-session board switches), (B) `resolveConfig` mirrors `cli/src/config.js` (env → workspace file → global config), (C) optional `/ab wake` command hook. Includes the producer-wake live verification (fresh-clone flow).

**Done when:** a virgin repo on a configured machine (or after an in-session `/ab join`) gets wake without relaunching opencode; mid-session config changes re-bind; hermetic `wake-core.test.js` coverage + live verification green.

### T2 — spawn observability (#93 remainder) — HIGH

- `ab spawn --visible` (or tier): launch the worker's `opencode run` in a visible terminal window (Windows Terminal/`cmd start`) or attachable via `opencode serve`/`attach` — a human can watch, intervene, see crashes.
- `ab spawn --log <file>`: tee the worker's output to a log (restores observability lost to `stdio:'ignore'`).
- Hermetic test pinning `spawnWorker` detached/stdio opts (qa-7 non-blocking finding).

**Done when:** a spawned worker is observable/attachable (or logs captured), spawn opts pinned by a hermetic test, docs updated (#93 closed).

### T3 — ci.yml tag race (#100) — LOW

The `ci.yml` docker job skips pushing GHCR on tags (Release workflow owns publishing): `if: startsWith(github.ref, 'refs/tags/') == false` on the push step. Tag runs show all green.

**Done when:** a tag push shows green (or skipped) docker; GHCR pushed exactly once per release.

### T4 — long-turn presence/lease ergonomics (#102) — MEDIUM

Design + decision in #102, then implement the chosen subset: (1) heartbeat-on-tool-use / periodic `ack --status claimed` for the board-worker persona; (2) longer claim leases for long work; (3) `sleeping` presence value with `wake:*` caps; (4) watch-heartbeats-for-agent — pick per #102 discussion. Record the decision in spec §5.1/§6 + conventions.

**Done when:** long worker turns keep presence + lease alive (or lapse-with-redelivery is the documented contract), producers see truthful status, decision recorded.

### T5 — release v0.4.1 (#new) — MEDIUM (after T1–T4 + QA)

Version bumps, spec header, regenerated agent files, tag → OIDC publish (cli + mcp, provenance) → GHCR → Release notes (wake lazy binding, spawn observability). Clean-machine verify. Human approval before publish.

**Done when:** v0.4.1 live + verified.

## Acceptance

1. Fresh-clone/no-config flow gets wake without relaunch (T1 live test).
2. A spawned worker can be watched/attached or logged (T2); spawn opts pinned.
3. Tag pushes are green (T3).
4. Long turns keep presence/lease (or documented contract) + `sleeping` where chosen (T4).
5. v0.4.1 released with provenance + verified (T5).

## Definition of Done

T1–T4 merged with CI + QA sign-off; T5 released + verified; progress/done docs; `PROJECT_BRIEF.md` §7/§8 updated; #93, #100, #101, #102 closed; worktrees cleaned.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 9. Goal: **wake that works without
> ceremony, workers you can watch, releases that stay green, presence that
> stays truthful**. Read `PROJECT_BRIEF.md`, `docs/sprint-9/plan.md`, issues
> #93, #100, #101, #102 first. Work in order T1 → T2 → T3 → T4. T1 (#101) is
> the headline: the design is already filed — implement lazy binding +
> global-config fallback and prove the fresh-clone flow live. T2 (#93) is the
> observability remainder (visible/attachable sessions, `--log` tee, hermetic
> spawn-opts test). T3 (#100) is a one-liner in ci.yml. T4 (#102) is
> design-first: pick the subset per the issue, record the decision in the
> spec. Work in YOUR worktree (`spawn/<agentId>`), never the main checkout.
> Each task: branch off `main`, PR with passing CI, reference its issue.
> Report through the board (`sprint-9`) and `docs/sprint-9/progress.md`.