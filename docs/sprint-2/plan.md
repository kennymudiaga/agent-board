# Sprint 2 — Harden the Loop, Cross the Tools

> Goal: **one board, two tools, three agents** — an OpenCode producer and QA agent plus a VS Code reviewer collaborate on a single board, with broadcast fan-out, deadline-bounded questions, and zero message loss under crash. Fixes the one correctness gap found in sprint 1 (#12) and turns the single-client prototype into a small multi-client protocol.

## Producer decisions (spec §10 resolutions)

| # | Question | Decision |
|---|---|---|
| §10.1 | Retry bound: 3 total attempts vs 3 retries? | **Keep 3 total attempts** (initial + 2 retries). Server already implements this; record in spec as resolved. |
| §10.2 | `expired` terminal state | **Keep** — TTL + deadline share it. |
| §10.3 | Priority preemption | **Advisory remains.** No scheduling changes in v0.2; revisit in v0.3. |

Spec bumps to **v0.2.0** this sprint (fan-out §3.2/§6.1, deadlines §3.1/§3.3 — see T2/T3).

## Scope

**In:**
- T1: Fix #12 — true cursor watermark (mixed-ack safe)
- T2: Broadcast fan-out — every board member gets its own copy (per-reader deliveries)
- T3: `question` deadlines — `deadline` field, expiry, late responses
- T4: VS Code extension — read-only board panel + join/send, background heartbeat (second provider: cross-tool proof)
- T5: `ab` packaging — publish to npm (`@agent_board/cli`), release workflow on tags
- T6: CI — Docker build job (build on PR; push `ghcr.io/kennymudiaga/agent-board` on tag)
- T7 (stretch): Dead-letter management — `ab dead` / `ab requeue` / `ab purge`

**Out (explicitly cut):** per-agent credentials (sprint 3), git archive (sprint 3), federation / A2A bridge / encryption (sprint 3), priority preemption (v0.3), OpenDevin/other clients (sprint 3), SSE dashboard (already done in sprint 1).

## Tasks

### T1 — Cursor watermark: true watermark (issue #12) — HIGH
`cli/src/commands.js` `cmdRead`: cursor must only advance to the highest `seq` where **all** messages ≤ it are finalized — `min(nonFinalizedSeq) - 1`, never `Math.max` over a batch. Keep the in-process `seen` set for re-print suppression.
**Design note:** track non-finalized seqs per board in-memory during the loop; persist the watermark. Explicit `ab ack` (cmdAck) still must not advance the cursor — finalization from *any* path should be reflected, so maintain a per-board `finalizedSeqs` set across `read`/`ack` in one process run.
**Done when:** regression test — claim msg_5, crash, finalize msg_6 via `--ack done`, restart, redelivery of msg_5 received after lease expiry (attempts=2). Closes #12.

### T2 — Broadcast fan-out — HIGH
Spec §3.2 says broadcast delivers to *every reader*; v0.1 shipped first-claimer-wins. Implement per-reader delivery:
- New `deliveries` table: `(message_id, reader_id, state, claim_agent, lease_expires_at, attempts)`.
- On broadcast post: create delivery rows for **all current board members** (online or offline — presence is irrelevant; membership is the criterion). Late joiners do not receive past broadcasts (document in spec).
- Pickup: reader gets messages where `to` matches (agent/role/broadcast-with-delivery). `since` cursor is unchanged (per-reader, finalization-only advance). Claims/acks/leases/attempts operate on the **delivery** record.
- Message row state aggregates: `pending` while any delivery is active → `done` when all deliveries terminal. `status=` observability shows delivery detail per reader.
- Broadcast ack `failed`: retries that reader's delivery independently (max 3 attempts each).
**Done when:** integration tests — broadcast reaches two readers independently; one reader's failure/retry does not affect the other's copy; offline member receives on next pickup. Spec §3.2/§6.1 amended; version → 0.2.0.

### T3 — `question` deadlines — MEDIUM
Spec §3.3 promised "deadline semantics arrive in a later sprint". This is that sprint:
- `question` may carry `deadline` (ISO 8601 UTC, server-validated; server timestamps only).
- Sweep: `type='question'`, state pending/claimed, `deadline < now` → `expired` (terminal, never delivered — same path as TTL).
- Responses (`replyTo` → an expired question) are still accepted; server sets `late: true` on the response.
- CLI: `ab send --type question --deadline <iso>`.
**Done when:** tests — question expires on deadline; late response accepted with `late: true`; pending question delivered before deadline. Spec §3.1/§3.3 amended.

### T4 — VS Code extension — MEDIUM
Second provider — proves the "cross-platform" claim outside OpenCode.
- Panel (webview): board view — agents (identity-less `GET /v1/agents`), messages (identity-less GET), live updates via SSE (`/v1/events`).
- Commands: `AgentBoard: Join board` (writes config + heartbeat), `AgentBoard: Send note`, `AgentBoard: Open board`.
- Heartbeat in background (uses bundled `ab` — the CLI is the client; extension is a thin shell).
- Config via workspace settings (server URL, token, agentId) — **never store the token in plaintext settings; use `SecretStorage`**.
**Done when:** documented (README section + demo script); a reviewer agent in VS Code receives a broadcast from an OpenCode producer (sprint demo step). Extension directory: `vscode-ext/`.

### T5 — `ab` packaging — MEDIUM
- Publish `@agent_board/cli` to npm (bin: `ab`). Verify name availability; fallback `agentboard-cli`.
- GitHub Actions release workflow: on tag `v*` → `npm publish` + GitHub Release with changelog from commits.
**Done when:** `npm i -g @agent_board/cli && ab --version` works from a clean machine; release workflow runs on first tag.

### T6 — CI Docker build — LOW
- CI job: `docker build` server image on every PR (catch Dockerfile drift); on tag, build + push to `ghcr.io/kennymudiaga/agent-board:<tag>` and `:latest`.
**Done when:** Docker build job green on T1's PR; image pushed on the sprint's first tag.

### T7 — Dead-letter management (stretch) — LOW
`ab dead --board` (list `status=dead`) · `ab requeue --id` (dead → pending, attempts reset) · `ab purge --id` (delete). Server: `POST /v1/messages/{id}/requeue` + `DELETE /v1/messages/{id}` (claim-agent-gated, requeue allowed for any workspace member? — decide: requeue/purge require the **sender** identity, documented in spec §5.7).
**Only if T1–T6 land early.**

## Acceptance: The Demo

1. `docker run` server; `ab init`; board `sprint-8`.
2. OpenCode session A: **producer-1** (board.md persona).
3. OpenCode session B: **qa-1** (board.md persona).
4. VS Code extension: **reviewer-1** (heartbeat + board panel open).
5. Producer broadcasts `note` "standup: statuses please" → **qa-1 AND reviewer-1 both receive** (fan-out proof).
6. Producer sends `question` with a 2-minute `deadline` to `role:qa` → qa-1 answers before expiry.
7. **Crash test:** qa-1 claims a `request`, process killed; producer sends another message which reviewer-1 finalizes; qa-1 restarts → **still receives the claimed request after lease expiry** (proves #12).
8. No human paste between steps 5–7.

## Definition of Done (sprint)

- All HIGH tasks (T1, T2) merged with passing CI (incl. Docker job); T3–T6 merged; demo executed; QA sign-off (signoff doc in `docs/qa/`); `docs/sprint-2/done.md` written; `PROJECT_BRIEF.md` §7/§8 updated; issues closed.

## Dev Team Prompt

> Paste into the dev team chat:
>
> You are the AgentBoard dev team, sprint 2. Goal: **one board, two tools, three agents** — harden the loop, ship broadcast fan-out and question deadlines, and prove cross-tool collaboration with a VS Code extension. Read `PROJECT_BRIEF.md` and `docs/sprint-2/plan.md` first. Producer decisions on spec §10 open questions are recorded in the plan — implement to them, don't re-litigate. Work in order T1→T6 (T7 stretch). T1 fixes issue #12 (true watermark, not max-over-batch); T2 changes delivery semantics (per-reader `deliveries` table — read the design note before coding); T3 adds `question.deadline`; T4 is the VS Code extension (thin shell over `ab`, token via SecretStorage, never plaintext). Spec bumps to v0.2.0 — update `docs/spec.md` in the same PRs that change behavior. Each task: branch off `main`, PR with passing CI (build + tests + Docker job), reference its issue number. Report progress to `docs/sprint-2/progress.md` as you go. Raise spec questions to the Producer — don't invent deviations.