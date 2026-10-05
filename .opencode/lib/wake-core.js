import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * agentboard-wake core (sprint 5 T2, design docs/wake-on-mail.md tier 1;
 * sprint 9 T1, issue #101 — lazy binding + global-config fallback).
 *
 * The board-watching half of the opencode wake plugin, factored out so it can
 * be tested hermetically. Mirrors `ab watch` (cli/src/watch.js) semantics:
 * read-only observability (never claims, never acks), SSE push when the token
 * is the workspace token, polling fallback, dedupe on message id, and the
 * wake-loop guard (the watched identity's own mail never fires).
 *
 * The plugin entry (agentboard-wake.js) wires this to `input.client` and
 * injects wake prompts into live opencode sessions.
 */

/** Wake-loop guard + filter: agent:/role: mail to the watched identity, never its own. */
export function addressedTo(m, forId, roles) {
  if (m.from === forId) return false;
  if (m.to === `agent:${forId}`) return true;
  return m.to.startsWith('role:') && roles.includes(m.to.slice('role:'.length));
}

/**
 * Coerce `AB_WAKE_RESOLVE_MS` (sprint 10 T2, #110 follow-up): a non-numeric
 * value previously became NaN and the lazy-resolve loop re-fired as fast as
 * the event loop allowed (setInterval(NaN) ≈ 0ms — a hot spin). Invalid or
 * unset values fall back to the default; sub-second values are clamped up (a
 * sub-second re-resolve loop is never intended).
 */
export function wakeResolveMs(env = process.env, fallback = 5000) {
  const n = Number(env.AB_WAKE_RESOLVE_MS);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** The injection text: message id, board, thread refs, sender, text. */
export function buildWakePrompt(m) {
  const text = m.payload && typeof m.payload.text === 'string' ? m.payload.text : JSON.stringify(m.payload ?? null);
  const thread = m.replyTo ? ` (replies to ${m.replyTo})` : '';
  return (
    `[agentboard wake] message ${m.id} on board ${m.board}${thread}\n` +
    `from ${m.from} → ${m.to} [${m.type}]\n` +
    `\n${text}\n\n` +
    'A board message is addressed to you. If it is a request/question, pick it up with `ab read`, act on it, ' +
    'reply with `ab send --type response --reply-to <id>`, and ack — per docs/conventions.md §5.'
  );
}

/**
 * Machine-wide config path (mirrors cli/src/config.js, issue #41): on win32
 * `%APPDATA%\agentboard\config.json` (Node convention), elsewhere
 * `$XDG_CONFIG_HOME/agentboard/config.json` or `~/.config/agentboard/config.json`.
 * `APPDATA`/`XDG_CONFIG_HOME` are injectable via env for hermetic tests.
 */
export function defaultGlobalConfigPath(env = process.env) {
  const dir =
    process.platform === 'win32' && env.APPDATA
      ? join(env.APPDATA, 'agentboard')
      : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agentboard');
  return join(dir, 'config.json');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve board config, mirroring cli/src/config.js precedence:
 * **env AB_* → workspace `.agentboard.json` → machine-wide global config**
 * (`ab init --global`, #41 — one setup per machine makes every repo,
 * fresh clones included, wake-capable at load). Board for the watcher:
 * `AB_BOARD` ?? the first board from the resolved config. Returns `null`
 * when no source yields server + token + agentId (plugin stays inert and
 * lazy-binds later — issue #101).
 */
export function resolveConfig(directory, env = process.env, globalConfigPath = defaultGlobalConfigPath(env)) {
  const file = readJson(join(directory, '.agentboard.json'));
  const global = readJson(globalConfigPath);
  const server = env.AB_SERVER ?? file?.server ?? global?.server;
  const token = env.AB_TOKEN ?? file?.token ?? global?.token;
  const agentId = env.AB_AGENT_ID ?? file?.agentId ?? global?.agentId;
  const board = env.AB_BOARD ?? file?.boards?.[0] ?? global?.boards?.[0];
  if (!server || !token || !agentId) return null;
  return { server, token, agentId, board };
}

/**
 * Lazy re-resolve loop (sprint 9 T1, issue #101): polls `resolve()` and calls
 * `onChange(cfg)` ONLY when the resolved config's watch-key changes — the
 * restart-guard (server/token/agentId/board). `null` (inert) → `onChange(null)`;
 * a key change (config appears, identity switches, board changes) → `onChange(cfg)`
 * so the caller can (re)start its watcher. Unchanged config never re-fires.
 * The timer is injectable for hermetic tests (`timer.setInterval`/`clearInterval`).
 */
export class LazyResolver {
  constructor({ resolve, onChange, onLog = () => {}, intervalMs = 5000, timer = null }) {
    this.resolve = resolve;
    this.onChange = onChange;
    this.onLog = onLog;
    this.intervalMs = intervalMs;
    this.timer = timer ?? globalThis;
    this.key = undefined;
    this._stopped = false;
    this._handle = null;
  }

  static keyOf(cfg) {
    return cfg ? `${cfg.server}|${cfg.token}|${cfg.agentId}|${cfg.board ?? ''}` : null;
  }

  /** One re-resolve cycle: fires onChange only on a watch-key change. */
  tick() {
    if (this._stopped) return;
    let cfg = null;
    try {
      cfg = this.resolve();
    } catch (e) {
      this.onLog(`[agentboard-wake] resolve failed: ${e.message}`);
      return;
    }
    const key = LazyResolver.keyOf(cfg);
    if (key !== this.key) {
      this.key = key;
      this.onChange(cfg);
    }
  }

  /** Initial resolve + poll loop until stop(). */
  start() {
    this.tick();
    if (!this._stopped) {
      this._handle = this.timer.setInterval(() => this.tick(), this.intervalMs);
    }
    return this;
  }

  stop() {
    this._stopped = true;
    if (this._handle) this.timer.clearInterval(this._handle);
    this._handle = null;
  }
}

/**
 * Plugin wiring (sprint 9 T1, #101), factored for hermetic tests: owns the
 * LazyResolver + BoardWatcher lifecycle and the injection into live opencode
 * sessions. `start()` begins the lazy loop (inert until a config appears);
 * `stop()` tears everything down. The plugin entry (agentboard-wake.js) is a
 * thin wrapper over this.
 */
export function createWakeController({ client, directory, log = () => {}, intervalMs = 5000, pollMs = 5000 }) {
  let watcher = null;

  const stopWatcher = () => {
    if (watcher) {
      watcher.stop();
      watcher = null;
    }
  };
  const startWatcher = (cfg) => {
    watcher = new BoardWatcher({
      server: cfg.server,
      token: cfg.token,
      board: cfg.board,
      forId: cfg.agentId,
      pollMs,
      onLog: log,
      onMail: async (m) => {
        const text = buildWakePrompt(m);
        log(`injecting wake prompt into live sessions (${m.id} ${m.from} -> ${m.to})`);
        try {
          const sessions = await client.session.list({ query: { directory } });
          for (const s of sessions?.data ?? []) {
            await client.session.promptAsync({
              path: { id: s.id },
              body: { parts: [{ type: 'text', text }] },
            });
          }
        } catch (e) {
          log(`injection failed: ${e.message}`);
        }
      },
    });
    log(`watching board ${cfg.board} for ${cfg.agentId} (${cfg.server})`);
    watcher.run().catch((e) => log(`watcher stopped: ${e.message}`));
  };

  const resolver = new LazyResolver({
    resolve: () => resolveConfig(directory),
    onChange: (cfg) => {
      stopWatcher();
      if (cfg) {
        if (!cfg.board) {
          log('no board configured (set AB_BOARD or join a board) — watcher idle, will re-resolve');
          return;
        }
        startWatcher(cfg);
      } else {
        log('no board config (env, .agentboard.json, or global config) — plugin inert, will re-resolve');
      }
    },
    onLog: log,
    intervalMs,
  });

  return {
    resolver,
    start: () => resolver.start(),
    stop: () => {
      resolver.stop();
      stopWatcher();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Board watcher: calls `onMail(message)` for every new message addressed to
 * the watched identity. Never claims/acks (identity-less observability GET).
 */
export class BoardWatcher {
  constructor({ server, token, board, forId, fetchImpl = fetch, onMail, onLog = () => {}, pollMs = 5000 }) {
    this.server = server.replace(/\/$/, '');
    this.token = token;
    this.board = board;
    this.forId = forId;
    this.fetch = fetchImpl;
    this.onMail = onMail;
    this.onLog = onLog;
    this.pollMs = pollMs;
    this.roles = [];
    this.head = 0;
    this.primed = false;
    this.seen = new Set();
    this._abort = null;
  }

  async api(path) {
    const res = await this.fetch(`${this.server}${path}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return res.json();
  }

  async loadRoles() {
    try {
      const dir = await this.api('/v1/agents');
      const me = (dir.agents ?? []).find((a) => a.agentId === this.forId);
      this.roles = me?.roles ?? [];
    } catch {
      this.roles = []; // agent:<id> mail still matches
    }
  }

  async refresh() {
    const data = await this.api(`/v1/boards/${encodeURIComponent(this.board)}/messages?since=${this.head}`);
    for (const m of data.messages ?? []) {
      if (m.seq <= this.head || this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      if (this.primed && addressedTo(m, this.forId, this.roles)) {
        this.onLog(`[agentboard-wake] ${m.id} #${m.seq} ${m.from} -> ${m.to} [${m.type}]`);
        await this.onMail(m);
      }
    }
    if (typeof data.cursor === 'number' && data.cursor > this.head) this.head = data.cursor;
    this.primed = true;
    return this.head;
  }

  /**
   * Blocking until stop(): the poll loop ALWAYS runs (deterministic), and the
   * dashboard SSE stream is a fire-and-forget ACCELERATOR on top — instant
   * wake when it works, never a blocker (Bun's fetch can buffer streams, so
   * a hung SSE connection must not starve the fallback). Dedupe is by message
   * id + head cursor, so concurrent refreshes cannot double-fire.
   */
  async run() {
    await this.loadRoles().catch(() => {});
    await this.refresh(); // prime the head — pre-existing mail never fires

    this._abort = new AbortController();
    this.trySse().catch(() => {});
    while (!this._abort.signal.aborted) {
      await sleep(this.pollMs);
      await this.refresh().catch((e) => this.onLog(`[agentboard-wake] refresh failed: ${e.message}`));
    }
  }

  async trySse() {
    const streamUrl = `${this.server}/v1/events?board=${encodeURIComponent(this.board)}&token=${encodeURIComponent(this.token)}`;
    const res = await this.fetch(streamUrl, { signal: this._abort.signal });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (chunk.split('\n').some((l) => l.startsWith('event: message'))) {
          await this.refresh().catch((e) => this.onLog(`[agentboard-wake] refresh failed: ${e.message}`));
        }
      }
    }
  }

  stop() {
    this._abort?.abort();
  }
}