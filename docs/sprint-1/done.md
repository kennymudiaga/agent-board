# Sprint 1 — Done

> Handoff from the dev team. Sprint goal: **prove the loop** — two agents in separate sessions collaborate via the board with zero human paste. Achieved.

## What landed (branch `feature/sprint-1`, PR #7)

| Task | Deliverable | Status |
|---|---|---|
| T1 | `docs/spec.md` — protocol v0.1 frozen (entities, API, message model, lifecycle, cursors, presence, auth, error codes) | ✅ |
| T2 | `server/` — reference server: Hono + better-sqlite3 + Docker. Heartbeat, agents directory, messages post/get (long-poll `wait`, claim-on-pickup, observability `status` filter), ack (claimed=renew / done / failed→retry→dead). Idempotency 409, lease 5 min, TTL, presence = 3×interval | ✅ |
| T3 | `cli/` — `ab` CLI: `init` · `join` · `heartbeat` · `send` · `read` · `ack`, `--json`, env overrides, persisted cursors (watermark advances only past finalized messages) | ✅ |
| T4 | `.opencode/agent/board.md` (board-worker persona) + `docs/opencode/quickstart.md` (two-session demo) | ✅ |
| T5 | `.github/workflows/ci.yml` — install, build, `vitest run` on every PR (and push to main) | ✅ |
| T6 | Stretch done: read-only dashboard at `/` (presence dots, board view, thread tree) + `GET /v1/events` SSE stream (spec §5.6) | ✅ |

## Verification

- **26 tests green** (`npm test`): 17 server integration (full lifecycle, idempotency, addressing, retry→dead-letter, lease expiry/renewal, long-poll, ttl, ack conflicts, validation, presence, directory filters) + 3 dashboard (static page, SSE auth, live events) + 6 CLI integration (real server on ephemeral port, CLI as subprocess: init, auth, full lifecycle, idempotency 409, retries→dead, auto-ack/conflicts, validation).
- **Docker:** image builds; `docker run` boots on :8080 with healthcheck; curl full lifecycle green against the container.
- **The demo** (plan Acceptance, steps 1–6) executed against the containerized server: `ab init` → board `sprint-7` → QA heartbeat + long-poll read → Producer `send` → QA pickup (claim) → ack done → `response` with `reply-to` → Producer's read loop printed the response. **No human paste between steps 3–5.**

## Decisions & deviations (all noted in `progress.md`, raised on issues #1/#2/#3/#4/#5)

1. One branch + one PR for the sprint instead of per-task PRs (single implementation session; PR references issues #1–#6).
2. Spec interpretations (frozen, raised on issue #1 for Producer sign-off): "retry (max 3)" = 3 total delivery attempts; `ttl` expiry adds `expired` terminal state; `priority` advisory in v0.1; boards auto-create on first reference; `ack claimed` = lease renewal.
3. better-sqlite3 v12 (Node 24 prebuilds; v11 had none and node-gyp wasn't available locally).
4. CLI is plain JS (no build step) so agents can run `ab` via the bash tool with zero friction.
5. Spec addition (issue #6, dashboard): `GET /v1/events` SSE stream; token accepted as query param there only (EventSource can't set headers). Dashboard shell at `/` is unauthenticated but carries no data.
6. Git identity: repo-local `kennymudiaga` (no global config touched).

## Follow-ups for sprint 2 (suggested)

- Broadcast fan-out (every reader gets a copy) — currently first-claimer-wins (spec §3.2, flagged to Producer).
- Per-agent credentials vs shared token (brief §10.2).
- Dead-letter management UI/CLI (dead messages are visible via `status=dead` only).
- `ab` packaging (npm publish / standalone binary) so non-Node agents can use it.
- CI: add a Docker build job.

## Open items for the Producer

- Review `docs/spec.md` §10 open questions (comment on issue #1).
- Merge PR #8 (regular merge per team workflow) and close issues #1–#6.
- QA sign-off on the demo before/after merge (demo script in `docs/opencode/quickstart.md` §6).