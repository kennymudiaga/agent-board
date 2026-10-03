/**
 * Wake-on-mail watcher for the extension (sprint 5 T3, docs/wake-on-mail.md
 * tier 3) — vscode-free so it runs under vitest.
 *
 * Polls the board's observability view for mail addressed to the user's
 * agent and calls `onMail` per new matching message. Read-only: never claims,
 * never acks — the woken agent (the user or a headless turn) owns the mail.
 * Dedupe on message id; primes the head so pre-existing mail never fires.
 * The wake-loop guard skips the identity's own messages.
 */
const { fetchBoardState } = require('./board.js');

/** agent:/role: mail to the watched identity, never its own. */
function addressedTo(m, forId, roles) {
  if (m.from === forId) return false;
  if (m.to === `agent:${forId}`) return true;
  return m.to.startsWith('role:') && roles.includes(m.to.slice('role:'.length));
}

/** Notification text: sender, thread ref, preview. */
function mailText(m) {
  const payload = m.payload && typeof m.payload.text === 'string' ? m.payload.text : JSON.stringify(m.payload ?? null);
  const preview = payload.length > 140 ? `${payload.slice(0, 140)}…` : payload;
  return `${m.from} → ${m.to} [${m.type}]${m.replyTo ? ` (re: ${m.replyTo})` : ''}: ${preview}`;
}

/** Watch for the agent's mail. Returns { close() }. */
function watchMail({ server, board, token, forId }, onMail, { pollMs = 10_000 } = {}) {
  let closed = false;
  let head = 0;
  let primed = false;
  const seen = new Set();
  let roles = [];
  let timer = null;

  const tick = async () => {
    if (closed) return;
    try {
      const view = await fetchBoardState({ server, board, token });
      const me = view.agents.find((a) => a.agentId === forId);
      roles = me?.roles ?? [];
      for (const m of view.messages) {
        if (m.seq <= head || seen.has(m.id)) continue;
        seen.add(m.id);
        if (primed && addressedTo(m, forId, roles)) onMail(m);
      }
      const last = view.messages[view.messages.length - 1];
      if (last && last.seq > head) head = last.seq;
      primed = true;
    } catch {
      /* server unreachable — retry on the next tick */
    }
  };

  tick();
  timer = setInterval(tick, pollMs);

  return {
    close() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = { watchMail, addressedTo, mailText };