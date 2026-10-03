import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '..', 'bin', 'ab.js');

/** Run `ab` with a clean env (no ambient AB_*), optional HOME override. */
function runCli(args, { cwd, env = {} } = {}) {
  return new Promise((resolvePromise) => {
    const childEnv = { ...process.env, ...env };
    for (const k of ['AB_SERVER', 'AB_TOKEN', 'AB_AGENT_ID', 'AB_ROLES', 'AB_BOARD', 'OPENCODE_CONFIG_DIR']) {
      if (!(k in env)) delete childEnv[k];
    }
    execFile(process.execPath, [CLI, ...args], { cwd, env: childEnv }, (err, stdout, stderr) => {
      resolvePromise({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('ab setup — template install + drift gate (sprint 7 T1)', () => {
  it('workspace setup writes the generated files for all hosts; --check passes', async () => {
    const dir = makeDir('ab-setup-ws-');
    try {
      const run = await runCli(['setup'], { cwd: dir });
      expect(run.code).toBe(0, run.stderr);
      expect(run.stdout).toContain('ab setup (workspace)');

      for (const f of [
        '.opencode/agents/board-worker.md',
        '.opencode/agents/board-producer.md',
        '.opencode/commands/ab.md',
        '.opencode/commands/kickstart.md',
        '.opencode/skills/agentboard/SKILL.md',
        '.claude/commands/ab.md',
        '.claude/commands/kickstart.md',
        '.claude/skills/agentboard/SKILL.md',
        '.github/prompts/ab.prompt.md',
        '.github/prompts/kickstart.prompt.md',
        'AGENTS.md',
      ]) {
        expect(existsSync(join(dir, f)), `missing ${f}`).toBe(true);
      }

      // Generated files carry the version marker; AGENTS.md is marker-wrapped.
      const skill = readFileSync(join(dir, '.opencode/skills/agentboard/SKILL.md'), 'utf8');
      expect(skill).toContain('agentboard:generated v');
      const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('<!-- agentboard:begin');
      expect(agents).toContain('<!-- agentboard:end -->');

      // The shared skill is byte-identical across hosts (no dual-copy drift).
      expect(readFileSync(join(dir, '.claude/skills/agentboard/SKILL.md'), 'utf8')).toBe(skill);

      const check = await runCli(['setup', '--check'], { cwd: dir });
      expect(check.code).toBe(0, check.stderr);
      expect(check.stdout).toContain('up to date');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--check catches drift (exit 1) and --force regenerates', async () => {
    const dir = makeDir('ab-setup-drift-');
    try {
      await runCli(['setup'], { cwd: dir });
      writeFileSync(join(dir, '.opencode/agents/board-worker.md'), '# locally edited\n');

      const check = await runCli(['setup', '--check'], { cwd: dir });
      expect(check.code).not.toBe(0);
      expect(check.stderr).toContain('out of date');
      expect(check.stderr).toContain('.opencode/agents/board-worker.md');

      // A plain setup refuses to clobber; --force regenerates.
      const plain = await runCli(['setup'], { cwd: dir });
      expect(plain.code).toBe(0, plain.stderr);
      expect(plain.stdout).toContain('skipped');
      expect(readFileSync(join(dir, '.opencode/agents/board-worker.md'), 'utf8')).toBe('# locally edited\n');

      const forced = await runCli(['setup', '--force'], { cwd: dir });
      expect(forced.code).toBe(0, forced.stderr);
      expect(readFileSync(join(dir, '.opencode/agents/board-worker.md'), 'utf8')).toContain('agentboard:generated');
      expect((await runCli(['setup', '--check'], { cwd: dir })).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent and --dry-run writes nothing', async () => {
    const dir = makeDir('ab-setup-idem-');
    try {
      await runCli(['setup'], { cwd: dir });
      const again = await runCli(['setup'], { cwd: dir });
      expect(again.stdout).toContain('0 written, 0 updated, 11 unchanged');

      const dryDir = makeDir('ab-setup-dry-');
      try {
        const dry = await runCli(['setup', '--dry-run'], { cwd: dryDir });
        expect(dry.code).toBe(0, dry.stderr);
        expect(dry.stdout).toContain('would write');
        expect(existsSync(join(dryDir, '.opencode'))).toBe(false);
        expect(existsSync(join(dryDir, 'AGENTS.md'))).toBe(false);
      } finally {
        rmSync(dryDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--host narrows the install; bad host is rejected', async () => {
    const dir = makeDir('ab-setup-host-');
    try {
      const run = await runCli(['setup', '--host', 'opencode'], { cwd: dir });
      expect(run.code).toBe(0, run.stderr);
      expect(existsSync(join(dir, '.opencode/agents/board-worker.md'))).toBe(true);
      expect(existsSync(join(dir, '.claude/commands/ab.md'))).toBe(false);
      expect(existsSync(join(dir, '.github/prompts/ab.prompt.md'))).toBe(false);

      const bad = await runCli(['setup', '--host', 'emacs'], { cwd: dir });
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('--host must be one of');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--global installs to the user-level paths (HOME override), skips vscode prompts', async () => {
    const home = makeDir('ab-setup-home-');
    const dir = makeDir('ab-setup-gws-');
    try {
      const env = { USERPROFILE: home, HOME: home, XDG_CONFIG_HOME: home };
      const run = await runCli(['setup', '--global'], { cwd: dir, env });
      expect(run.code).toBe(0, run.stderr);

      expect(existsSync(join(home, '.config/opencode/agents/board-worker.md'))).toBe(true);
      expect(existsSync(join(home, '.config/opencode/commands/ab.md'))).toBe(true);
      expect(existsSync(join(home, '.config/opencode/skills/agentboard/SKILL.md'))).toBe(true);
      expect(existsSync(join(home, '.claude/commands/ab.md'))).toBe(true);
      expect(existsSync(join(home, '.claude/skills/agentboard/SKILL.md'))).toBe(true);
      // vscode prompts are workspace-scoped — no global write, note printed.
      expect(existsSync(join(dir, '.github'))).toBe(false);
      expect(run.stdout).toContain('workspace-scoped');
      // AGENTS.md is a workspace file — never written globally.
      expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);

      const check = await runCli(['setup', '--global', '--check'], { cwd: dir, env });
      expect(check.code).toBe(0, check.stderr);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AGENTS.md: appends the marked section to an existing user file, updates it in place, --check detects section drift', async () => {
    const dir = makeDir('ab-setup-agents-');
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# My repo\n\nUser content here.\n');
      const run = await runCli(['setup', '--host', 'opencode'], { cwd: dir });
      expect(run.code).toBe(0, run.stderr);
      const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(content).toContain('# My repo');
      expect(content).toContain('User content here.');
      expect(content).toContain('<!-- agentboard:begin');
      expect((await runCli(['setup', '--check', '--host', 'opencode'], { cwd: dir })).code).toBe(0);

      // Edit the generated section -> drift.
      const edited = content.replace('<!-- agentboard:end -->', 'sneaky edit inside the section\n<!-- agentboard:end -->');
      writeFileSync(join(dir, 'AGENTS.md'), edited);
      const check = await runCli(['setup', '--check', '--host', 'opencode'], { cwd: dir });
      expect(check.code).not.toBe(0);
      expect(check.stderr).toContain('AGENTS.md');

      // Re-setup updates the section but keeps user content.
      await runCli(['setup', '--host', 'opencode'], { cwd: dir });
      const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(after).toContain('User content here.');
      expect(after).not.toContain('sneaky edit');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates flag combinations', async () => {
    const dir = makeDir('ab-setup-flags-');
    try {
      const both = await runCli(['setup', '--check', '--force'], { cwd: dir });
      expect(both.code).not.toBe(0);
      expect(both.stderr).toContain('--check cannot be combined');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});