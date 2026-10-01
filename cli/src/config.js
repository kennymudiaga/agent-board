/**
 * Workspace config for the `ab` CLI. Stored as `.agentboard.json` in the
 * workspace directory (cwd). Env vars override file values:
 *   AB_SERVER, AB_TOKEN, AB_AGENT_ID
 * Resolution order (issue #41): env vars > `.agentboard.json` in cwd >
 * machine-wide global config (`ab init --global`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CliError } from './api.js';

export const CONFIG_FILE = '.agentboard.json';
const GLOBAL_DIR = 'agentboard';
const GLOBAL_FILE = 'config.json';

export function configPath(cwd = process.cwd()) {
  return resolve(cwd, CONFIG_FILE);
}

/**
 * Machine-wide config path (issue #41): `%APPDATA%\agentboard\config.json`
 * on win32 (Node convention), `$XDG_CONFIG_HOME/agentboard/config.json` or
 * `~/.config/agentboard/config.json` elsewhere. By construction never inside
 * a repo.
 */
export function globalConfigPath() {
  const base =
    process.platform === 'win32' && process.env.APPDATA
      ? join(process.env.APPDATA, GLOBAL_DIR)
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), GLOBAL_DIR);
  return join(base, GLOBAL_FILE);
}

export function loadConfig(cwd = process.cwd(), { requireFile = true } = {}) {
  const path = configPath(cwd);
  let file = {};
  let existed = false;
  if (existsSync(path)) {
    existed = true;
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new CliError(`${path} is not valid JSON`);
    }
  }
  const gpath = globalConfigPath();
  let global = {};
  let globalExisted = false;
  if (existsSync(gpath)) {
    globalExisted = true;
    try {
      global = JSON.parse(readFileSync(gpath, 'utf8'));
    } catch {
      throw new CliError(`${gpath} is not valid JSON`);
    }
  }
  const envTrio = Boolean(process.env.AB_SERVER && process.env.AB_TOKEN && process.env.AB_AGENT_ID);
  if (requireFile && !existed && !envTrio && !globalExisted) {
    throw new CliError(`no ${CONFIG_FILE} in ${cwd} — run \`ab init\` first`);
  }
  const envRoles = process.env.AB_ROLES !== undefined ? parseList(process.env.AB_ROLES) : null;
  const envAny = process.env.AB_SERVER !== undefined || process.env.AB_TOKEN !== undefined || process.env.AB_AGENT_ID !== undefined || process.env.AB_ROLES !== undefined;
  return {
    path,
    globalPath: gpath,
    source: envAny ? 'env' : existed ? 'local' : globalExisted ? 'global' : 'none',
    fromEnv: !existed,
    // A token that came from the environment must never be written to disk
    // (issue #25): env-only identities stay env-only. But a token the user
    // deliberately stored via `ab init` must not be erased either (issue #26).
    // A token that came from the *global* config must not be promoted into a
    // repo-local file (issue #41) — tokens stay in exactly one place.
    tokenFromEnv: process.env.AB_TOKEN !== undefined,
    tokenFromGlobal: process.env.AB_TOKEN === undefined && typeof file.token !== 'string' && typeof global.token === 'string',
    fileToken: typeof file.token === 'string' ? file.token : undefined,
    server: process.env.AB_SERVER ?? file.server ?? global.server,
    token: process.env.AB_TOKEN ?? file.token ?? global.token,
    agentId: process.env.AB_AGENT_ID ?? file.agentId ?? global.agentId,
    provider: file.provider ?? global.provider ?? null,
    roles: envRoles ?? (Array.isArray(file.roles) ? file.roles : Array.isArray(global.roles) ? global.roles : []),
    boards: Array.isArray(file.boards) ? file.boards : Array.isArray(global.boards) ? global.boards : [],
    cursors: file.cursors && typeof file.cursors === 'object' ? file.cursors : global.cursors && typeof global.cursors === 'object' ? global.cursors : {},
    // `ab spawn` preferences from the config files (env AB_SPAWN_* wins over these).
    spawn: file.spawn && typeof file.spawn === 'object' ? file.spawn : global.spawn && typeof global.spawn === 'object' ? global.spawn : {},
  };
}

export function saveConfig(cfg) {
  // Env-only runs (no pre-existing config file) persist cursors + boards and
  // nothing else — boards are non-secret operational state (`ab join` must
  // survive the process), but a token from AB_TOKEN must never reach disk
  // (issue #25). When a stored token exists, keep it even if AB_TOKEN is set
  // for this session (issue #26 — never erase deliberate config). A token
  // resolved from the global config is equally never copied into a repo file
  // (issue #41 — one token, one file).
  const payload = cfg.fromEnv
    ? { boards: cfg.boards, cursors: cfg.cursors }
    : {
        server: cfg.server,
        token: cfg.fileToken ?? (cfg.tokenFromEnv || cfg.tokenFromGlobal ? undefined : cfg.token),
        agentId: cfg.agentId,
        provider: cfg.provider ?? undefined,
        roles: cfg.roles,
        boards: cfg.boards,
        cursors: cfg.cursors,
      };
  writeFileSync(cfg.path, `${JSON.stringify(payload, null, 2)}\n`);
}

export function parseList(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}