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
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new CliError(`${path} is not valid JSON`);
    }
  } else if (requireFile) {
    throw new CliError(`no ${CONFIG_FILE} in ${cwd} — run \`ab init\` first`);
  }
  return {
    path,
    server: process.env.AB_SERVER ?? file.server,
    token: process.env.AB_TOKEN ?? file.token,
    agentId: process.env.AB_AGENT_ID ?? file.agentId,
    provider: file.provider ?? null,
    roles: Array.isArray(file.roles) ? file.roles : [],
    boards: Array.isArray(file.boards) ? file.boards : [],
    cursors: file.cursors && typeof file.cursors === 'object' ? file.cursors : {},
  };
}

export function saveConfig(cfg) {
  const payload = {
    server: cfg.server,
    token: cfg.token,
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