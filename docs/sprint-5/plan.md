# Sprint 5 — Wake-on-Mail

> Goal: **agents stop polling — the board wakes them.** Ship the wake-on-mail
> stack from `docs/wake-on-mail.md` (opencode plugin preferred, `ab watch`
> fallback, VS Code watcher), close the QA hygiene follow-ups from sprint 4,
> and land the remaining chunk-2 items (token expiry/rotation, broadcast
> read-state decision, dashboard delivery detail).

## Pre-sprint context

- Sprint 4 chunk 1 **shipped** (PRs #47–#50, QA-signed): A2A relay live on the
  reference server (`docs/a2a.md`, demo client committed); `ab spawn` +
  `ab agents` + `ab init --global` all dogfooded on the board.
- `docs/wake-on-mail.md` — design note (research: opencode wakeable via
  `prompt_async`/`session.prompt`; VS Code interactive chat NOT wakeable via
  stable API — headless turns + notify only).
- QA follow-ups from `docs/qa/sprint-4-signoff.md`: cli.test.js `AB_*`
  hygiene; suite-count methodology note.

## Scope

**In:**
- T1: `ab watch` — wake-on-mail CLI daemon (#51, HIGH — foundation, do first)
- T2: opencode wake plugin — prompt the live session (#52, HIGH — preferred tier)
- T3: vscode-ext watcher — notify + opt-in headless handling (#53, MEDIUM)
- T4: cli.test.js hygiene — hermetic `runCli` + suite-count note (#54, MEDIUM — small, do early)
- T5: per-agent token expiry + rotation (#55, HIGH — security)
- T6: broadcast read-state — decide, then implement (#56, MEDIUM — decision first)
- T7: dashboard delivery detail (#57, LOW)

**Out (explicitly cut):** federation, encryption, A2A `tasks/query`/SSE/registry,
interactive Copilot Chat wake (track upstream — not an extension API).

## Tasks

### T1 — `ab watch` CLI daemon (#51) — HIGH

The board is the promise; `ab watch` is the await. Long-polls a board for the
watched identity and runs an action on arrival: `--exec <cmd>` (spawn-on-
arrival, dogfoods `ab spawn`; brief via file/env, never shell-interpolated),
`--opencode <session-id>` (`prompt_async` into a live session),
`--notify` (OS notification). Dedupe on message id; never ack on the agent's
behalf; `--once` per message id. Document the `wake:*` capability vocabulary
in `docs/conventions.md`. Tests: hermetic with an in-memory server.

**Done when:** a message for the watched identity triggers the action,
redeliveries dedupe, no acks issued; tests green; `wake:*` documented.

### T2 — opencode wake plugin (#52) — HIGH

**Spike first** (verify plugin-context `client.session.prompt`, else
`prompt_async` against the local server — record in `docs/wake-on-mail.md`),
then the plugin: background watcher loop (reuse T1's core where sensible),
inject wake prompts (message id, board, thread refs, sender, text) into the
live session; filters only `agent:`/`role:` mail to self; no auto-reply loops.
Agent declares `wake:opencode-session` (conventions doc from T1).

**Done when:** a running opencode session is woken by an incoming board
message (demo); spike findings + usage documented.

### T3 — vscode-ext watcher (#53) — MEDIUM

Watcher in vscode-ext: long-poll the board for the user's agent; notification
+ sidebar bump + thread preview. Opt-in `agentboard.wake.autoHandle`:
headless turn via `vscode.lm` (consent-gated, `LanguageModelError` handled)
or `opencode run` in the integrated terminal. Capabilities
`wake:vscode-notify` / `wake:vscode-headless`. Hermetic watcher tests +
host-wiring test for the notification path.

**Done when:** with VS Code open, a message for the agent notifies (+
auto-handles when enabled + consented); README updated.

### T4 — cli.test.js hygiene (#54) — MEDIUM

`runCli` clears/overrides ALL `AB_*` env for children (currently only
`AB_SERVER`/`AB_TOKEN` — ambient `AB_AGENT_ID`/`AB_ROLES` leak breaks 11
tests under a spawned-worker environment). Add the suite-count methodology
note (npm test vs VS Code Test Runner) to the docs.

**Done when:** `AB_AGENT_ID=qa-x AB_ROLES=qa npm test` passes; note added.

### T5 — token expiry + rotation (#55) — HIGH

`POST /v1/tokens` accepts `ttlDays` (per-token expiry, recommend per-token
semantics — record the decision); expired token → 401 with a distinct code;
`ab token --agent-id <id> --rotate` atomically replaces the stored hash
(old token dies immediately). Spec §5.9 amended; CLI help updated; tests.

**Done when:** short-ttl token expires → 401; rotation invalidates the old
token; spec + CLI updated; suite green.

### T6 — broadcast read-state (#56) — MEDIUM

Decision first (recorded in the plan + spec §10): keep copy-per-member (v0.2
model — simple per-reader leases, already shipped) vs one-row + read receipts
(lighter storage, "who has read" views, reworks delivery). Likely: keep the
model, ship an aggregate `reads` view for dashboards. Spec §3.2/§6.1 amended
to match reality.

**Done when:** decision recorded; implementation (if any) tested; spec
reflects reality.

### T7 — dashboard delivery detail (#57) — LOW

Observability view already carries per-reader `deliveries`; surface them in
the dashboard UI (per-message expander: reader → state/attempts).

**Done when:** a broadcast's per-reader deliveries visible in the dashboard.

## Acceptance: The Autonomous A2A Demo

1. One server, board `sprint-8`.
2. A2A client `tasks/send`s "review PR #12" → `role:qa`.
3. **No agent session is polling.** The request lands; `ab watch` (or the
   opencode plugin) detects it and **wakes** a QA worker (spawn or live-
   session prompt).
4. The worker answers via `ab` and acks.
5. The A2A client polls `tasks/get` → `completed` with the artifact.
6. No human paste, no polling session, between steps 2–5.

Plus dogfood: the producer runs `ab watch` against `sprint-5` during the
sprint (wake-on-arrival for responses).

## Definition of Done (sprint)

T1–T5 merged with passing CI; T2 + T5 QA-signed (`docs/qa/sprint-5-signoff.md`);
the Autonomous A2A demo executed (recorded in `docs/sprint-5/done.md`); T6
decision recorded; T7 merged; progress in `docs/sprint-5/progress.md`;
`PROJECT_BRIEF.md` §7/§8 updated; issues #51–#57 closed.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 5. Goal: **wake agents — stop the
> polling**. Read `PROJECT_BRIEF.md`, `docs/sprint-5/plan.md`,
> `docs/wake-on-mail.md` (the design note — read the research findings
> before coding T1–T3) and `docs/a2a-spike.md` first. Work in order T1 → T7.
> T1 (`ab watch`) is the foundation — hermetic, well-tested, no ack-on-
> behalf. T2 (opencode plugin) needs the spike FIRST (record findings, then
> implement). T4 is small — do it early. T5 (token expiry) is security-
> relevant: decision recorded, spec amended. T6 is a decision task — propose
> on the issue before coding. Each task: branch off `main`, PR with passing
> CI, reference its issue. Report through the board (`sprint-5`) and
> `docs/sprint-5/progress.md`.