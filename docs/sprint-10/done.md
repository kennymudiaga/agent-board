# Sprint 10 — Done (Identity, CLI Hardening, Encryption & A2A Events)

> Sprint closed: 2026-10-24. Plan: `docs/sprint-10/plan.md`.

## Shipped — v0.5.0 LIVE

- **T1 session identity sidecar** (#109, PR #114, merge `62da63ce`) — `ab session` / `AB_SESSION_FILE` sidecar (`.agentboard.<id>.json`) with precedence env > session > local > global; `/ab join <board> as <role>` no longer rewrites the workspace identity on a shared checkout; `.agentboard.json` byte-unchanged on this repo; 8 hermetic tests; **QA PASS** (qa-1 at `d69b644`). 198/199.
- **T2 CLI hardening bundle** (#110 + sprint-9 follow-ups, same PR #114) — win32 `ab watch --exec` split guard + docs, `AB_WAKE_RESOLVE_MS` NaN coercion, friendly `--log` missing-parent-dir error; hermetic tests. #110 closed.
- **T3 at-rest encryption** (#111, PR #112, merge `3bec8895`) — field-level **AES-256-GCM** behind `AB_ENCRYPTION_KEY` (`abenc1:` envelope, scrypt key, payload-cells-only boundary, no-key pass-through identical); spike rejected SQLCipher (no win32 build); `docs/encryption-at-rest.md` + spec §10.7; 5 hermetic tests; **QA APPROVE** (qa-1 at `c020049`, independent security review). #111 closed.
- **T4 A2A `tasks/query` + SSE** (#115, PR #115, merge `b22c1bc`) — `tasks/query` filters + `GET /a2a/:agentId/events` SSE (`created/updated/canceled`), per-agent-token auth, emit-time workspace scoping; cross-workspace negative test; demo client + `docs/a2a.md`; **QA PASS** (qa-1 at `7d24227`).
- **T5 release v0.5.0** (#118, merge `6d76192`, tag `v0.5.0` @ `624abec`; Release run [`40043728943`](https://github.com/kennymudiaga/agent-board/actions/runs/40043728943) all green) — version bumps (root+cli+server+mcp+vscode-ext), `spec.md` header v0.5.0, regenerated agent files (`setup --check` clean), **#116 CI fix** (main-push GHCR publish removed; `release.yml` sole publisher). **QA PASS** (qa-t5 at `27bdaa8`: 207/207 tests, build clean, 20-file diff in scope). Main CI green (`40043592697`). Published **`@agent_board/cli@0.5.0` + `@agent_board/mcp@0.5.0`** via OIDC with provenance attestations; **GHCR `v0.5.0`+`latest`**; GitHub Release with notes. Clean-machine verify: `npx @agent_board/cli@0.5.0 --version` → `ab 0.5.0`.

Issues **#109, #110, #111, #116** closed (all QA-signed). Suite **207/207** + CI 3/3.

## Dogfood record

- **The board was down for six days.** The local server (last DB write 2026-10-05) had died after the last sprint-10 coordination burst, so no heartbeat/read/send could happen and T5 never moved. Restarted it (`node server/dist/index.js`, `AB_TOKEN=dogfood-token`) and re-dispatched.
- **An OpenCode crash killed both spawned workers mid-turn.** T5's work was uncommitted in its worktree; the producer preserved it in a WIP commit (`920e928`) before resuming — no work lost. Lesson: commit checkpoints early on long tool runs.
- **Stale spawn default model (#119).** `SPAWN_DEFAULT_MODEL` (`opencode-go/deepseek-v4-flash`) no longer exists at the provider; two spawns exited instantly with a 0-byte `--log`. Workaround: `AB_SPAWN_MODEL=opencode-go/deepseek-v4.1-flash`. Issue filed with a fix proposal (validate the model pre-flight + surface instant exits).
- **Headless external-directory wall (again).** A resume worker pointed at the previous worker's worktree stalled on the `external_directory` permission prompt. Fix: keep each worker inside its own worktree — the preserved commit was cherry-picked into the new worktree instead.
- **Overlapping producer sessions (#113) struck again.** The QA wake fired every producer session; one merged PR #118 before this session could, and another wrote a duplicated/corrupted `progress.md` working copy (discarded; one clean ledger commit pushed). Still open — warrants the one-session-per-identity guidance.
- **T6/#117 wake-echo fix did not land** — it was dispatched to `dev-echo`, which went offline; a replacement worker never started. Deferred to sprint 11 with the root-cause analysis preserved on #117.
- **Worktrees cleaned** at close (all `Temp/ab-worktrees/*` and `Temp/opencode/ab-worktrees/*` removed; merged `spawn/*` branches deleted).

## Next (sprint 11 candidates)

- **#117 wake echo** — session-scoped injection (root cause + fix design already on the issue; sibling of #113).
- **#113 one-session-per-identity** — persona/SKILL guidance + optional `ab read` responded-marker; the duplicate-wake class is the biggest remaining dogfood pain.
- **#119 `ab spawn` default model** — validate/resolve the model; make instant exits visible.
- Release hygiene: **revoke the bootstrap npm GAT** (human ops; the GitHub secret is already deleted).
- `sleeping` presence (protocol change, deferred in #102) · federation (v1).
