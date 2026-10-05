# Sprint 10 — Identity, CLI Hardening, Encryption & A2A Events

> Goal: stop the session-identity ping-pong on shared checkouts (#109), close
> the win32 `--exec` gap and two small CLI follow-ups (#110 + sprint-9
> non-blocking items), ship the long-deferred **at-rest encryption** option
> (sprint-6 decision, spec §10.7), extend the A2A relay with **`tasks/query`
> + SSE task events** (docs/a2a.md), and release v0.5.0.

## Pre-sprint context

- v0.4.1 live (wake, watch & worker ergonomics). Sprint 9 + kickoff findings:
  - **#109** (filed 2026-10-05): bootstrap `as <role>` replaces the workspace
    identity in `.agentboard.json` — producer/dev sessions ping-pong-clobber
    each other on one checkout (reproduced at sprint-10 kickoff: config left
    as `dev-4`, producer had to re-init). dev-1 offered to draft the fix.
  - **#110** (filed 2026-10-05): `ab watch --exec` on win32 — multi-word
    commands split by launcher quoting (verified live: watcher fired, exec
    ran a bare `node`). Docs/guard gap.
  - Sprint-9 non-blocking follow-ups: `AB_WAKE_RESOLVE_MS` NaN coercion;
    `--log` missing parent dir → raw ENOENT.
  - At-rest encryption: decision recorded sprint 6 T5 (spec §10.7) — scope
    for v0.4+ behind `AB_ENCRYPTION_KEY`; SQLCipher vs field-level AES spike
    pending; migration path for existing deployments needed.
  - A2A relay (sprint 4, docs/a2a.md) supports `tasks/send|get|cancel`;
    `tasks/query` + SSE task-event streaming are the documented next step.
- Board `sprint-10` created; `producer-1` joined; wake daemon live (verified:
  agent/role addressing, role filter, wake-loop guard, never-claims).

## Scope

**In:**
- T1: session identity sidecar (#109, HIGH)
- T2: CLI hardening bundle (#110 + 2 sprint-9 follow-ups, LOW)
- T3: at-rest encryption (spec §10.7, MEDIUM — design-first, independent QA)
- T4: A2A `tasks/query` + SSE (docs/a2a.md, MEDIUM)
- T5: release v0.5.0 (after T1–T4 + QA; human approval before publish)

**Out:** `sleeping` presence (deferred in #102 — protocol change, marginal
gain; `wake:*` caps cover it), federation (v1), A2A registry,
key rotation/KMS for at-rest encryption (post-v0.5 hardening).

## Tasks

### T1 — session identity sidecar (#109) — HIGH

Bootstrap `as <role>` must NOT replace the workspace identity. Design is
filed in #109: (A) per-agent sidecar — `as <role>` writes a per-agent
identity (`.agentboard.<id>.json` or AB_* injection in the bootstrap command)
leaving `.agentboard.json` untouched, or (B) at minimum document the
`AB_SERVER`/`AB_TOKEN`/`AB_AGENT_ID`/`AB_ROLES` env overrides in the
bootstrap flow (`/ab` command), since they already resolve any identity with
zero config writes. dev-1 has offered to draft. Touches: opencode bootstrap
command/plugin, `cli/src/config.js` (sidecar precedence if A), quickstart
docs.

**Done when:** on a producer-configured checkout, `/ab join <board> as dev`
yields a dev identity for that session without changing the workspace
identity (live test on this machine); bootstrap flow documents AB_* overrides
(option B) or sidecar works (option A); tests green; #109 closed.

### T2 — CLI hardening bundle (#110 + follow-ups) — LOW

- `ab watch --exec` win32 quoting: document in help + `docs/wake-on-mail.md`
  that `--exec` is a single shell-invoked token (quote it / use a `.cmd`
  wrapper on win32); optional guard: warn when the exec target is a bare
  known binary or positionals remain.
- `AB_WAKE_RESOLVE_MS` NaN coercion (sprint-9 follow-up).
- `--log` missing parent dir → friendly error instead of raw ENOENT
  (sprint-9 follow-up).

**Done when:** docs updated, hermetic tests for the guard/coercion/ENOENT
cases, `ab setup --check` clean, #110 closed.

### T3 — at-rest encryption (spec §10.7) — MEDIUM (design-first, independent QA)

Follow the sprint-6 decision: spike SQLCipher (`@journeyapps/sqlcipher`
drop-in) vs field-level AES on a copy of the live DB (payload columns,
`AB_ENCRYPTION_KEY` from env), pick per the spike evidence, implement behind
`AB_ENCRYPTION_KEY` (absent = current plaintext behavior, transport-only
stance remains the default), document the migration path for existing
deployments (dump/restore or in-place), update spec §10.7. Security-sensitive
→ independent QA review + sign-off before merge.

**Done when:** encrypted-at-rest option works end-to-end (write/read/ack/
A2A/dashboard previews), unset key = unchanged behavior, migration documented,
spec updated, independent QA sign-off.

### T4 — A2A `tasks/query` + SSE (docs/a2a.md) — MEDIUM

Extend the relay: `tasks/query` (list/filter tasks by thread/agent/state —
JSON-RPC per the A2A draft) + SSE task-event stream (task created/updated/
completed), scoped per workspace like the rest of the server (sprint 8 W4).
Update `docs/a2a.md` + the demo client to exercise query + events.

**Done when:** demo client queries and subscribes live, cross-workspace
isolation holds (no task/event leakage), docs updated, QA sign-off.

### T5 — release v0.5.0 (#new) — MEDIUM (after T1–T4 + QA)

Version bumps (cli + mcp), spec header, regenerated agent files, tag → OIDC
publish (cli + mcp, provenance) → GHCR → Release notes (identity sidecar,
CLI hardening, at-rest encryption, A2A query/SSE). Clean-machine verify.
Human approval before publish. Note: GAT revocation hygiene remains a human
ops item (npm).

**Done when:** v0.5.0 live + verified.

## Acceptance

1. `/ab join <b> as dev` never clobbers the workspace identity (T1 live test).
2. `ab watch --exec` multi-word behavior documented/guarded on win32; NaN +
   ENOENT follow-ups fixed (T2).
3. `AB_ENCRYPTION_KEY`-enabled server stores payloads encrypted at rest;
   unset key = unchanged; migration path documented (T3, QA).
4. A2A clients query tasks and subscribe to task events over SSE, isolated
   per workspace (T4, QA).
5. v0.5.0 released with provenance + verified (T5).

## Definition of Done

T1–T4 merged with CI + QA sign-off; T5 released + verified; progress/done
docs; `PROJECT_BRIEF.md` §7/§8 updated; #109/#110 closed; worktrees cleaned.

## Dev Team Prompt

> You are the AgentBoard dev team, sprint 10. Goal: **identities that don't
> clobber, a CLI that survives win32, payloads that can rest encrypted, and
> A2A that streams**. Read `PROJECT_BRIEF.md`, `docs/sprint-10/plan.md`,
> issues #109, #110, spec §10.7 and `docs/a2a.md` first. Work in order
> T1 → T2 → T3 → T4. T1 (#109) is the headline: dev-1 has a draft offer —
> the fix must leave the workspace identity untouched (sidecar or documented
> AB_* overrides) and be live-proven on this machine. T2 is a small bundle
> (win32 `--exec` docs/guard + 2 follow-ups). T3 (#encryption) is
> design-first: spike SQLCipher vs field-level AES on a copy of the live DB,
> record the choice, then implement behind `AB_ENCRYPTION_KEY` with a
> documented migration path. T4 extends the A2A relay (`tasks/query` + SSE),
> scoped per workspace. Work in YOUR worktree (`spawn/<agentId>`), never the
> main checkout; keep scratch files inside the worktree (the %TEMP% wall).
> Each task: branch off `main`, PR with passing CI, reference its issue.
> Report through the board (`sprint-10`) and `docs/sprint-10/progress.md`.