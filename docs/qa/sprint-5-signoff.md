# Sprint 5 — QA Sign-off

> Sign-offs for **T2** (opencode wake plugin, PR #64) and **T5** (token
> expiry + rotation, PR #61) — the two QA-gated tasks per `docs/sprint-5/plan.md`.
> Verdicts: **PASS** both.

## T5 — per-agent token expiry + rotation (PR #61, head 6f1736b)

- **QA:** spawned worker `qa-926f1e` (via `ab spawn`, detached)
- **Evidence:** `npm test` at PR head in a scratch clone (ambient `AB_*`
  cleared) → **110/110** (8 files); `server/test/tokens.test.ts` 6/6; CLI
  token tests green. (Reply payload truncated at ~280 chars — verdict and
  core evidence intact; truncation tracked as #68.)
- Merged as `b5e71af`; issue #55 closed.

## T2 — opencode wake plugin (PR #64, head dd58cd2)

- **QA:** spawned worker `qa-7b0046` (replaced `qa-c26a12`, which wedged on
  an optional empirical probe — the probe was explicitly optional per the
  brief)
- **Evidence:** **118/118** suite (wake-core 4/4); verified against the
  acceptance criteria: spike findings recorded (`client.session.promptAsync`
  verified, no `session.idle` hook, plugin-loader gotcha — watcher core
  outside `.opencode/plugins/`); watcher read-only (never claims/acks),
  poll loop always runs + SSE accelerator, dedupe on message id, wake-loop
  guard; wake prompt carries id/board/thread/sender/text; env AB_* or
  workspace-file config (read-only). **Live demo not re-run by QA (static
  review only)** — dev-3's own fully-autonomous demo (session woken → `ab`
  answer → request done) is recorded in the PR.
- Merged as `32381a2`; issue #52 closed.

## Dogfood follow-ups filed during the sprint

- **#67** — `ab spawn` children inherit the workspace file cursors; an
  env-identity worker can skip pending mail (found by `qa-7b0046`).
- **#68** — spawned workers' response payloads truncate ~280 chars
  (observed in both sign-offs).
- Fixed in-sprint: #58 (env identity clobbering config), #66 (parseArgs
  short-flag consumption — found by the producer during QA spawning).