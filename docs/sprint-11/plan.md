# Sprint 11 — Dogfood Fixes: Wake Echo, Spawn Defaults & Session Discipline

> Goal: close the three dogfood findings that survived sprint 10 — the wake
> echo (#117), the stale `ab spawn` default model (#119), and the
> duplicate-response class from overlapping sessions (#113) — then ship
> **v0.5.1**. All three came out of sprint-10 dogfooding; root causes and fix
> designs are already recorded on the issues.

## Pre-sprint context

- **v0.5.0 live** (2026-10-24): identity sidecar (#109), CLI hardening (#110),
  at-rest encryption (#111), A2A query/SSE (#115), CI fix (#116). Suite
  **207/207**; `qa-1`/`qa-t5` passed every gate.
- **#117 (wake echo, HIGH for dogfood):** recipients' plugins inject into
  *every* live session of the project, so the sender's session is woken with
  mail it sent. `addressedTo()` guards only the watcher
  (`.opencode/lib/wake-core.js`, `cli/src/watch.js`); injection at
  `wake-core.js:174-188` fans out via `client.session.list({query:{directory}})`.
  A spike must establish whether a plugin can address **its own** session.
- **#119 (spawn default model, MEDIUM):** `SPAWN_DEFAULT_MODEL`
  (`opencode-go/deepseek-v4-flash`) no longer exists at the provider; workers
  exit instantly and `--log` stays 0 bytes (two died this way during T5
  resume). `AB_SPAWN_MODEL=opencode-go/deepseek-v4.1-flash` works.
- **#113 (overlapping sessions, MEDIUM):** multiple sessions sharing one
  identity all wake on the same mail and respond in duplicate. Sprint 10
  proved it again: PR #118 was merged twice-over and a corrupted `progress.md`
  working copy had to be discarded. #109's sidecar now gives each session a
  distinct identity — the missing piece is guidance and a pre-reply check.
- Server runs locally on `:8080`; board `sprint-11` created for this sprint.

## Scope

**In:**
- T1: wake echo fix (#117, HIGH) — spike + narrowest correct injection, docs, hermetic tests
- T2: `ab spawn` model default + instant-exit observability (#119, MEDIUM)
- T3: overlapping-session discipline (#113, LOW–MEDIUM) — persona/SKILL/docs + generated files
- T4: release v0.5.1 (after T1–T3 + QA; human approval before publish)

**Out:** `ab read` "responded" marker (#113 option 3 — follow-up if guidance
is insufficient), `sleeping` presence (deferred #102), federation (v1),
`ab spawn` worktree-per-worker redesign. GAT revocation remains a human npm
ops item.

## Tasks

### T1 — wake echo (#117) — HIGH

Spike first: determine empirically whether the opencode plugin context can
address its own session (probe `input` keys/session id, `@opencode/client`
types, sprint-5 spike notes in `docs/wake-on-mail.md` ~170–215). Record the
finding even if partial.

Fix, narrowest correct: a wake prompt must reach the session that should act
— never the sender, never an unrelated session. Preferred: session-scoped
injection (inject only the current session; drop the fan-out). If the current
session is not addressable: when several sessions are live, do **not** blindly
fan out — either (a) skip with an ambiguity warning pointing at tier-2
`ab watch --opencode <session-id>`, or (b) inject with an explicit recipient
marker ("addressed to X — ignore if you are not X") plus the message id, so a
non-recipient session does not act on it. Choose from spike evidence; state
why in the PR.

Files: `.opencode/lib/wake-core.js`, `.opencode/plugins/agentboard-wake.js`,
`.opencode/lib/test/wake-core.test.js`, `docs/wake-on-mail.md` (the current
text documents the echo as intended — that is the bug).

**Done when:** the echo is gone (or provably inert), hermetic tests cover
sender-not-woken / recipient-woken / ambiguous multi-session, docs updated,
#117 closed; QA PASS.

### T2 — `ab spawn` defaults + instant exits (#119) — MEDIUM

- Update `SPAWN_DEFAULT_MODEL` to a current provider id
  (`opencode-go/deepseek-v4.1-flash`) and document `AB_SPAWN_MODEL`.
- Pre-flight the model like the existing `opencode --version` check: validate
  against `opencode models` and fail loudly with the available ids (no silent
  spawn).
- Make instant exits observable: capture the child exit code / stderr into
  `--log` (or surface `worker exited within N s`) so a config failure is not
  mistaken for a claim lapse.
- Hermetic tests for the pre-flight + exit-code surfacing.

Files: `cli/src/commands.js`, `cli/test/cli.test.js` (spawn tests), help text
in `cli/src/index.js`, `docs/releasing.md`/`AGENTS.md` only if the default is
documented.

**Done when:** a bad model fails loudly before spawn; a dead worker leaves
evidence; hermetic tests; #119 closed; QA PASS.

### T3 — overlapping-session discipline (#113) — LOW–MEDIUM

Docs + persona/SKILL (generated via `ab setup`):
- **One active producer session per sprint** (close/ignore the rest); on a
  shared checkout give each session its own identity with
  `ab session <role>` / `AB_SESSION_FILE` (sprint-10 #109) instead of sharing
  `producer-1`.
- **Before replying to a thread**, check the recent thread for an existing
  response from this identity (`reply_to` ancestry) and skip if present.
- Record the sprint-10 evidence (duplicate dispatch ×4, PR #118 double-merge,
  corrupted ledger) and the "wake echo amplifies duplicates" link to #117.

Update `cli/templates/opencode/agents/board-producer.md`,
`cli/templates/opencode/agents/board-worker.md`,
`cli/templates/skills/agentboard/SKILL.md`, `docs/conventions.md`, then
`ab setup --force` and commit the regenerated copies (`ab setup --check`
clean).

**Done when:** guidance is in the shipped templates + generated files, drift
gate clean, docs updated, #113 addressed per the agreed subset (option 3
explicitly deferred), QA PASS.

### T4 — release v0.5.1 — after T1–T3 + QA

Version bumps (root, `cli/`, `server/`, `mcp/`, `vscode-ext/`) + `spec.md`
header v0.5.1 + `ab setup --force` regen; ONE release PR, **no tag/publish**
(the producer does tag → OIDC → GHCR → Release after human approval). Release
notes: wake echo fix, spawn model defaults, session discipline.

## Acceptance

1. A wake prompt no longer causes the sender/unrelated sessions to act on
   mail (#117), with spike evidence recorded.
2. `ab spawn` fails fast and loudly on an unavailable model; a worker that
   exits instantly leaves evidence in `--log` (#119).
3. Shipped guidance prevents duplicate responses from overlapping sessions
   (#113 subset), and the generated files are drift-clean.
4. v0.5.1 released + verified (npm cli+mcp provenance, GHCR, Release).

## Definition of Done

T1–T3 merged with CI + QA sign-off; T4 released + verified; progress/done
docs; `PROJECT_BRIEF.md` §7/§8 updated; #117/#119 closed and #113 resolved
(or explicitly narrowed); worktrees cleaned.
