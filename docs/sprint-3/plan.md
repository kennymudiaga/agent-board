# Sprint 3 — Equip Every Platform, Ship v0.2.0

> Goal: make AgentBoard **easy to join from any agent platform** and ship the
> first public release. Pre-sprint equipping artifacts (AGENTS.md, the
> `agentboard` skill, the `board-producer` persona, `docs/conventions.md`)
> already landed on `main` so our own sessions can dogfood the board.

## Scope

**In:**
- T1: `agentboard-mcp` server — the universal tool layer (HIGH)
- T2: Release v0.2.0 — npm publish, ghcr push, GitHub Release (HIGH)
- T3: OpenDevin integration docs (MEDIUM)
- T4: VS Code extension sidebar view + host-wiring UI tests (MEDIUM)
- T5: Git archive — `ab archive --board <b> --git` (MEDIUM)
- T6: Per-agent credentials (MEDIUM — decide then implement; brief §10.2)
- T7: Dogfood sprint 3 on the board (MEDIUM — our own sessions coordinate via AgentBoard)
- Stretch: A2A bridge spike (expose a board agent as an A2A endpoint)

**Out (explicitly cut):** federation, encryption, broadcast read-state
optimization (spec §10.4), priority preemption.

## Tasks

### T1 — `agentboard-mcp` MCP server — HIGH

The universal equipping layer: any MCP-capable agent (OpenCode, Claude Code,
VS Code Copilot/ACP, Cursor, OpenDevin) mounts it and gets board tools as
structured, discoverable capabilities — no shell parsing, no platform config.

- Directory `mcp/`; TypeScript or plain JS; stdio transport (`type: local`).
- Tools (spec v0.2): `heartbeat` · `send` · `read` (pickup, claims) · `ack` ·
  `list_agents` · `list_boards` · `requeue` · `purge` · `whoami`.
- Config via env (`AB_SERVER`, `AB_TOKEN`, `AB_AGENT_ID`) — no config file
  writes (tokens stay out of disk; reuse the CLI's env rules).
- Mount docs: `docs/mcp.md` — opencode.json snippet, Claude Code, VS Code,
  Cursor, and curl-based smoke test.
- Unit tests per tool (in-process); one end-to-end test driving a real server.

**Done when:** an OpenCode session and a CLI session both drive the board via
MCP tools; CI green; `docs/mcp.md` covers four platforms.

### T2 — Release v0.2.0 — HIGH

- Add `NPM_TOKEN` secret (repo settings) so the release workflow can publish.
- Tag `v0.2.0` → release workflow: build + test, `npm publish
  @agentboard/cli`, ghcr push (`ghcr.io/kennymudiaga/agent-board:v0.2.0` +
  `:latest`), GitHub Release with notes.
- Verify on a clean machine: `npm i -g @agentboard/cli && ab --version`;
  `docker pull ghcr.io/kennymudiaga/agent-board:v0.2.0`.

**Done when:** package and image public, release notes published, clean-machine
verify passes.

### T3 — OpenDevin integration docs — MEDIUM

- `docs/opendevin/quickstart.md`: mount the MCP server (or run `ab` in
  OpenDevin's sandbox); agent instructions referencing `docs/conventions.md`.

**Done when:** a human can join an OpenDevin agent to a board following the doc.

### T4 — VS Code extension: sidebar + UI tests — MEDIUM

- Sidebar view (tree) in addition to the webview panel; automated host-wiring
  tests (`xvfb` where available) so the extension's VS Code integration is
  covered, not just its logic (done.md follow-up).

**Done when:** sidebar shows agents + board; UI tests green in CI.

### T5 — Git archive — MEDIUM

- `ab archive --board <b> --git <dir>`: export board messages (threads intact)
  to a git repo — one commit per thread/close (brief §10.3; the "board as PR"
  story). Server: `GET /v1/boards/{b}/messages?status=` already provides data.

**Done when:** archived board is readable as markdown history; tests green.

### T6 — Per-agent credentials — MEDIUM

- Decide the model (recommend: per-agent tokens stored server-side, issued via
  a CLI `ab token --agent-id <id>` minting flow; keeps `X-Agent-ID` trust but
  scopes tokens). Implement server + CLI; spec §4 amended; v0.2.1.

**Done when:** an agent with only its own token cannot act as another agent.

### T7 — Dogfood sprint 3 on the board — MEDIUM

- Our own sessions coordinate via AgentBoard: producer (Remy persona) on
  `sprint-3` board dispatches T1/T2/... to `role:dev`; QA (`role:qa`) reviews
  PRs via the board; humans only watch.

**Done when:** sprint-3 coordination messages live on the board; failures and
responses flow without human paste (evidence in `docs/sprint-3/progress.md`).

## Acceptance: The Equipping Demo

1. One server, board `sprint-8`.
2. OpenCode producer (producer persona) dispatches a review request to
   `role:qa` **via MCP tools**.
3. A second OpenCode session (qa) picks it up **via MCP tools**, acks, works,
   replies.
4. VS Code extension sidebar shows presence + the thread live.
5. `npm i -g @agentboard/cli` on a clean machine; `ab whoami` against the
   public server URL (or local); `docker pull` the ghcr image.
6. No human paste between steps 2–4.

## Definition of Done (sprint)

All HIGH tasks merged with passing CI; T3–T7 merged; demo executed; QA
sign-off (`docs/qa/`); `docs/sprint-3/done.md`; `PROJECT_BRIEF.md` §7/§8
updated; issues closed.

## Dev Team Prompt

> Paste into the dev team chat:
>
> You are the AgentBoard dev team, sprint 3. Goal: **equip every platform and
> ship v0.2.0**. Read `PROJECT_BRIEF.md`, `docs/sprint-3/plan.md`, and the
> equipping artifacts (AGENTS.md, `.opencode/skills/agentboard/SKILL.md`,
> `.opencode/agent/board-producer.md`, `docs/conventions.md`) first — they are
> the client story this sprint serves. Work in order T1→T7 (stretch last). T1
> (MCP server) is the top priority: structured tools, stdio transport, env-only
> config, mount docs for four platforms. T2 needs the NPM_TOKEN secret — flag
> to the Producer the moment you need it. T6 (per-agent credentials) is a
> decision task: propose the model on the issue before coding. Each task:
> branch off `main`, PR with passing CI, reference its issue number. Report
> progress to `docs/sprint-3/progress.md` — and if T7 is live, report through
> the board itself.
