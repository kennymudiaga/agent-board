/**
 * AgentBoard board-state helpers — vscode-free so they run under vitest.
 * The extension host calls these; the webview is a dumb renderer.
 * (CommonJS — VS Code extensions load CJS without ceremony.)
 */

async function fetchBoardState({ server, board, token }) {
  const headers = { authorization: `Bearer ${token}` };
  const [agentsRes, mailRes] = await Promise.all([
    fetch(`${server}/v1/agents`, { headers }),
    fetch(`${server}/v1/boards/${encodeURIComponent(board)}/messages`, { headers }),
  ]);
  if (!agentsRes.ok || !mailRes.ok) {
    throw new Error(`board fetch failed (agents HTTP ${agentsRes.status}, messages HTTP ${mailRes.status})`);
  }
  const [agents, mail] = await Promise.all([agentsRes.json(), mailRes.json()]);
  return { agents: agents.agents, messages: mail.messages };
}

/**
 * Watch a board over the SSE stream (v0.2 dashboard endpoint). `onEvent` is
 * called on every message/agent event (the host refetches full state via
 * fetchBoardState), and on 'connect' when a (re)connection succeeds.
 *
 * Reconnects with exponential backoff when the stream drops, so the panel
 * stays live across server restarts and network blips (#21).
 * Returns { close() }.
 */
function watchBoard({ server, board, token }, onEvent, { backoffBaseMs = 1000 } = {}) {
  const url = `${server}/v1/events?board=${encodeURIComponent(board)}&token=${encodeURIComponent(token)}`;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let currentController = null;

  const connect = async () => {
    if (closed) return;
    const controller = new AbortController();
    currentController = controller;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      attempt = 0; // connected — reset backoff
      onEvent('connect');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are blank-line separated; we only need the event names.
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const event = frame.match(/^event: (\w+)/m)?.[1];
          if (event === 'message' || event === 'agent') onEvent(event);
        }
      }
    } catch {
      /* stream dropped — fall through to reconnect */
    }
    // Schedule a reconnect with backoff (1s, 2s, 4s, ... capped at 30s).
    if (!closed) {
      const delay = Math.min(backoffBaseMs * 2 ** attempt, 30_000);
      attempt++;
      retryTimer = setTimeout(connect, delay);
    }
  };

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (currentController) currentController.abort(); // end the in-flight stream
    },
  };
}

function formatAgent(a) {
  return `${a.agentId} [${a.presence}] ${a.status}${a.currentTask ? ` — ${a.currentTask}` : ''}`;
}

function formatMessage(m) {
  const payload = typeof m.payload === 'string' ? m.payload : JSON.stringify(m.payload);
  return `${m.id} #${m.seq} ${m.from} -> ${m.to} [${m.type}] ${payload} (${m.state})`;
}

module.exports = { fetchBoardState, watchBoard, formatAgent, formatMessage };