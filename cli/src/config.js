/**
 * Workspace config for the `ab` CLI. Stored as `.agentboard.json` in the
 * workspace directory (cwd). Env vars override file values:
 *   AB_SERVER, AB_TOKEN, AB_AGENT_ID, AB_WORKSPACE, AB_BOARDS
 * Resolution order (issue #41): env vars > session sidecar (issue #109,
 * `AB_SESSION_FILE` — `.agentboard.<id>.json` written by `ab session`) >
 * `.agentboard.json` in cwd > machine-wide global config (`ab init --global`).
 *
 * The session sidecar (issue #109): `/ab join <board> as <role>` must never
 * clobber the workspace identity on a shared checkout. `ab session <role>`
 * writes a per-session identity file that the session resolves through
 * `AB_SESSION_FILE` — the workspace `.agentboard.json` keeps its deliberate
 * identity untouched, and saveConfig never persists a session identity into
 * it (same class as #25/#26/#41/#58: identity follows the session, not the
 * checkout).
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
  // Session identity sidecar (issue #109): `ab session <role>` writes
  // `.agentboard.<id>.json`; the session resolves it via AB_SESSION_FILE
  // (env-scoped by definition — one session, one pointer). Precedence sits
  // between the AB_* env overrides and the workspace file.
  let session = {};
  let sessionPath = null;
  const sessionActive = process.env.AB_SESSION_FILE !== undefined;
  if (sessionActive) {
    sessionPath = resolve(cwd, process.env.AB_SESSION_FILE);
    if (!existsSync(sessionPath)) {
      throw new CliError(
        `${sessionPath} does not exist (AB_SESSION_FILE) — create it with \`ab session <role>\` or point AB_SESSION_FILE at an existing sidecar`,
      );
    }
    try {
      session = JSON.parse(readFileSync(sessionPath, 'utf8'));
    } catch {
      throw new CliError(`${sessionPath} (AB_SESSION_FILE) is not valid JSON`);
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
  if (requireFile && !existed && !envTrio && !sessionActive && !globalExisted) {
    throw new CliError(`no ${CONFIG_FILE} in ${cwd} — run \`ab init\` first`);
  }
  const envRoles = process.env.AB_ROLES !== undefined ? parseList(process.env.AB_ROLES) : null;
  // #93c: AB_BOARDS env override for the config `boards` list — an env-identity
  // session (e.g. an `ab spawn` worker) can pin its boards without touching
  // the file. Comma-separated, same grammar as `ab join --board a --board b`.
  const envBoards = process.env.AB_BOARDS !== undefined ? parseList(process.env.AB_BOARDS) : null;
  const envAny = process.env.AB_SERVER !== undefined || process.env.AB_TOKEN !== undefined || process.env.AB_AGENT_ID !== undefined || process.env.AB_ROLES !== undefined;
  // Issue #109: a session identity (AB_SESSION_FILE) must NEVER inherit the
  // local file's cursors either — same class as #67 (env identities start
  // fresh); its boards still come from the operational state like any session.
  const sessionAny = envAny || sessionActive;
  return {
    path,
    globalPath: gpath,
    sessionPath,
    source: envAny ? 'env' : sessionActive ? 'session' : existed ? 'local' : globalExisted ? 'global' : 'none',
    fromEnv: !existed,
    // A token that came from the environment must never be written to disk
    // (issue #25): env-only identities stay env-only. But a token the user
    // deliberately stored via `ab init` must not be erased either (issue #26).
    // A token that came from the *global* config must not be promoted into a
    // repo-local file (issue #41) — tokens stay in exactly one place.
    tokenFromEnv: process.env.AB_TOKEN !== undefined,
    tokenFromGlobal: process.env.AB_TOKEN === undefined && typeof file.token !== 'string' && typeof global.token === 'string',
    fileToken: typeof file.token === 'string' ? file.token : undefined,
    // The identity fields as stored in the LOCAL file (before env/session/
    // global overrides). saveConfig persists exactly these — a session whose
    // identity came from env or a sidecar (e.g. `ab session dev` on a shared
    // checkout) must never clobber the workspace's deliberate identity.
    fileValues: {
      server: typeof file.server === 'string' ? file.server : undefined,
      token: typeof file.token === 'string' ? file.token : undefined,
      agentId: typeof file.agentId === 'string' ? file.agentId : undefined,
      provider: file.provider ?? undefined,
      roles: Array.isArray(file.roles) ? file.roles : undefined,
      workspace: typeof file.workspace === 'string' ? file.workspace : undefined,
      spawn: file.spawn && typeof file.spawn === 'object' ? file.spawn : undefined,
    },
    server: process.env.AB_SERVER ?? session.server ?? file.server ?? global.server,
    token: process.env.AB_TOKEN ?? session.token ?? file.token ?? global.token,
    agentId: process.env.AB_AGENT_ID ?? session.agentId ?? file.agentId ?? global.agentId,
    // Workspace hint (sprint 8 T5, #87): env > session > file > global. The CLI
    // sends it only when set; single-workspace servers ignore it.
    workspace: process.env.AB_WORKSPACE ?? session.workspace ?? file.workspace ?? global.workspace,
    provider: session.provider ?? file.provider ?? global.provider ?? null,
    roles: envRoles ?? (Array.isArray(session.roles) ? session.roles : Array.isArray(file.roles) ? file.roles : Array.isArray(global.roles) ? global.roles : []),
    boards: envBoards ?? (Array.isArray(file.boards) ? file.boards : Array.isArray(global.boards) ? global.boards : []),
    // #67: an env- or session-identity (e.g. an `ab spawn` child or `ab
    // session` sidecar sharing the workspace cwd) must NEVER inherit the
    // file's cursors — they are the file identity's per-reader watermarks and
    // can sit far ahead of what a fresh worker has seen, silently skipping
    // pending mail. They start from a fresh cursor (first read `since 0`),
    // same class as #58.
    cursors: sessionAny
      ? {}
      : file.cursors && typeof file.cursors === 'object'
        ? file.cursors
        : global.cursors && typeof global.cursors === 'object'
          ? global.cursors
          : {},
    // `ab spawn` preferences from the config files (env AB_SPAWN_* wins over these).
    spawn: file.spawn && typeof file.spawn === 'object' ? file.spawn : global.spawn && typeof global.spawn === 'object' ? global.spawn : {},
  };
}

export function saveConfig(cfg) {
  // Only the local file's OWN values are ever persisted — plus non-secret
  // operational state (boards, cursors). Identity fields that this session
  // resolved from env or the global config are session-scoped and must never
  // overwrite the workspace's deliberate config (issue #25/#26/#41; dogfood:
  // `ab spawn` workers share the spawner's cwd and would otherwise clobber
  // its identity on every read/join).
  const payload = cfg.fromEnv
    ? { boards: cfg.boards, cursors: cfg.cursors }
    : {
        ...(cfg.fileValues.server !== undefined ? { server: cfg.fileValues.server } : {}),
        ...(cfg.fileValues.token !== undefined ? { token: cfg.fileValues.token } : {}),
        ...(cfg.fileValues.agentId !== undefined ? { agentId: cfg.fileValues.agentId } : {}),
        ...(cfg.fileValues.provider !== undefined ? { provider: cfg.fileValues.provider } : {}),
        ...(cfg.fileValues.roles !== undefined ? { roles: cfg.fileValues.roles } : {}),
        // #87: the workspace hint persists like the other deliberate identity
        // fields — env/global overrides are session-scoped and never written.
        ...(cfg.fileValues.workspace !== undefined ? { workspace: cfg.fileValues.workspace } : {}),
        ...(cfg.fileValues.spawn !== undefined ? { spawn: cfg.fileValues.spawn } : {}),
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