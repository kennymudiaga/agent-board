# Sprint 2 — Done

> Handoff from the dev team. Sprint goal: **one board, two tools, three agents** — an OpenCode producer and QA agent plus a VS Code reviewer collaborate on a single board, with broadcast fan-out, deadline-bounded questions, and zero message loss under crash. Achieved.

## What landed (branch `feature/sprint-2`)

| Task | Deliverable | Status |
|---|---|---|
| T1 | **True cursor watermark** (#12): server-computed per-reader `watermark` on every pickup response — `min(seq of messages addressed to the reader that are pending or claimed-by-them) − 1`. Clients resume from `watermark`, never `cursor`. A crashed run's claimed-but-unacked messages block it — no client heuristic can skip a redelivery. CLI persists the server watermark. | ✅ |
| T2 | **Broadcast fan-out**: `deliveries` table (per-reader copies). On post: one delivery per current board member (online or offline; sender included; zero members → immediate dead-letter). Claims/acks/leases/attempts per delivery, independent retries (max 3 each). Message state = aggregate (pending → done/dead/expired when all terminal). Pickup responses carry `delivery` (mine), observability carries `deliveries` (all). Late joiners get nothing. | ✅ |
| T3 | **Question deadlines**: `deadline` (ISO 8601 UTC, question-only, server-validated) + `late` flag on responses to expired questions (accepted, flagged). Sweep expires past-deadline questions (messages + broadcast deliveries). CLI `--deadline`. Column migration for pre-v0.2 DBs. | ✅ |
| T4 | **VS Code extension** (`vscode-ext/`): webview board panel (presence + messages, live via SSE), commands (Open board / Join board / Send note / Set token), background heartbeat via `ab` on a timer. **Token in SecretStorage**, never settings/webview. CLI gained env-only identity (AB_SERVER/AB_TOKEN/AB_AGENT_ID without config file) so the extension drives `ab` without touching repo config. | ✅ |
| T5 | **npm packaging**: `@agent_board/cli` (name verified free) — `files`, license, repo metadata, `prepublishOnly` tests, `ab --version`. Verified via `npm pack` + clean-prefix install (0.2.0). Release workflow: tag `v*` → build/test → `npm publish` + GitHub Release with generated notes. | ✅ |
| T6 | **CI Docker**: docker job builds the server image on every PR/push (drift check; verified locally) and pushes `ghcr.io/kennymudiaga/agent-board:<tag>` + `:latest` on tags. | ✅ |
| T7 | **Dead-letter management** (stretch): `POST /v1/messages/{id}/requeue` + `DELETE /v1/messages/{id}` (sender-only, spec §5.7; new `403 forbidden`/`409 state_conflict` codes) · CLI `ab dead` / `ab requeue` / `ab purge`. | ✅ |

Spec bumped to **v0.2.0** (§3.1 deadline/late, §3.2 fan-out, §3.3 question deadlines, §5.4 watermark + delivery detail, §5.7 dead-letter mgmt, §6.1 aggregates + per-reader retries, §6.2 server watermark, §8 403/state_conflict, §10 resolutions recorded).

## Verification

- **63 tests green** (was 32 at sprint-1 close): 42 server lifecycle (incl. watermark suite, fan-out suite, deadline suite, dead-letter suite) + 5 dashboard + 4 vscode-ext + 12 CLI end-to-end. Build clean.
- **Docker**: image builds; full sprint-2 demo executed against a fresh container:
  1. three agents joined `sprint-8` (producer-1 / qa-1 / reviewer-1)
  2. broadcast note → **qa-1 AND reviewer-1 both received their own copy** (fan-out proof)
  3. question with 2-min deadline → qa-1 answered before expiry (`late: false`)
  4. **crash test**: qa-1 claimed a request, process killed; reviewer-1 finalized a later message; qa-1 restarted → **received the redelivered request after lease expiry** (attempts 2)
  5. no human paste between steps 2–4

## Decisions & deviations (in `progress.md`)

1. One branch + one PR for the sprint (per-task PRs folded; same model as sprint 1, accepted by Producer).
2. **T1 deviation from the plan's design note:** client-side non-finalized tracking cannot see crashed-run claims — the plan's own regression test requires it. Implemented **server-computed watermark** instead (authoritative per-reader state), returned on pickup. The CLI keeps the in-process `seen` set for re-print suppression only.
3. Broadcast sender receives its own delivery (documented in spec §3.2) — caught by tests (aggregate dead requires sender's delivery dead too).
4. `403 forbidden` added to the error table (valid identity, wrong sender) — the plan asked for sender-gated requeue/purge and 401/409 don't fit.
5. "Bundled ab" (T4) = PATH-installed `ab` (the T5 npm package); vendoring would add a build step with no benefit. Documented in extension README.
6. Zero-member broadcast → immediate `dead` (spec §3.2) — nothing subscribes, nothing can ever deliver.

## Follow-ups for sprint 3 (suggested)

- Per-agent credentials vs shared token (brief §10.2), git archive, federation/A2A bridge, encryption, OpenDevin client.
- Broadcast per-reader read-state instead of copies (spec §10.4 note).
- Dashboard: render `deliveries` per reader (data already flows); deadline countdowns.
- `ab` publish + ghcr push land on the first tag (needs NPM_TOKEN; Producer/CI).
- VS Code extension: sidebar view + automated UI tests (xvfb) — logic is tested; host wiring is not.

## Open items for the Producer

- Merge the sprint-2 PR (regular merge), close issues #12–#19.
- QA sign-off on the sprint-2 demo (fan-out + deadline + crash test), per the plan's DoD.
- First tag `v0.2.0` triggers npm publish + ghcr push + GitHub Release (NPM_TOKEN secret required).

## QA remediation (2026-09-30)

QA review (`docs/qa/sprint-2-signoff.md`) initially **BLOCKED** on #21 (VS Code panel SSE liveness). All findings fixed on `feature/sprint-2`, regression-tested:

1. **#21 (major)** — `watchBoard` reconnects with exponential backoff + `connect` events; `close()` aborts the stream; heartbeat timer cleared on panel dispose. Regression test with a flaky SSE endpoint.
2. **#22 (minor)** — sweep recomputes aggregates for all broadcasts → "any done wins" after TTL expiry. Regression test.
3. **#23 (minor)** — requeueing a zero-delivery broadcast → 409 `state_conflict` (spec §5.7). Regression test.
4. **#24 (minor)** — strict ISO 8601-with-timezone deadline validation (server + CLI); spec §3.1 clarified. Regression tests.
5. **#25 (minor)** — env-provided tokens are never written to disk; pure env runs persist cursors only. Regression test.

**Suite after remediation: 68/68 green** (was 63). Build clean; CI re-run on the branch pending. Ready for QA re-review.