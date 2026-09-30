# Sprint 1 — Prove the Loop

> Goal: **two agents in separate sessions collaborate via the board with zero human paste.** Everything in this sprint serves that demo.

## Scope

**In:**
- Protocol spec v0.1 (`docs/spec.md`)
- Reference server: REST + SQLite + long-poll, Dockerized
- `ab` CLI client (heartbeat loop, send, read loop, ack)
- OpenCode integration: agent config + quickstart (use `ab` via bash tool)
- Test suite (server integration + CLI)
- CI: build + test on PR
- Read-only dashboard (stretch — only if core is done early)

**Out (explicitly cut):** push/SSE for agents, federation, A2A bridge, git archive, encryption, VS Code/OpenDevin clients.

## Tasks (priority order)

### T1 — Protocol spec v0.1 (`docs/spec.md`) — HIGH
Freeze entities, API, message model, delivery semantics, error codes (400/401/404/409/422), cursor rules, heartbeat/presence TTL rules, idempotency contract. Everything below implements *to* this spec.
**Done when:** spec reviewed by Producer; no open questions blocking T2.

### T2 — Reference server — HIGH
TypeScript + Hono + better-sqlite3 + Docker. Endpoints per spec: heartbeat, agents directory, messages post/get (long-poll `wait`), ack. Message lifecycle: pending → claimed(lease 5min) → done/failed → retry(max 3) → dead-letter. Presence derived from heartbeats (TTL 3× interval). Idempotency: duplicate `idempotencyKey` → 409 with original message id.
**Done when:** `docker run` boots; curl passes a full lifecycle: heartbeat → send → pickup → ack → done. Integration tests green.

### T3 — `ab` CLI — HIGH
Node CLI. Subcommands: `init` (workspace config) · `join --board` · `heartbeat --interval` (loop, status busy/idle) · `send --board --to --type --message` · `read --wait` (loop, prints new messages) · `ack`. JSON output via `--json`.
**Done when:** CLI drives the same lifecycle as T2's curl test, against the real server.

### T4 — OpenCode integration — MEDIUM
Agent config (`.opencode/agent/board.md` or equivalent) + `docs/opencode/quickstart.md`: agent persona that checks the board each loop, picks up `request`s matching its role, acks, works, replies. Uses `ab` via the bash tool.
**Done when:** documented; a human can start two OpenCode sessions and run the demo script (below).

### T5 — CI — MEDIUM
GitHub Actions: install, build, `vitest run` on every PR. **Done when:** status check green on first dev PR.

### T6 — Read-only dashboard (stretch) — LOW
Static HTML + SSE: board view, presence dots, thread tree. Only if T1–T5 land early.

## Acceptance: The Demo

1. `docker run agent-board` on :8080; `ab init`; create board `sprint-7`.
2. Session B (QA): `ab heartbeat --interval 15` + `ab read --wait` running.
3. Session A (Producer): `ab send --board sprint-7 --to role:qa --type request --message "review PR #12"`.
4. QA agent picks up, acks, reviews, sends `response`.
5. Producer's `read` loop prints the response; Producer merges.
6. **No human touched the keyboard between steps 3–5.**

## Definition of Done (sprint)
- All HIGH tasks merged with passing CI; demo script executed successfully; QA sign-off; `docs/sprint-1/done.md` written.

## Dev Team Prompt

> Paste into the dev team chat:
>
> You are the AgentBoard dev team. Sprint 1 goal: prove the loop — two agents in separate sessions collaborate via the board with zero human paste. Read `PROJECT_BRIEF.md` and `docs/sprint-1/plan.md` first. Work in priority order T1→T5 (T6 stretch). T1 (protocol spec) comes first: freeze `docs/spec.md` so T2/T3 implement to it. Raise spec questions to the Producer — don't invent deviations. Each task: branch off `main`, PR with passing CI, and reference its issue number. Deliverables this sprint: spec, reference server (Docker, SQLite, long-poll), `ab` CLI, OpenCode integration docs, CI. Report progress to `docs/sprint-1/progress.md` as you go.
