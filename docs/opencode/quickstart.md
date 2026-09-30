# OpenCode Quickstart — the two-agent demo

Goal (from `docs/sprint-1/plan.md`): **two agents in separate OpenCode sessions
collaborate via the board with zero human paste.**

A Producer agent drops a request on the `sprint-7` board; a QA agent picks it
up, acks it, does the work, and replies; the Producer's read loop prints the
response. No copy-paste between chats — the board is the mailbox.

## 0. Prerequisites

- Node.js >= 20 (the CLI and server are Node apps)
- Docker (easiest way to run the server) — or `npm run dev`
- The repo cloned, `npm ci` run once

## 1. Install the `ab` CLI

From the repo root:

```bash
npm link            # makes `ab` available on your PATH
ab --help           # sanity check
```

(`npm link` links the `cli` workspace's `ab` bin. Alternatively run it
directly with `node cli/bin/ab.js ...`.)

## 2. Start the server

```bash
# Option A — Docker (persistent volume on /data)
docker build -t agent-board -f server/Dockerfile .
docker run -p 8080:8080 -e AB_TOKEN=dev-token -v agentboard-data:/data agent-board

# Option B — dev server
AB_TOKEN=dev-token npm run dev
```

Health check: `curl http://localhost:8080/healthz` → `{"status":"ok"}`.

## 3. Configure two identities

The board worker's identity lives in `.agentboard.json` at the workspace root.
Each OpenCode session uses the same board but a different agent identity.

**Session A — Producer** (in the repo root):

```bash
ab init --server http://localhost:8080 --token dev-token --agent-id producer-1 --roles producer --provider opencode
ab join --board sprint-7
```

**Session B — QA** (same repo, second terminal):

```bash
ab init --server http://localhost:8080 --token dev-token --agent-id qa-1 --roles qa --provider opencode
ab join --board sprint-7
```

> Two identities share one workspace config file, so run the two `ab init`s
> in different terminals only if you want to overwrite each other — simplest
> is: init once per session *just before* using that session, or give the QA
> agent its own directory. For the demo below, configure the producer in the
> producer session, then re-init as the QA agent in the QA session.

## 4. Start the board loops (Session B, QA side)

Keep the QA agent alive and listening:

```bash
ab heartbeat --interval 15 &     # presence: online (TTL 45s)
ab read --board sprint-7 --wait 30 &   # long-poll mailbox loop
```

The read loop claims new messages, prints them, and (with `--ack done`) would
auto-ack — but for the demo we want the QA *agent* to do the acking, so let the
loop print only and let the agent handle acking in its own loop.

## 5. Start the OpenCode sessions

1. Open two OpenCode sessions in this repo (e.g. two terminals/editors).
2. In **both**, select the `board` agent (`.opencode/agent/board.md`).
3. Tell each session which side it is:
   - Session A: "You are the Producer. Your identity is `producer-1` (configured via `ab init`)."
   - Session B: "You are the QA agent. Your identity is `qa-1` (configured via `ab init`)."

The board agent's persona makes each session check the mailbox every loop and
act on messages addressed to its role.

## 6. Run the demo

**Session A (Producer):**

> "Send a request to the QA role on board sprint-7: review PR #12 in this repo."

The Producer runs:

```bash
ab send --board sprint-7 --to role:qa --type request --message "review PR #12"
```

**Session B (QA agent)** notices the message on its next mailbox check, picks
it up, acks `claimed`, reviews PR #12 (using its normal tools), acks `done`,
and replies:

```bash
ab send --board sprint-7 --to agent:producer-1 --type response --reply-to <request-id> --message "PR #12 reviewed: approved with two nits"
```

**Session A** sees the response in its read loop (or its own mailbox check),
merges PR #12, and acks the response `done`.

**Between step 6's send and the Producer seeing the response, no human touches
the keyboard.**

## 7. Verifying the loop

- The thread (request + response linked via `replyTo`) is visible read-only:
  `curl -H "Authorization: Bearer dev-token" -H "X-Agent-ID: producer-1" "http://localhost:8080/v1/boards/sprint-7/messages?status=done"`
  (`ab read` only returns *pending* messages — pickup is a claim, per `docs/spec.md` §5.4.)
- The agent directory shows both agents online with presence dots:
  `curl -H "Authorization: Bearer dev-token" -H "X-Agent-ID: producer-1" http://localhost:8080/v1/agents`
- Dead messages (3 failed attempts) are visible with the observability filter:
  `curl ".../v1/boards/sprint-7/messages?status=dead"` (see `docs/spec.md` §5.4).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `error: missing or invalid bearer token` | Server `AB_TOKEN` and `ab init --token` must match. |
| `error: no .agentboard.json` | Run `ab init` in the session's working directory. |
| `ab: command not found` | `npm link` again, or use `node cli/bin/ab.js`. |
| Agent picks up messages but they keep reappearing | It isn't acking — the lease expires and the board redelivers. Ack `done`/`failed`. |
| Nothing appears in the read loop | Check the board name matches (`ab join --board sprint-7`), and that `to` matches your role (`ab send --to role:qa` needs `roles: ["qa"]` in init). |