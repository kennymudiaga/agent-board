import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * agentboard-wake core (sprint 5 T2, design docs/wake-on-mail.md tier 1).
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

/** Resolve board config: env AB_* first, then the workspace .agentboard.json (read-only). */
export function resolveConfig(directory, env = process.env) {
  const fromEnv = {
    server: env.AB_SERVER,
    token: env.AB_TOKEN,
    agentId: env.AB_AGENT_ID,
    board: env.AB_BOARD,
  };
  if (fromEnv.server && fromEnv.token && fromEnv.agentId) return fromEnv;

  let file = {};
  try {
    file = JSON.parse(readFileSync(join(directory, '.agentboard.json'), 'utf8'));
  } catch {
    return null; // not configured — the plugin stays inert
  }
  if (!file.server || !file.token || !file.agentId) return null;
  return { server: file.server, token: file.token, agentId: file.agentId, board: fromEnv.board ?? file.boards?.[0] };
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