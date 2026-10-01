# Sprint 4 — QA Sign-off (chunk 1)

> Sign-off for **T3 — A2A relay on the reference server** (the headline task).
> Plan: `docs/sprint-4/plan.md`. Verdict: **PASS**.

## Request

- Board request: `sprint-4` #32 (`spring4-t3-qa-signoff`) → `role:qa`
- Under review: PR #49 (`feat/a2a-relay`, head `c396946`), merged as `308f8ca`

## QA evidence (worker `qa-4a0b27`, spawned via `ab spawn`)

- **Scope check:** PR delta = 6 files, +741 lines, all A2A — `server/src/a2a.ts`
  (new), `server/src/app.ts` (+5 mount), `server/src/db.ts` (+12),
  `server/test/a2a.test.ts` (+239, 7 tests), `docs/a2a.md` +
  `docs/a2a-demo/demo-client.mjs`. Clean, self-contained; no unrelated changes.
- **Tests at PR head (scratch clone):** `npm test` → **99/99** (a2a 7, dashboard 6,
  lifecycle 49, cli 21, mcp e2e 3, mcp tools 8, vscode board 5). The brief's
  "103/103" includes 4 VS Code Test-Runner tests not collected by `npm test`
  — methodology note, not a discrepancy. First run showed 11 CLI-test
  failures from the QA session's own ambient `AB_AGENT_ID` leaking into
  `runCli` children (`cli.test.js` overrides `AB_SERVER`/`AB_TOKEN` but not
  `AB_AGENT_ID`); re-run with `AB_*` cleared: 99/99. Pre-existing harness
  quirk, untouched by the PR — flagged as a follow-up hygiene item.
- **Code review vs `docs/a2a.md` + `docs/a2a-spike.md` + spec §5.9:** thread→task
  mapping correct (`pending`→`submitted`, `claimed`→`working`, `done`→
  `completed` with the first direct response as artifact, none → completed
  with no artifacts, `dead`→`failed` dead-lettered); auth per §5.9
  (agent-token only, no admin escalation).
- **Live demo:** originally executed by dev-3 (client discovered the card,
  `tasks/send` → `role:qa` on `sprint-8`, worker answered via `ab`, client
  polled `completed`). QA re-run attempts on :8090 were hampered by
  localhost process fragility (orphaned demo servers from a killed spawn
  holding sqlite locks; processes dying between steps) — environmental, not
  a PR defect; the committed demo client (`docs/a2a-demo/demo-client.mjs`)
  reproduces the flow.

## Verdict

**PASS** — T3 merged as `308f8ca` (regular merge), CI 3/3 green on the PR head.

## Follow-ups

- CLI test harness hygiene: `cli/test/cli.test.js` should clear ambient
  `AB_AGENT_ID`/`AB_ROLES` in `runCli` children (found by QA; pre-existing).
- Consider documenting the "full workspace suite" count methodology (npm test
  vs VS Code Test Runner) in `docs/` to avoid 99-vs-103 confusion.