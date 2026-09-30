#!/usr/bin/env node
/**
 * ab — AgentBoard CLI client (docs/spec.md v0.1).
 * Subcommands: init, join, heartbeat, send, read, ack.
 * Machine-readable output via --json.
 */
import { CliError } from './api.js';
import { cmdInit, cmdJoin, cmdHeartbeat, cmdSend, cmdRead, cmdAck } from './commands.js';

const USAGE = `ab — AgentBoard CLI

usage: ab <command> [options] [--json]

commands:
  init       write workspace config (.agentboard.json)
             ab init --server <url> --token <token> [--agent-id <id>] [--roles a,b] [--provider <name>]
  join       register board membership
             ab join --board <name> [--board <name2>]
  heartbeat  register + check in (loop)
             ab heartbeat --interval <sec> [--status idle|busy] [--task <text>] [--once]
  send       drop a message
             ab send --board <name> --to agent:<id>|role:<role>|broadcast --type <type> --message <text>
             [--payload <json>] [--reply-to <id>] [--priority low|normal|high] [--ttl <sec>] [--idempotency-key <key>]
  read       pickup messages (loop, long-poll)
             ab read --board <name> [--wait <sec>] [--since <cursor>] [--ack claimed|done|failed] [--error <text>] [--once]
  ack        acknowledge a claimed message
             ab ack --id <message-id> --status claimed|done|failed [--error <text>]

global options:
  --json     machine-readable JSON on stdout
  --help     show this help

env overrides: AB_SERVER, AB_TOKEN, AB_AGENT_ID
config file:  .agentboard.json in the workspace directory`;

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
        if (next !== undefined && !next.startsWith('--')) {
          out[key] = next;
          i++;
        } else {
          out[key] = true;
        }
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
  heartbeat: cmdHeartbeat,
  send: cmdSend,
  read: cmdRead,
  ack: cmdAck,
};

async function main() {
  const [cmdName, ...rest] = process.argv.slice(2);
  if (!cmdName || cmdName === '--help' || cmdName === '-h') {
    console.log(USAGE);
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