/**
 * `ab setup` â€” install the AgentBoard agent/skill/command files from the
 * CLI's bundled templates (sprint 7 T1, issue #77).
 *
 * Single source of truth: `cli/templates/` (shipped in the npm package).
 * This repo's committed copies are generated â€” run `ab setup --force` after
 * editing a template; CI runs `ab setup --check` so dual-copy drift cannot
 * recur.
 *
 * Modes:
 *   ab setup [--host opencode|claude|vscode|all]      workspace install
 *   ab setup --global [--host ...]                    user-level install
 *   ab setup --check                                  drift gate (exit 1)
 *   ab setup --dry-run / --force
 *
 * Global paths (verified against host docs, 2026-10):
 *   opencode: ~/.config/opencode/{agents,commands,skills}/... (OPENCODE_CONFIG_DIR overrides)
 *   claude:   ~/.claude/{commands,skills}/...
 *   vscode:   workspace-only (.github/prompts/) â€” skipped in --global with a note
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './api.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
const HOSTS = ['opencode', 'claude', 'vscode'];
const AGENTS_BEGIN = '<!-- agentboard:begin';
const AGENTS_END = '<!-- agentboard:end -->';

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).replaceAll('\\', '/'));
  }
  return out;
}

function render(content, version = VERSION) {
  return content.replaceAll('{{version}}', version).replace(/\r\n/g, '\n');
}

function readTemplate(rel) {
  return render(readFileSync(join(TEMPLATES, rel), 'utf8'));
}

/** Map a template path to its target for a host. Returns null when N/A. */
function targetFor(host, rel, { global, home }) {
  if (rel === 'AGENTS.md') return global ? null : 'AGENTS.md';
  if (rel.startsWith('skills/')) {
    // One canonical skill, installed for every host that supports skills.
    if (host === 'opencode') return global ? join(home, '.config', 'opencode', rel) : join('.opencode', rel);
    if (host === 'claude') return global ? join(home, '.claude', rel) : join('.claude', rel);
    return null; // vscode has no skills surface
  }
  if (rel.startsWith('opencode/')) {
    if (host !== 'opencode') return null;
    const sub = rel.slice('opencode/'.length);
    return global ? join(process.env.OPENCODE_CONFIG_DIR || join(home, '.config', 'opencode'), sub) : join('.opencode', sub);
  }
  if (rel.startsWith('claude/')) {
    if (host !== 'claude') return null;
    const sub = rel.slice('claude/'.length);
    return global ? join(home, '.claude', sub) : join('.claude', sub);
  }
  if (rel.startsWith('vscode/')) {
    if (host !== 'vscode') return null;
    if (global) return null; // VS Code prompt files are workspace-scoped
    return join('.github', 'prompts', rel.slice('vscode/prompts/'.length));
  }
  return null;
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Cross-platform display path (forward slashes in messages). */
function display(p) {
  return p.replaceAll('\\', '/');
}

function agentsSection(text) {
  const b = text.indexOf(AGENTS_BEGIN);
  const e = text.indexOf(AGENTS_END);
  if (b === -1 || e === -1 || e < b) return null;
  return text.slice(b, e + AGENTS_END.length);
}

function upsertAgents(existing, rendered) {
  if (existing === null) return `${rendered.trimEnd()}\n`;
  const section = agentsSection(existing);
  if (section === null) return `${existing.trimEnd()}\n\n${rendered.trimEnd()}\n`;
  const b = existing.indexOf(AGENTS_BEGIN);
  const e = existing.indexOf(AGENTS_END) + AGENTS_END.length;
  return existing.slice(0, b) + rendered.trimEnd() + existing.slice(e);
}

export async function cmdSetup(flags, json) {
  const check = Boolean(flags.check);
  const dryRun = Boolean(flags.dryRun);
  const force = Boolean(flags.force);
  const global = Boolean(flags.global);
  const host = flags.host === undefined ? 'all' : String(flags.host);
  if (host !== 'all' && !HOSTS.includes(host)) {
    throw new CliError(`--host must be one of: all, ${HOSTS.join(', ')}`);
  }
  if (check && (dryRun || force)) throw new CliError('--check cannot be combined with --dry-run/--force');

  const home = homedir();
  const hosts = host === 'all' ? HOSTS : [host];
  const results = { wrote: [], updated: [], unchanged: [], skipped: [], drift: [], skippedHosts: [] };

  // Collect the install plan: template rel -> target path.
  const plan = [];
  const seen = new Set();
  for (const rel of walk(TEMPLATES)) {
    for (const h of hosts) {
      const target = targetFor(h, rel, { global, home });
      if (target === null) continue;
      const key = target;
      if (seen.has(key)) continue; // shared skill written once per target
      seen.add(key);
      plan.push({ host: h, rel, target });
    }
  }
  if (global && hosts.includes('vscode')) results.skippedHosts.push('vscode (prompt files are workspace-scoped â€” run `ab setup` in the repo)');

  const cwd = process.cwd();
  for (const item of plan) {
    const template = readTemplate(item.rel);
    const targetPath = isAbsolute(item.target) ? item.target : join(cwd, item.target);
    const exists = existsSync(targetPath);
    const existing = exists ? normalize(readFileSync(targetPath, 'utf8')) : null;

    if (item.rel === 'AGENTS.md') {
      if (check) {
        const section = existing === null ? null : agentsSection(existing);
        if (section === null || normalize(section).trimEnd() !== normalize(template).trimEnd()) {
          results.drift.push(`${display(item.target)} (agentboard section missing or out of date)`);
        } else results.unchanged.push(display(item.target));
        continue;
      }
      const next = upsertAgents(existing, template);
      if (existing !== null && normalize(existing) === normalize(next)) {
        results.unchanged.push(display(item.target));
      } else if (dryRun) {
        results.wrote.push(`${display(item.target)} (dry-run)`);
      } else {
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, next);
        (existing === null ? results.wrote : results.updated).push(display(item.target));
      }
      continue;
    }

    const same = existing !== null && existing === template;
    if (check) {
      if (!exists) results.drift.push(`${display(item.target)} (missing)`);
      else if (!same) results.drift.push(`${display(item.target)} (differs from template)`);
      else results.unchanged.push(display(item.target));
      continue;
    }
    if (same) {
      results.unchanged.push(display(item.target));
    } else if (exists && !force && !dryRun) {
      results.skipped.push(`${item.target} (differs â€” use --force to overwrite)`);
    } else if (dryRun) {
      results.wrote.push(`${display(item.target)} (dry-run)`);
    } else {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, template);
      (exists ? results.updated : results.wrote).push(display(item.target));
    }
  }

  if (check) {
    if (results.drift.length > 0) {
      const detail = results.drift.map((d) => `  - ${d}`).join('\n');
      throw new CliError(`ab setup --check: ${results.drift.length} file(s) out of date:\n${detail}\n  fix: run \`ab setup --force\` (workspace) and commit`);
    }
    if (json) console.log(JSON.stringify({ ok: true, check: true, upToDate: results.unchanged.length }));
    else console.log(`ab setup --check: up to date (${results.unchanged.length} file(s))`);
    return;
  }

  const where = global ? 'user-level' : 'workspace';
  if (json) {
    console.log(JSON.stringify({ ok: true, global, host, dryRun, ...results }));
    return;
  }
  for (const f of results.wrote) console.log(`${dryRun ? 'would write' : 'wrote  '} ${f}`);
  for (const f of results.updated) console.log(`updated ${f}`);
  for (const f of results.unchanged) console.log(`unchanged ${f}`);
  for (const f of results.skipped) console.log(`skipped ${f}`);
  for (const h of results.skippedHosts) console.log(`note: ${h}`);
  console.log(
    `ab setup (${where}): ${results.wrote.length} written, ${results.updated.length} updated, ` +
      `${results.unchanged.length} unchanged, ${results.skipped.length} skipped`,
  );
  if (!global && !dryRun) {
    console.log('next: commit the generated files; sessions in this repo now load the AgentBoard skill/agents/commands.');
  }
  if (global && !dryRun) {
    console.log('next: `ab init --global --server <url> --token <t> --agent-id <id> --roles <r>` then start a session in any repo.');
  }
}