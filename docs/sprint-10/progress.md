# Sprint 10 — Progress (Identity, CLI Hardening, Encryption & A2A Events)

> Updated: 2026-10-05. Plan: `docs/sprint-10/plan.md`.

## Status

| Task | State | Evidence |
|---|---|---|
| T1 — session identity sidecar (#109) | **PR ready** | `ab session` + `AB_SESSION_FILE` sidecar; live-proven; tests green (below) |
| T2 — CLI hardening bundle (#110 + follow-ups) | **PR ready** | `--exec` split guard + docs, `AB_WAKE_RESOLVE_MS` NaN coercion, `--log` ENOENT friendly error; hermetic tests (below) |
| T3 — at-rest encryption (spec §10.7) | implemented (dev-361f18) | PR #112, AES-256-GCM behind `AB_ENCRYPTION_KEY`; QA dispatch pending |
| T4 — A2A `tasks/query` + SSE (docs/a2a.md) | in progress (dev-361f18) | worker standing down from T1/T2; implementing |
| T5 — release v0.5.0 | planned | after T1–T4 + QA; human approval before publish |

## Verification record

- **Kickoff (producer-1, 2026-10-05):** wake-up feature live-tested on
  `sprint-10` (5 probes + organic mail: agent/role addressing fire, role
  filter + wake-loop guard silent, never-claims — all messages stayed
  `pending` until producer pickup, `attempts:1`). Dogfood findings filed:
  #109 (bootstrap `as <role>` clobbers workspace identity — reproduced at
  kickoff, dev-1 contributed via board note) and #110 (win32 `--exec`
  multi-word quoting gap). Sprint-9 non-blocking follow-ups carried in
  (T2): `AB_WAKE_RESOLVE_MS` NaN, `--log` ENOENT. Plan approved by human;
  T1 + T2 dispatched 2026-10-05.
- **T1+T2 (dev-1, 2026-10-05):** delivered together (one branch, two
  commits — the tasks overlap files and were dispatched together).
  **T1 (#109):** new `ab session <role> [--board] [--roles] [--delete]`
  writes a per-session sidecar `.agentboard.<id>.json` (copies
  server/token, overrides agentId/roles); `cli/src/config.js` gains the
  sidecar layer (`AB_SESSION_FILE`, precedence env > session > local >
  global, `source: session`, fresh cursors like env identities #67); the
  workspace `.agentboard.json` identity is never written (saveConfig
  persists `fileValues` only). Bootstrap templates (opencode/claude/vscode
  `/ab` commands + AGENTS.md) rewritten: `as <role>` on an existing
  identity now creates a session identity instead of re-initing (AB_* env
  overrides documented as fallback); quickstart §3 shows the two-session
  flow. **Live-proven on this machine:** producer-configured checkout →
  `ab session dev --board sprint-10` → `AB_SESSION_FILE=...` → `whoami`
  `dev-1 [dev] source: session`, heartbeat online, directory
  `dev-1 [online]`; `.agentboard.json` byte-unchanged (`producer-1`),
  plain `whoami` still `source: local`. **T2 (#110):** `ab watch --exec`
  split guard (`execSplitWarnings`: trailing positionals / bare REPL
  binaries warn to stderr, never fail) + help text + `docs/wake-on-mail.md`
  §3.2 win32 quoting guidance (single token / `.cmd` wrapper);
  `wakeResolveMs` coerces `AB_WAKE_RESOLVE_MS` (NaN/invalid → default,
  sub-second clamped) in `wake-core.js` + plugin; `--log` missing parent
  dir → friendly CliError instead of raw ENOENT (both win32 redirect and
  posix fd paths). Evidence: suite **198/199** (191 baseline + 8 new
  hermetic tests: 3 session-sidecar, 1 `--log` ENOENT, 2 exec-guard unit +
  1 CLI warning integration, 1 `wakeResolveMs`); the 1 failure (archive T5
  timeout) is pre-existing on this machine — repro'd on unmodified
  origin/main. `ab setup --force` regenerated 4 files; `ab setup --check`
  clean. PR: https://github.com/kennymudiaga/agent-board/pull/114 (refs #109, #110).