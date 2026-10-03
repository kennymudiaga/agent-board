# Sprint 6 — Hardening, Release, and the Long Tail

> Goal: close the two dogfood bugs from sprint 5, **ship v0.3.0** (A2A relay +
> wake-on-mail + token expiry are a release), dogfood the wake stack in our
> own ops, and take the two long-deferred decisions (encryption, federation).

## Pre-sprint context

- Sprint 5 shipped wake-on-mail end-to-end (all 7 tasks, QA-signed; suite 124/124).
- Dogfood follow-ups filed: **#67** (spawn children inherit file cursors —
  env-identity workers can miss mail) and **#68** (spawned workers' response
  payloads truncate ~280 chars).
- Last release: v0.2.1 (sprint 3). OIDC trusted publishing active.
- `ab watch` (#51) + opencode plugin (#52) exist but haven't been used in
  our own ops yet.

## Scope

**In:**
- T1: Fix #67 — spawn children get fresh cursor state (HIGH — delivery-affecting)
- T2: Fix #68 — spawned-worker response truncation (MEDIUM)
- T3: Release v0.3.0 (#69, HIGH)
- T4: Dogfood wake-on-mail in sprint ops (#70, MEDIUM)
- T5: Encryption decision + spike (#71, MEDIUM — decision first)
- T6: Federation decision (#72, LOW — decision + deferral)

**Out (explicitly cut):** encryption/federation implementation (pending T5/T6
decisions), A2A `tasks/query` + SSE streaming + registry, interactive Copilot
Chat wake (track upstream), priority preemption.

## Tasks

### T1 — #67: spawn children cursor isolation — HIGH

`ab spawn` children run with `--dir <spawner-cwd>` and inherit the workspace
`.agentboard.json` cursors; an env-identity worker reads with the dev
session's `since` and can skip pending mail (diagnosed by QA `qa-7b0046`).

- Options: (a) env-identity `loadConfig` ignores file cursors; (b) spawn
  children get fresh cursor state (first read `--since 0`); (c) children run
  in a scratch dir. Pick the cleanest (recommend (a)+(b) combined — env
  identity should never inherit dev cursor state; #58 fixed the same class
  for config writes).
- Regression test: a spawned worker claims a request the file-identity
  session has already read past.

**Done when:** the sprint-5 repro passes (spawned worker claims mail beyond
the dev cursor); tests green; #67 closed.

### T2 — #68: response truncation — MEDIUM

Spawned workers' `response` payloads truncate at ~250–280 chars (observed in
two sign-offs). Find where (send pipeline? worker output pipe? summarization)
and fix, or document + mitigate (worker guidance to split/summarize; a send
size guard that errors loudly instead of silently cutting).

**Done when:** a >300-char response from a spawned worker arrives intact
(hermetic test if possible); #68 closed.

### T3 — Release v0.3.0 (#69) — HIGH

v0.3.0 = A2A relay, wake-on-mail (`ab watch`, opencode plugin, vscode
watcher), token expiry/rotation (`401 token_expired`), broadcast `reads`
aggregate, `ab agents`/`spawn`/`init --global`, config-clobber + parseArgs
fixes. Per `docs/releasing.md` (OIDC — no npm tokens):

- Version bumps; spec header v0.3.0 + "Last updated".
- Release workflow: test → publish `@agent_board/cli@0.3.0` → ghcr
  `:v0.3.0` + `:latest` → GitHub Release with notes.
- Clean-machine verify (`npm i -g @agent_board/cli && ab --version`;
  `docker pull ...:v0.3.0`).
- Decide the `@agent_board/mcp` packaging question (publish vs documented
  repo-clone) and act.

**Done when:** v0.3.0 live (npm + GHCR + Release), verified, path documented.

### T4 — Dogfood wake-on-mail in ops (#70) — MEDIUM

Producer runs `ab watch --board sprint-6 --for producer-1 --notify` (or
`--exec`) for at least one dispatch→response cycle with no polling session;
validate wake-loop guard/dedupe/never-ack in live ops; validate the T1/T2
fixes in real use. Findings → `docs/sprint-6/progress.md`.

**Done when:** one full dispatch→wake→response cycle ran without a polling
producer session; findings recorded.

### T5 — Encryption decision (#71) — MEDIUM

Evaluate at-rest (SQLCipher/field-level AES, `AB_ENCRYPTION_KEY`) vs
transport-only (document current stance) vs E2E (breaks server features).
Record the decision + effort notes in the plan/spec §9/§10. No production
code unless decided.

**Done when:** decision recorded with rationale; spec updated.

### T6 — Federation decision (#72) — LOW

Evaluate multi-workspace server (auth model already designed to extend) vs
full federation (defer to v1) vs status quo + deployment docs. Record the
decision + effort estimate in the plan/spec §9/§10.

**Done when:** decision recorded; spec notes updated.

## Acceptance: The Release + The Wake

1. `npm i -g @agent_board/cli@0.3.0` on a clean machine → `ab --version`
   prints 0.3.0; `docker pull ghcr.io/kennymudiaga/agent-board:v0.3.0`.
2. A dispatch→response cycle on `sprint-6` where the producer was woken by
   `ab watch` (no polling session) — dogfood of T1/T2/T4.
3. Both #67 and #68 closed with tests.

## Definition of Done (sprint)

T1–T3 merged with passing CI (release verified live); T4 executed with
findings recorded; T5/T6 decisions recorded in the spec; issues #67–#72
closed; progress/done docs; `PROJECT_BRIEF.md` §7/§8 updated.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 6. Goal: **harden, release, and
> decide the long tail**. Read `PROJECT_BRIEF.md`, `docs/sprint-6/plan.md`,
> issues #67–#72 first. Work in order T1 → T6. T1 (#67 cursor isolation) and
> T2 (#68 truncation) are the sprint-5 dogfood bugs — small, surgical, with
> regression tests; T1 is delivery-affecting (HIGH). T3 (v0.3.0 release)
> follows `docs/releasing.md` — OIDC, no tokens; flag anything the account
> owner must do. T4 is ops dogfooding — coordinate with the producer on the
> board. T5/T6 are decision tasks: propose on the issues before coding; no
> production code unless the decision says so. Each task: branch off `main`
> (use a git worktree if the shared checkout is busy), PR with passing CI,
> reference its issue. Report through the board (`sprint-6`) and
> `docs/sprint-6/progress.md`.