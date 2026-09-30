# Sprint 1 — Progress

> Updated continuously by the dev team during the sprint. Final handoff in `done.md`.

## 2026-09-30 — Session start

- **Branch:** `feature/sprint-1` (single branch/PR for the whole sprint; the plan's per-task PR model was folded into one PR referencing issues #1–#6 — see note below).
- **T1 (spec):** `docs/spec.md` written and frozen as the implementation contract.
  - Decisions taken (documented in spec §10, raised on issue #1 for Producer):
    1. "retry (max 3)" = max **3 total delivery attempts** (initial + 2 retries).
    2. `ttl` expiry adds an `expired` terminal state (not in the brief's lifecycle sketch).
    3. `priority` is advisory metadata in v0.1; delivery stays FIFO by `seq`.
    4. `GET messages` gains an optional `status` query param for read-only observability (dashboards/dead-letter viewing); agents' pickup path is unaffected.
    5. Boards are auto-created on first reference (heartbeat `boards` list or message post) — no board CRUD in v0.1.
    6. `ack claimed` = lease renewal (covers the CLI's `claimed` ack status); pickup itself claims messages atomically.
- **Deviation note (workflow):** plan says "each task: branch off main, PR with passing CI, reference its issue number". With one implementation session covering T1–T5, we ran one branch (`feature/sprint-1`) and will open one PR referencing issues #1–#5 (and #6 if T6 lands). Spec review happens via the PR.
- **Next:** T2 reference server.

## 2026-09-30 — T1 + T2 done

- **T1 (spec):** `docs/spec.md` frozen (see above). Open questions posted to issue #1.
- **T2 (reference server):** `server/` workspace — Hono + better-sqlite3 (v12 for Node 24 prebuilds; plan said better-sqlite3, version bumped for prebuild availability) + @hono/node-server. Dockerfile (multi-stage, node:22-bookworm-slim, persistent `/data` volume, healthcheck).
  - Endpoints per spec: heartbeat, agents directory, messages post/get (long-poll `wait`, claim-on-pickup, observability `status` filter), ack (claimed=lease renewal, done, failed→retry→dead).
  - Lifecycle: pending → claimed (5-min lease) → done/failed → retry (max 3) → dead; ttl → expired; lazy lease/ttl sweep on pickup.
  - Idempotency: unique (sender, idempotencyKey) → 409 with originalMessageId.
  - Presence: TTL = 3×interval, derived from heartbeats.
  - **17 integration tests green** (`server/test/lifecycle.test.ts`): full loop, idempotency, addressing, retry/dead-letter, lease expiry + renewal, long-poll wake, ttl, ack conflicts, validation, 404s, directory filters, presence.
  - Notes: better-sqlite3 v11 had no Node-24 win32 prebuild and node-gyp couldn't build locally → moved to ^12 (still the plan's better-sqlite3, just newer). npm 11 blocked install scripts on first install; resolved via reinstall (prebuilds cached).
- **Next:** T3 `ab` CLI.

## 2026-09-30 — T3 done

- **T3 (`ab` CLI):** `cli/` workspace — zero-dependency Node CLI (plain JS, no build step so agents can run it instantly via the bash tool; TS would force a build before use). Subcommands per plan: `init` (writes `.agentboard.json`), `join --board`, `heartbeat --interval` (loop, `--status`, `--task`, `--once`), `send` (`--to agent:|role:|broadcast`, `--type` default request, `--payload`/`--message`, `--reply-to`, `--priority`, `--ttl`, `--idempotency-key`), `read --wait` (long-poll loop, cursor persisted in config, `--ack claimed|done|failed` auto-ack, `--once`), `ack`. `--json` on all commands. Env overrides AB_SERVER/AB_TOKEN/AB_AGENT_ID.
- **Bug caught by tests:** read loop initially advanced the persisted cursor to the server's max-seq, which would skip lease-expiry redeliveries (breaking at-least-once). Fixed: cursor only advances past *finalized* (acked) messages; in-process dedupe by id. Spec §6.2 updated with the "client watermark rule".
- **6 CLI integration tests green** (`cli/test/cli.test.js`) — real server on an ephemeral port, CLI driven as subprocess: init config, auth failures, full lifecycle (heartbeat → send → read → ack done → no redelivery), idempotency 409 via CLI, failed→retry→dead, auto-ack + ack conflict, validation errors. **Total: 23 tests green.**
- **Next:** T4 OpenCode integration.

## 2026-09-30 — T4 + T5 done

- **T4 (OpenCode integration):**
  - `.opencode/agent/board.md` — `board` agent (mode primary, bash allowed): mailbox discipline persona — heartbeat per loop, `ab read --once --json` mail check, pickup-is-claim, ack done/failed/claimed(renew), reply with `--type response --reply-to`, never ack what isn't yours. Agent file format validated against the opencode config schema (skill).
  - `docs/opencode/quickstart.md` — install `ab` (npm link), server start (docker/dev), two identities, board loops, two OpenCode sessions (Producer + QA), the Acceptance demo steps, verification commands, troubleshooting table.
- **T5 (CI):** `.github/workflows/ci.yml` — checkout, node 22, `npm ci`, `npm run build`, `npm test` on PR + push to main. Status check gates merges.
- **Next:** full verification (build, tests, docker build/run, demo lifecycle end-to-end), then T6 stretch + handoff.