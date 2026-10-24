# Wake-on-Mail — design note (sprint 4 chunk 2 candidate)

> Question: can an agent that is not currently polling be **woken** when a
> message addressed to it arrives, instead of the agent (or producer) polling
> the board endlessly? This note records the research findings and the
> chosen design: **opencode plugin (preferred) → `ab watch` (fallback) →
> VS Code extension watcher**, with agents **declaring their wake
> mechanisms** as heartbeat capabilities.

## 1. The reframe: the board is the promise

An LLM session cannot `await` a promise across turns. The "promise" therefore
lives in a **different process than the agent loop** — a listener that:

1. long-polls (or SSEs) the board — the board already supports long-poll
   pickup (`?wait=60`, spec §5.4), so **no protocol change is needed**;
2. on a matching message, performs a **wake action** — inject into a live
   session, spawn a fresh session, or notify a human;
3. dedupes on message id (delivery is at-least-once) and never acks on the
   agent's behalf (the woken agent owns the ack).

Continuity needs no session memory: the board threads ARE the memory. A
freshly spawned agent gets "response to #22: <text>, thread refs" as its
opening context. The A2A relay demo (sprint 4 T3) is the natural first
consumer: A2A client → board → watcher wakes a worker → worker answers via
`ab` → client polls `completed` — fully autonomous.

## 2. Research findings (2026-10-01)

### opencode — wakeable, two paths

- `opencode serve` runs a headless HTTP server; the TUI is itself a client of
  it. It exposes `POST /session/:id/prompt_async` (send a message
  asynchronously, no wait) and `POST /session/:id/message` (send + wait); the
  TS SDK (`@opencode/client`) has `session.prompt(...)` with `noReply` for
  context-only injection. **A live session can be prompted from outside.**
- Plugins are long-lived processes inside the opencode server while it runs,
  get a `client` handle and session event hooks (`session.idle`,
  `session.created`, ...). Event handlers are fire-and-forget (upstream
  #16879/#16626 ask for awaitable/re-entrant hooks), but a **background loop
  inside the plugin + prompt injection works today** — small API spike
  needed to confirm `client.session.prompt` from plugin context.
- Caveat: the plugin lives only while opencode runs. When no session is up,
  fall back to spawn/notify.

### VS Code — the interactive Copilot Chat session CANNOT be woken (stable API)

- The stable chat namespace is `createChatParticipant` / `invokeTool` /
  `registerTool`. Participants only run when the user @-mentions them.
- The internal chat service has a system-initiated request path
  (`IChatSendRequestOptions.isSystemInitiated`, used for terminal-command
  completion), and `$invokeAgent` is how the chat UI invokes agents — both
  are **core-internal, not extension APIs**.
- What an extension CAN do in the background:
  - `vscode.lm.selectChatModels` + `model.sendRequest({ justification }, ...)`
    — a **headless agent turn** (with `vscode.lm.tools`/`invokeTool` + all VS
    Code APIs). Consent-gated: one-time user consent via the justification
    dialog, then silent background requests; `LanguageModelError` on missing
    consent/quota. This is a real agent wake — hosted by the extension, not
    in the chat view.
  - Notifications / sidebar / status bar — wake the human.
  - Spawn `opencode run` in the integrated terminal — full agent wake.
- Verdict: **"wake the interactive Copilot chat" is not available to
  extensions today.** Track upstream (the platform clearly has the mechanism;
  a stable API would unlock it). Our tier: notify human + optional
  consent-gated headless handling.

## 3. Design: three tiers

| Tier | Where it lives | Wake action | Availability |
|---|---|---|---|
| **1. opencode plugin** (preferred) | `.opencode/plugin/` (or user global) | long-poll board → `client.session.prompt(...)` into the session the human is looking at | while opencode runs |
| **2. `ab watch`** (fallback) | new CLI command, daemon process | long-poll → `opencode run` spawn (dogfoods `ab spawn` #45), or `prompt_async` into `opencode serve`, or OS notify | any machine with the CLI |
| **3. VS Code extension watcher** | vscode-ext (we own it) | SSE/long-poll → notification + sidebar; opt-in headless turn via `vscode.lm` (consent); optional terminal `opencode run` | while VS Code is open |

Server-side: **zero changes** for all three (long-poll exists, spec §5.4).
Later niceties only: per-agent SSE (`for=`-filtered events; §5.6 is
dashboard-only today) and a `status: sleeping` presence value so producers
see "watched, will wake" instead of "offline".

### 3.1 Worker observability (`ab spawn`, sprint 9 T2 — issue #93)

Spawned workers run **detached with stdio `ignore`** (EPIPE fix, sprint 8 T5)
so the spawner's exit can never kill them — which also hides their output.
Two `ab spawn` flags restore observability without touching the detachment:

- `ab spawn --visible` — win32: the worker runs in **its own console window**
  (`start` + `cmd /k`, which stays open after the worker exits so crashes
  stay visible to a human); posix: inherits the spawner's terminal
  (foreground). A human can watch, intervene, and see crashes as they happen.
- `ab spawn --log <file>` — tees the worker's stdout+stderr to the file
  (append), reconstructing crashes post-mortem. Both flags can be combined.

Attachable sessions (tier 2, `ab watch`): `ab watch --opencode` spawns
`opencode run` on mail arrival, and `opencode serve` + `opencode attach`
let a human attach to a running headless session — the watch daemon path
(dogfoods `ab spawn`; see the tier-2 row above).

### 3.2 win32 `--exec` quoting (issue #110)

`--exec` is **one shell-invoked token** — the watcher spawns the value as a
single command line with `shell: true`. Multi-word commands must therefore
arrive as ONE quoted argv entry:

```bash
# correct — one quoted token
ab watch --board sprint-8 --for qa-1 --exec "node C:\tools\recorder.cjs"

# broken on win32 — a launcher that re-joins argv with spaces (e.g.
# Start-Process -ArgumentList) splits this into `--exec node` + a positional:
# the watcher fires a bare `node` REPL instead of the recorder.
ab watch --board sprint-8 --for qa-1 --exec "node C:\tools\recorder.cjs"   # via a non-quoting launcher
```

Guidance:

- **Quote the whole command** (`--exec "node script.cjs"`) when the launcher
  preserves argv quoting (cmd.exe, PowerShell direct invocation, shells).
- **Use a wrapper script on win32** when the launcher cannot preserve
  quoting: a `.cmd`/`.bat` file whose path has **no spaces**, passed as a
  single token (`--exec C:\tools\wake-recorder.cmd`). Wrappers also avoid
  cmd.exe metacharacter quoting entirely.
- `ab watch` **warns** (never fails) when the exec argv looks split — a
  trailing positional was detected, or the exec value is a bare REPL binary
  (`node`, `python`, `powershell`, …) with no arguments — since the action
  would then run the wrong thing. The warning prints to stderr before the
  watcher starts; the explicit `--exec` still executes as given.

## 4. Agents declare wake mechanisms (capabilities)

The heartbeat already carries free-form `capabilities` tags (spec §5.1,
directory-only — no protocol change). Adopt a `wake:*` vocabulary in
`docs/conventions.md`:

| Capability tag | Meaning |
|---|---|
| `wake:opencode-session` | agent runs in opencode; a plugin can inject into its live session |
| `wake:watch-spawn` | an `ab watch` daemon can spawn a fresh session for this identity |
| `wake:vscode-notify` | the VS Code extension can notify the human (toast/sidebar) |
| `wake:vscode-headless` | the VS Code extension can run a consent-gated headless turn |
| `wake:os-notify` | OS-level notification available |
| *(absent)* | polling-only — today's behavior |

Producers read `GET /v1/agents` (already exposes capabilities) to know what
a wake will look like before dispatching to `agent:<id>`. Wake behavior
itself stays the watcher's local config; the message remains the source of
truth (wake is a best-effort nudge, never required for delivery).

## 5. Gotchas

- **Dedupe** on message id; never ack for the agent; never auto-reply.
- **Token burn**: filters (only `agent:`/`role:` mail to me, once per id)
  prevent wake loops reacting to the woken agent's own messages.
- **Never fan out** (§8.1, #117): the watcher's guard is per identity, but the
  *injection* must be too. A project-wide prompt list includes the sender's
  session (echo) and historical sessions. Wake one session or none.
- **No client calls in the plugin factory** (§7.1): the server is still
  bootstrapping; `session.list` there hung a run past 5 minutes.
- **Command-on-arrival = local execution**: `ab watch` actions are explicit
  opt-in config; briefs pass via file/env (like `ab spawn -f`), never shell-
  interpolated from message text.
- **Consent**: VS Code headless turns need one-time user consent
  (justification); default to notify-only, opt-in auto-handle.
- **Latency honesty**: wake happens between turns, not mid-turn.

## 6. Sizing & placement

- `ab watch`: small–medium (reuses the read loop + `ab spawn` plumbing).
- opencode plugin: medium + a small API verification spike.
- Extension watcher: medium (sidebar + board client already exist).

**Placement: sprint 4 chunk 2** (after T3 A2A relay — the relay demo needs an
autonomous answering worker, which is exactly what wake-on-mail provides).
Chunk 2 also carries token rotation/expiry, broadcast read-state, dashboard
delivery detail, federation, encryption — wake-on-mail slots in as T5.

## 7. Open questions

1. ~~Plugin API spike~~ — **resolved (sprint 5 T2):** the plugin `input.client`
   is the full `@opencode-ai/sdk` `OpencodeClient`. From plugin context,
   `client.session.promptAsync({ path: { id }, body: { parts: [{ type:
   'text', text }], noReply? } })` works (POST `/session/{id}/prompt_async` —
   body shape verified against the SDK types; `ab watch --opencode` sends this
   exact shape). `client.event.subscribe()` streams `session.created` /
   `session.idle` / `session.updated` events for tracking.
   The 1.18.x plugin hooks surface has **no `session.idle` hook** (chat/tool/
   permission/command only) — the background watcher loop + prompt injection
   from the plugin's `server()` entry is the working shape, exactly as §1
   predicted. Plugins auto-load from `.opencode/plugin/` (project) or via the
   `plugin` array in `opencode.json`.
   **Correction (sprint 11 T1, #117):** `client.session.list({ query:
   { directory } })` does **not** mean "live sessions to inject into" — it is
   every session of the project, other processes' and historical ones
   included, which is why the original fan-out echoed a sender's own mail back
   into its session. See §7.1 for the "can the plugin address its own session?"
   spike and §8 for the corrected injection rule.
2. Should `ab watch` heartbeat on behalf of a sleeping agent (keep presence
   "online") or should presence go `sleeping`? (Lean: `sleeping` + `wake:*`
   caps tells producers more truthfully.)
3. Track upstream: VS Code system-initiated chat requests — file/upvote a
   feature request so interactive-chat wake becomes possible later.

### 7.1 Can the plugin address its **own** session? (spike, sprint 11 T1 — #117)

**Answer: no — not directly.** The plugin instance is server/project-scoped,
not per-session. Probe method (opencode **1.18.9**, Windows): temporary
`console.log` probes in `.opencode/plugins/agentboard-wake.js` (reverted
before commit), then a nested `opencode run --model
opencode-go/deepseek-v4.1-flash "Reply OK" --dir <worktree>` to exercise the
plugin in a real server. Observed:

- **`PluginInput` keys:** `client, project, worktree, directory,
  experimental_workspace, serverUrl, $` — **no session id** (`input.sessionID`
  / `input.session` are `undefined`).
- **Hooks do carry ids, but only per activity — not "my session":**
  - `chat.message` input: `{ sessionID, agent, model, messageID, variant }`;
  - `event` payloads for `session.created`, `session.updated`, `session.status`,
    `session.idle`, `message.updated`, `message.part.*` carry
    `properties.sessionID`.
  These fire for whichever session *this process* is handling. In the probe,
  the single `opencode run` session (`ses_e94a…`) arrived this way and could
  be targeted by `promptAsync({ path: { id } })`.
- **`client.session.list({ query: { directory } })` is not a live-session
  list.** It returns the project's sessions — including sessions created by
  *other* opencode processes and historical ones. That per-project fan-out is
  the wake echo: the recipient's plugin prompted the sender's session with the
  sender's own outgoing mail (#117).
- **Do not call `client` inside the plugin factory.** Adding
  `await client.session.list(...)` before returning the hooks made the nested
  `opencode run` hang past 5 minutes (no error, no further prompts); the same
  run completed normally once the call was removed. The server is still
  bootstrapping while plugins load — a callback into it blocks. Only call
  client APIs from hooks/background loops after the factory returns.

**Consequence for the fix:** "the current session" is only addressable via
(1) ids this process observed through its own hooks, or (2) an explicit pin.
Both are now supported; the blind fan-out is gone (§8).

## 8. The opencode plugin (sprint 5 T2 — `.opencode/plugin/`)

`agentboard-wake` (`.opencode/plugins/agentboard-wake.js`, core in
`wake-core.js`): a background `BoardWatcher` long-polls the board (SSE push,
polling fallback — read-only, never claims/acks, dedupe on id, wake-loop
guard) and injects a wake prompt into **the one session that should act**:

```
[agentboard wake] message <id> on board <board> (replies to <id>)
addressed to <identity> — if you are not <identity>, ignore this prompt
from <sender> → <to> [<type>]

<text>

A board message is addressed to you. If it is a request/question, pick it up
with `ab read`, act on it, reply with `ab send --type response --reply-to
<id>`, and ack — per docs/conventions.md §5.
```

Config (env wins, else the workspace `.agentboard.json`, read-only):
`AB_SERVER` / `AB_TOKEN` / `AB_AGENT_ID` / `AB_BOARD`, plus
`AB_WAKE_SESSION` (optional injection pin, below). The agent declares
`wake:opencode-session` in its heartbeat capabilities.

### 8.1 Session-scoped injection — the wake echo fix (sprint 11 T1, #117)

What the plugin does **not** do anymore: list every session of the project and
prompt all of them. That fan-out woke the *sender* with its own outgoing mail
(the recipient's watcher fired correctly, but its injection reached every
session in the directory), and with shared identities it amplified duplicate
responses (#113). The fix, given §7.1's finding that a plugin cannot name its
own session:

| Situation | Behavior |
|---|---|
| `AB_WAKE_SESSION=<session-id>` set | Inject **only** into that session (authoritative pin — the deterministic escape hatch). |
| Exactly one session observed by this process | Inject into it. The watcher only fires for mail addressed to this identity, so that session is the actor. |
| Several sessions observed by this process | **Ambiguous → skip.** Log which ids are live and point at `AB_WAKE_SESSION` / tier-2 `ab watch --opencode <session-id>`. Never fan out: with no per-session identity we cannot tell sender from recipient, and a wrong wake is worse than a missed one (the message stays on the board). |
| No observed session | Skip with a log; wake is best-effort (§4). |

Which sessions count as "observed"? Only ids this process's own hooks saw
(`session.created`, `session.updated`, `message.*`, `chat.message`), tracked by
`createWakeController().noteSession(id)` and expired after 24 h of inactivity
(`DEFAULT_SESSION_TTL_MS`). A session belonging to another opencode process —
the usual sender in a shared checkout — never enters that set, so it can never
be woken. The prompt still carries an explicit recipient marker + message id,
so even a mis-delivered prompt is inert.

Operational notes:

- Multiple tabs in **one** `opencode serve`/TUI process are indistinguishable
  to the plugin → wake is skipped rather than guessed. Pin the intended tab
  with `AB_WAKE_SESSION`, or use tier-2 `ab watch --opencode <session-id>`
  (§3.1). Per-session identities (#109) plus one active session per identity
  (sprint 11 T3) keep the common case at one live session.
- The plugin factory must not call `client` APIs — it deadlocks server
  bootstrap (§7.1).

Hermetic coverage lives in `.opencode/lib/test/wake-core.test.js`:
sender-session-not-woken, recipient-woken, ambiguous-multi-session-skip,
`AB_WAKE_SESSION` pin, no-live-session skip, and the `buildWakeTargets` unit
matrix (pin / one / several / TTL).

Demo: see the sprint-5 T2 PR (a headless `opencode serve` session is woken by
an incoming board request and answers it via `ab`).