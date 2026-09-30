/**
 * Workspace config for the `ab` CLI. Stored as `.agentboard.json` in the
 * workspace directory (cwd). Env vars override file values:
 *   AB_SERVER, AB_TOKEN, AB_AGENT_ID
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError } from './api.js';

export const CONFIG_FILE = '.agentboard.json';

export function configPath(cwd = process.cwd()) {
  return resolve(cwd, CONFIG_FILE);
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
  } else if (requireFile && !(process.env.AB_SERVER && process.env.AB_TOKEN && process.env.AB_AGENT_ID)) {
    throw new CliError(`no ${CONFIG_FILE} in ${cwd} — run \`ab init\` first`);
  }
  const envRoles = process.env.AB_ROLES !== undefined ? parseList(process.env.AB_ROLES) : null;
  return {
    path,
    fromEnv: !existed,
    // A token that came from the environment must never be written to disk
    // (issue #25): env-only identities stay env-only. But a token the user
    // deliberately stored via `ab init` must not be erased either (issue #26).
    tokenFromEnv: process.env.AB_TOKEN !== undefined,
    fileToken: typeof file.token === 'string' ? file.token : undefined,
    server: process.env.AB_SERVER ?? file.server,
    token: process.env.AB_TOKEN ?? file.token,
    agentId: process.env.AB_AGENT_ID ?? file.agentId,
    provider: file.provider ?? null,
    roles: envRoles ?? (Array.isArray(file.roles) ? file.roles : []),
    boards: Array.isArray(file.boards) ? file.boards : [],
    cursors: file.cursors && typeof file.cursors === 'object' ? file.cursors : {},
  };
}

export function saveConfig(cfg) {
  // Env-only runs (no pre-existing config file) persist cursors and nothing
  // else — the env is the identity source, and a token from AB_TOKEN must
  // never reach disk (issue #25). When a stored token exists, keep it even if
  // AB_TOKEN is set for this session (issue #26 — never erase deliberate
  // config); the env token itself is never written.
  const payload = cfg.fromEnv
    ? { cursors: cfg.cursors }
    : {
        server: cfg.server,
        token: cfg.fileToken ?? (cfg.tokenFromEnv ? undefined : cfg.token),
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