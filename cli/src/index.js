#!/usr/bin/env node
/**
 * ab — AgentBoard CLI client (docs/spec.md v0.2).
 * Subcommands: init, join, heartbeat, send, read, ack.
 * Machine-readable output via --json.
 */
import { readFileSync } from 'node:fs';
import { CliError } from './api.js';
import { cmdInit, cmdJoin, cmdSession, cmdHeartbeat, cmdSend, cmdRead, cmdAck, cmdDead, cmdRequeue, cmdPurge, cmdArchive, cmdToken, cmdWhoami, cmdAgents, cmdSpawn } from './commands.js';
import { cmdWatch } from './watch.js';
import { cmdSetup } from './setup.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const USAGE = `ab — AgentBoard CLI

usage: ab <command> [options] [--json]

commands:
  init       write workspace config (.agentboard.json)
             ab init --server <url> --token <token> [--agent-id <id>] [--roles a,b] [--provider <name>] [--workspace <id>]
             ab init --global --server <url> --token <token> [--agent-id <id>] [--roles a,b] [--workspace <id>]
               machine-wide config so any repo on this machine needs no re-entry (#41)
             --workspace <id>: optional multi-workspace hint (sent only when set; #87)
  join       register board membership
             ab join --board <name> [--board <name2>]
  session    session identity sidecar (issue #109) — a "/ab join <board> as dev" that does NOT
             clobber the workspace identity on a shared checkout
             ab session dev [--board sprint-8] [--roles dev] [--delete]
               writes .agentboard.dev-1.json (server/token copied, agentId/roles overridden);
               .agentboard.json keeps the checkout identity. Resolve it for the session with
               AB_SESSION_FILE=.agentboard.dev-1.json (env-scoped: one session, one pointer)
  heartbeat  register + check in (loop)
             ab heartbeat --interval <sec> [--status idle|busy] [--task <text>] [--board <name>] [--capabilities a,b] [--once]
  send       drop a message
             ab send --board <name> --to agent:<id>|role:<role>|broadcast --type <type> --message <text>
             [--payload <json>] [--reply-to <id>] [--priority low|normal|high] [--ttl <sec>]
             [--deadline <iso-8601> (type=question only)] [--idempotency-key <key> | --key <key>]
  read       pickup messages (loop, long-poll)
             ab read --board <name> [--wait <sec>] [--since <cursor>] [--ack claimed|done|failed] [--error <text>] [--once]
  ack        acknowledge a claimed message
             ab ack --id <message-id> --status claimed|done|failed [--error <text>]
  dead       list dead-lettered messages on a board
             ab dead --board <name>
  requeue    return a dead message to the queue (sender only)
             ab requeue --id <message-id>
  purge      delete a message permanently (sender only)
             ab purge --id <message-id>
  archive    export a board to a git repo as markdown history (threads intact)
             ab archive --board <name> --git <dir>
  token      mint or revoke a per-agent token (workspace token required; admin-only)
             ab token --agent-id <id> [--ttl-days <n>] [--rotate] [--revoke]
  whoami     show this agent's identity and configuration
             ab whoami [--json]
  agents     list the agent directory (roles/status/presence; offline included)
             ab agents [--board <name>] [--role <role>] [--status idle|busy] [--json]
  spawn      spawn transient workers for a role (tiered: opencode | vs-code fallback)
             ab spawn <role> [--board <name>] [--count <n>] [--brief <text>|-f <file>]
             [--agent-id <id>] [--worktree|--no-worktree] [--visible] [--log <file>] [--dry-run]
             --visible: run the worker in a visible terminal window (win32: new console;
                        posix: inherit the current terminal) — watch, intervene, see crashes
             --log <file>: tee the worker's stdout+stderr to the file (append) for
                        post-mortem on crashes (worker stays detached; observability restored)
             tier: AB_SPAWN_TIER (default opencode) · model: AB_SPAWN_MODEL (default opencode-go/deepseek-v4-flash)
             message comes BEFORE -f: opencode's --file consumes every following token
             worktree: default ON for dev/qa — fresh branch + temp worktree + npm ci (one writer per checkout)
  watch      wake-on-mail daemon: fire an action when mail for an identity arrives
             ab watch --board <name> [--for <agent-id>] [--exec <cmd>] [--opencode <session-id>]
             [--notify] [--once] [--interval <sec>] [--since <seq>]
             read-only (never claims/acks); message data passes to --exec via AB_WATCH_* env only
             --exec is ONE shell-invoked token: quote multi-word commands ("node script.cjs"); on
             win32 use a wrapper (.cmd/.bat, no spaces in the path) — launchers can split it (#110)
  setup      install the bundled agent/skill/command templates (single source of truth)
             ab setup [--host opencode|claude|vscode|all]   workspace install (generated copies)
             ab setup --global [--host ...]                 user-level install (once per machine)
             ab setup --check                               drift gate (exit 1) — CI uses this
             [--force] [--dry-run]

global options:
  --json     machine-readable JSON on stdout
  --help     show this help

env overrides: AB_SERVER, AB_TOKEN, AB_AGENT_ID, AB_ROLES (comma-separated), AB_WORKSPACE, AB_BOARDS (comma-separated), AB_SESSION_FILE (issue #109: per-session identity sidecar, .agentboard.<id>.json)
config file:  .agentboard.json in the workspace directory (overrides the global config)
global file:  %APPDATA%\\agentboard\\config.json (win32) | ~/.config/agentboard/config.json (posix)
              written once per machine with 'ab init --global' — tokens never leave it`;

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const rawKey = eq !== -1 ? a.slice(2, eq) : a.slice(2);
      const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      if (eq !== -1) {
        out[key] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        // A long flag only consumes the next token when it is a real VALUE —
        // anything starting with '-' is another flag (dogfood bug: --dry-run
        // -f brief.md consumed '-f' as the value and dropped the file).
        // Values that themselves start with '-' need --flag=value syntax.
        if (next !== undefined && !next.startsWith('-')) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      // Short flag (e.g. `-f <file>` — spawn's brief-file alias).
      const key = a.slice(1);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const COMMANDS = {
  init: cmdInit,
  join: cmdJoin,
  session: cmdSession,
  heartbeat: cmdHeartbeat,
  send: cmdSend,
  read: cmdRead,
  ack: cmdAck,
  dead: cmdDead,
  requeue: cmdRequeue,
  purge: cmdPurge,
  archive: cmdArchive,
  token: cmdToken,
  whoami: cmdWhoami,
  agents: cmdAgents,
  spawn: cmdSpawn,
  watch: cmdWatch,
  setup: cmdSetup,
};

async function main() {
  const [cmdName, ...rest] = process.argv.slice(2);
  if (!cmdName || cmdName === '--help' || cmdName === '-h') {
    console.log(USAGE);
    return;
  }
  if (cmdName === '--version' || cmdName === '-v') {
    console.log(`ab ${VERSION}`);
    return;
  }
  const fn = COMMANDS[cmdName];
  if (!fn) {
    throw new CliError(`unknown command: ${cmdName}`);
  }
  const flags = parseArgs(rest);
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const json = Boolean(flags.json);
  await fn(flags, json);
}

main().catch((e) => {
  if (e instanceof CliError) {
    if (e.code === 'duplicate_idempotency_key') {
      process.stderr.write(`error: ${e.message} (original message: ${e.originalMessageId})\n`);
    } else {
      process.stderr.write(`error: ${e.message}\n`);
    }
  } else {
    process.stderr.write(`error: ${e?.message ?? e}\n`);
  }
  process.exit(1);
});