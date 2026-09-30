# Sprint 2 — Progress

> Updated continuously by the dev team during the sprint. Final handoff in `done.md`.

## 2026-09-30 — Session start

- **Branch:** `feature/sprint-2` (single branch/PR for the sprint, same model as sprint 1 — the plan's per-task PRs folded into one PR referencing issues #12–#19; noted as a deviation, as before).
- **T1 (true cursor watermark, #12) — done:**
  - Root cause: client-side `Math.max`-over-batch watermark can skip a message claimed by a *crashed previous run* — the client can't know it exists.
  - **Design decision (deviation from the plan's design note):** instead of client-side non-finalized tracking (which cannot see crashed-run claims), the **server** computes the true per-reader watermark: `min(seq of messages addressed to the reader that are pending or claimed-by-them, seq > since) - 1`, returned as `watermark` on every pickup response (spec §5.4/§6.2). Clients resume from `watermark`. This is the only way to be correct across crashes; the CLI keeps the in-process `seen` set purely for re-print suppression.
  - `readerWatermark(board, reader, since, now)` in db.ts: messages claimed by *another* reader (role/broadcast race) or terminal or not-their-mail never block.
  - CLI `cmdRead` persists `data.watermark`; falls back to old behavior if absent (older server).
  - Tests: 4 server watermark tests (blocking semantics, role race, not-my-mail, finalization advances) + CLI end-to-end #12 regression (claim msg_5 → crash → msg_6 arrives and is finalized → lease expiry → msg_5 redelivered, attempts=2). **37/37 green.**
- **Next:** T2 broadcast fan-out (deliveries table).

## 2026-09-30 — T2 done

- **T2 (broadcast fan-out):**
  - New `deliveries` table `(message_id, reader_id, state, claim_agent, lease_expires_at, attempts, ...)` — per-reader copies.
  - On broadcast post: delivery rows for **all current board members** (online or offline; sender included; membership is the criterion). **Zero members → message dead-lettered immediately** (documented in spec — a broadcast nobody subscribes to can never be delivered). Late joiners get nothing (spec §3.2).
  - Pickup claims the caller's **delivery** row (not the message row) for broadcasts; ack operates on the delivery (claim-agent gated); retries/leases/attempts are per-reader independent (max 3 each).
  - Message row state = aggregate: `pending` while any delivery active → `done` when all terminal (any done wins) → `dead` (all failed) → `expired` (all expired); recomputed on every delivery change + sweep.
  - Sweep: delivery-level lease expiry (per-reader) + broadcast ttl expiry expires all deliveries at once.
  - Watermark: broadcast clause now uses the reader's own delivery state (my pending/claimed delivery blocks; another reader's never does).
  - Responses: pickup carries `delivery` (mine); observability carries `deliveries` (all).
  - Tests: 9 new server tests (independent receipt online+offline, per-reader retry independence, aggregate transitions, zero-member dead, late joiners, ack conflicts, per-reader lease redelivery, broadcast ttl expiry, watermark semantics) + 1 CLI end-to-end fan-out test (two agents receive + finalize their own copies). **47/47 green.**
- **Next:** T3 question deadlines.

## 2026-09-30 — T3 done

- **T3 (question deadlines):**
  - `deadline` on `question` messages (ISO 8601 UTC, server-validated; only questions may carry it → 422 otherwise). Stored as ms; exposed as ISO in the API.
  - Sweep: `type='question'` pending/claimed past deadline → `expired` (same terminal path as TTL; broadcasts expire all deliveries at once).
  - Late responses: on insert, a `response` whose `replyTo` targets an expired (or past-deadline) question gets `late: true`; still accepted. Computed at insert time (no sweep dependency).
  - Lightweight column migration (`ensureColumn`) for pre-v0.2 DBs — `CREATE TABLE IF NOT EXISTS` doesn't add columns.
  - CLI: `ab send --type question --deadline <iso>` (+ `--deadline` in help).
  - Tests: 6 server (delivered before deadline, past-deadline expiry, late + on-time responses, validation, broadcast deadline) + 1 CLI. **54/54 green.**
- **Next:** T4 VS Code extension.

## 2026-09-30 — T4 done

- **T4 (VS Code extension):** `vscode-ext/` — second provider.
  - Webview panel (Open board): presence + board messages, live via SSE (`watchBoard` — fetch-stream SSE reader in the host, webview is a dumb renderer).
  - Commands: Open board · Join board (heartbeat with `--board` registers membership — no config file needed) · Send note (broadcast) · Set workspace token.
  - **Token via SecretStorage** (`context.secrets`), never in settings or the webview. Settings: server/agentId/board/heartbeatInterval only.
  - Heartbeat: timer runs `ab heartbeat --once` with identity via env vars — CLI is the client, extension is a thin shell (no protocol code). Requires `ab` on PATH (`npm i -g @agentboard/cli`); activation warns if missing.
  - **CLI support work:** `loadConfig` now allows env-only identity (AB_SERVER/AB_TOKEN/AB_AGENT_ID without `.agentboard.json`) — the extension runs `ab` without touching the repo's config file; `ab --version` added (also needed by the extension's probe; part of T5 anyway).
  - Tests: 4 (fetchBoardState happy + error, watchBoard emits + closes, formatters) against a live in-process server. **58/58 green.**
  - Dev note: plan said "bundled ab" — implemented as PATH-installed `ab` (the npm package from T5). Vendoring the CLI into the extension would add a build step with no benefit; documented in the extension README.
- **Next:** T5 npm packaging.

## 2026-09-30 — T5 + T6 done

- **T5 (npm packaging):** `@agentboard/cli` name verified available (fallback `agentboard-cli` not needed).
  - cli/package.json: `private: false`, version 0.2.0, repository/license/keywords, `prepublishOnly: npm test`, `files: bin,src`.
  - `cli/README.md` (npm-facing) + `ab --version` (prints package version; needed by the extension probe).
  - `.github/workflows/release.yml`: on tag `v*` → build+test, `npm publish --workspace cli --access public` (NPM_TOKEN secret), GitHub Release with generated notes.
  - Verified: `npm pack` → tarball → clean `--prefix` install → `ab --version` = 0.2.0, `--help` works. Actual `npm i -g` from the registry happens on the first tag (needs NPM_TOKEN; Producer/CI).
- **T6 (CI Docker):** ci.yml gains a `docker` job — build the server image on every PR/push (catches Dockerfile drift; verified locally, image builds) and, on tag `v*`, build+push `ghcr.io/kennymudiaga/agent-board:<tag>` + `:latest` (GITHUB_TOKEN login).
- Versions bumped: root/server/cli/vscode-ext all 0.2.0 (matches spec v0.2.0).
- **58/58 tests green.**
- **Next:** T7 dead-letter management (stretch — T1–T6 landed early).

## 2026-09-30 — T7 done

- **T7 (dead-letter management, stretch):**
  - Server: `POST /v1/messages/{id}/requeue` (dead → pending, attempts reset; broadcasts reset every delivery) + `DELETE /v1/messages/{id}` (message + deliveries). Both **sender-only** → 403 for others (spec §5.7; new `403 forbidden` + `409 state_conflict` codes in §8).
  - CLI: `ab dead --board` · `ab requeue --id` · `ab purge --id`.
  - Caught in testing: a broadcast's sender is a member too, so "all deliveries dead" includes the sender's copy — the aggregate test now kills it explicitly (documented behavior, not a bug).
  - Tests: 4 server + 1 CLI end-to-end (fail→dead→list→requeue→redeliver→purge, non-sender denied). **63/63 green.**
- **Next:** final verification (build, suite, docker, sprint-2 demo end-to-end), handoff, PR.

## 2026-09-30 — Final verification + handoff

- Build clean, **63/63 tests green**, Docker image builds.
- **Sprint-2 acceptance demo executed** against a fresh containerized server:
  - 3 agents joined `sprint-8` (producer-1, qa-1, reviewer-1 — reviewer standing in for the VS Code extension, which shares the same CLI/API backend).
  - **Fan-out (step 5):** producer broadcast note → deliveries created for qa-1 AND reviewer-1; both long-poll loops received their own copy.
  - **Deadline (step 6):** question with 2-min deadline to `role:qa` → qa-1 picked it up and answered before expiry (`late: false`).
  - **Crash test (step 7):** qa-1 claimed a request (cursor watermark stayed behind), process killed; reviewer-1 finalized a later message; lease expired (patched in-container); qa-1 restarted and **received the redelivered request** (attempts 2), acked done. No paste between steps.
  - Demo caveat: the VS Code *panel* leg was simulated with the CLI (identical backend); the extension's own logic is covered by its 4 unit tests.
- Handoff written: `docs/sprint-2/done.md`, README + PROJECT_BRIEF §7/§8 updated.
- **Next:** push, PR referencing issues #12–#19.

## 2026-09-30 — QA review → BLOCKED (#21) → remediation round

QA sign-off (`docs/qa/sprint-2-signoff.md`) blocked PR #20 on **#21 (major)** — VS Code panel SSE liveness — and recommended 4 minor fixes (#22–#25). All five fixed, regression-tested:

| Issue | Severity | Fix |
|---|---|---|
| #21 panel goes stale on SSE drop | major | `watchBoard` now **reconnects with exponential backoff** (1s→2s→…cap 30s; resets on connect) and emits `connect` events so the host refetches; `close()` aborts the in-flight stream (also fixed a hang I introduced while rewriting). Heartbeat timer cleared on panel dispose. Regression test: flaky SSE endpoint that drops the first connection → reconnect + agent event received. |
| #22 aggregate 'expired' overrides 'done' | minor | Sweep now recomputes aggregates for **all** broadcasts (not just pending/claimed) → "any done wins" holds after TTL expiry. Regression test: done + expired deliveries → message `done`. |
| #23 zero-member requeue silent no-op | minor | `requeue` of a broadcast with zero deliveries → **409 `state_conflict`** (honest — nothing to redeliver to); documented in spec §5.7. Regression test. |
| #24 lax deadline validation | minor | Strict ISO 8601 **with explicit timezone** on server (`isValidIso8601Utc`) and CLI: `"March 5, 2025"` and timezone-less strings → 422; `Z`/offset forms accepted. Spec §3.1 clarified. Regression tests (server + CLI). |
| #25 env-only token written to disk | minor | `loadConfig` tracks `fromEnv` + `tokenFromEnv`; `saveConfig` persists **cursors only** for pure env runs and **never writes a token that came from `AB_TOKEN`**. Regression test: two env-only `read` runs, config file has no `token` key. |

- Also fixed the misleading `data.watermark ?? cursor` fallback comment (QA non-blocking observation).
- **Suite: 68/68 green** (was 63). Build clean.
- **Next:** re-run CI on the updated branch, re-submit for QA sign-off.

## 2026-09-30 — QA re-review: PASS + non-blocking #26 fixed

- QA re-review (`docs/qa/sprint-2-signoff.md` final): **✅ PASS** — all five repros verified live, #21 verified with a real server kill/restart. One non-blocking open item filed as **#26**.
- **#26 (minor):** my #25 `tokenFromEnv` guard was broader than intended — with `AB_TOKEN` present in the environment, `saveConfig` *erased* a deliberately-stored token from an existing `.agentboard.json`.
- **Fix:** `loadConfig` now tracks `fileToken` (the raw stored token). `saveConfig` persists `fileToken ?? (tokenFromEnv ? undefined : token)` — a stored token is **never erased** (even when env is set; the env token itself is still never written), and env-only runs still write nothing. Both invariants hold:
  - #25: env-only → no token on disk.
  - #26: existing config + AB_TOKEN set → stored token survives.
- Regression test for #26 added (init with `--token`, read while AB_TOKEN set → token preserved); live repro of QA's exact steps passes. **Suite: 69/69 green.**