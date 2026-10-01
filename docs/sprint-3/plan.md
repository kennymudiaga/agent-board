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
- T8: npm v12 install-script allowlist (better-sqlite3) + CI/Docker verification (MEDIUM)
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

Publishing must use a non-deprecated path. npm supports **only Granular
Access Tokens** since Nov 2025 (classic tokens removed), and direct publishing
with bypass-2FA GATs is **removed January 2027**. Preferred: **trusted
publishing (OIDC)** — no token at all.

- **Primary: trusted publishing.** Account owner configures the npm-side
  trusted publisher for `@agent_board/cli` bound to `kennymudiaga/agent-board`
  (GitHub Actions; restrict to the release workflow / tag refs if supported).
  Workflow changes: add `permissions: { id-token: write }`, drop
  `NODE_AUTH_TOKEN`, publish with `--provenance`.
- **Fallback (if trusted publishing is not yet available on the account):**
  Granular Access Token scoped to `@agent_board/cli`:
  - *Today:* **Read and write (publish and stage)** + **Bypass 2FA** — fully
    unattended; but direct publish dies January 2027, so pair it with a
    migration task.
  - *Deprecation-safe:* **stage only** GAT + `npm stage publish` → human 2FA
    approval (`npm stage approve`) per release. Fine at our cadence; no
    long-lived direct-publish token ever exists.
- Document the chosen path in `docs/releasing.md`.
- Tag `v0.2.0` → release workflow: build + test, publish (path above), ghcr
  push (`ghcr.io/kennymudiaga/agent-board:v0.2.0` + `:latest`), GitHub
  Release with notes.
- Verify on a clean machine: `npm i -g @agent_board/cli && ab --version`;
  `docker pull ghcr.io/kennymudiaga/agent-board:v0.2.0`.

**Done when:** package and image public via the chosen path, release notes
published, clean-machine verify passes, path documented in `docs/releasing.md`.

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

### T8 — npm v12 install-script allowlist — MEDIUM

npm v12 (now `latest`) defaults `allowScripts` off — `better-sqlite3`'s
install script (prebuild-install) no longer runs on `npm ci`, silently
breaking the native module. Fix before runners move to npm v12:

- Run `npm approve-scripts --allow-scripts-pending` in `server/`, commit the
  resulting allowlist (package.json), and verify `npm ci` + build + tests.
- Verify the Docker build (node:22 image) still boots with the allowlist.
- Consumers of `@agent_board/cli` are unaffected — the CLI is zero-dependency
  (no lifecycle scripts).

**Done when:** clean `npm ci` + tests under npm v12 defaults; Docker job green.

## Acceptance: The Equipping Demo

1. One server, board `sprint-8`.
2. OpenCode producer (producer persona) dispatches a review request to
   `role:qa` **via MCP tools**.
3. A second OpenCode session (qa) picks it up **via MCP tools**, acks, works,
   replies.
4. VS Code extension sidebar shows presence + the thread live.
5. `npm i -g @agent_board/cli` on a clean machine; `ab whoami` against the
   public server URL (or local); `docker pull` the ghcr image.
6. No human paste between steps 2–4.

## Definition of Done (sprint)

All HIGH tasks merged with passing CI; T3–T8 merged; demo executed; QA
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
> config, mount docs for four platforms. T2 publishes via trusted publishing (OIDC) — the account owner does the npm-side setup; flag
> to the Producer what is needed. T8 (npm v12 allowlist) is a CI-health prerequisite — do it early. T6 (per-agent credentials) is a
> decision task: propose the model on the issue before coding. Each task:
> branch off `main`, PR with passing CI, reference its issue number. Report
> progress to `docs/sprint-3/progress.md` — and if T7 is live, report through
> the board itself.
