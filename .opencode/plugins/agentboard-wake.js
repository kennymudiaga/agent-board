/**
 * agentboard-wake — opencode plugin (sprint 5 T2, docs/wake-on-mail.md tier 1).
 *
 * Wakes an opencode session when AgentBoard mail addressed to this identity
 * arrives: a background BoardWatcher (wake-core.js, mirror of `ab watch`)
 * long-polls the board, and each matching message is injected into the live
 * sessions of the project via `client.session.promptAsync(...)` — message id,
 * board, thread refs, sender, and text. The agent loop then acts on it (pick
 * up, work, reply, ack — docs/conventions.md §5).
 *
 * Config (env wins, else the workspace .agentboard.json, read-only):
 *   AB_SERVER / AB_TOKEN / AB_AGENT_ID / AB_BOARD (optional; default: the
 *   agent's first board from the config file).
 *
 * Safety: read-only observability (never claims/acks on the agent's behalf),
 * dedupe on message id, wake-loop guard (the identity's own mail never
 * fires). Declare the `wake:opencode-session` capability in the heartbeat.
 *
 * Load: auto-discovered from .opencode/plugins/ (project-level). The core
 * lives in .opencode/lib/wake-core.js — NOT in the plugins dir, because the
 * loader invokes every exported function of a plugins-dir module as a plugin.
 */

import { BoardWatcher, buildWakePrompt, resolveConfig } from '../lib/wake-core.js';

export const agentboardWake = async (input) => {
  const { client, directory } = input;
  console.log('[agentboard-wake] plugin loading');
  const log = (message) => {
    console.log(`[agentboard-wake] ${message}`);
    client.app
      .log({ body: { service: 'agentboard-wake', level: 'info', message } })
      .catch(() => {});
  };

  const cfg = resolveConfig(directory);
  if (!cfg || !cfg.board) {
    log('no board config (AB_SERVER/AB_TOKEN/AB_AGENT_ID/AB_BOARD or .agentboard.json) — plugin inert');
    return {};
  }

  const watcher = new BoardWatcher({
    server: cfg.server,
    token: cfg.token,
    board: cfg.board,
    forId: cfg.agentId,
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

  log(`watching board ${cfg.board} for ${cfg.agentId}`);
  watcher.run().catch((e) => log(`watcher stopped: ${e.message}`));
  return {};
};