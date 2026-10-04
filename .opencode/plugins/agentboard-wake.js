/**
 * agentboard-wake — opencode plugin (sprint 5 T2, docs/wake-on-mail.md tier 1;
 * sprint 9 T1, issue #101 — lazy binding + global-config fallback).
 *
 * Wakes an opencode session when AgentBoard mail addressed to this identity
 * arrives: a background BoardWatcher (wake-core.js, mirror of `ab watch`)
 * long-polls the board, and each matching message is injected into the live
 * sessions of the project via `client.session.promptAsync(...)` — message id,
 * board, thread refs, sender, and text. The agent loop then acts on it (pick
 * up, work, reply, ack — docs/conventions.md §5).
 *
 * Config (mirrors cli/src/config.js precedence, re-resolved lazily):
 *   env AB_SERVER/AB_TOKEN/AB_AGENT_ID/AB_BOARD → workspace `.agentboard.json`
 *   → machine-wide global config (`ab init --global`, #41).
 *
 * Lazy binding (#101): when no config exists at load the plugin does NOT stay
 * inert forever — a LazyResolver re-resolves every ~5s (AB_WAKE_RESOLVE_MS)
 * and starts/restarts the BoardWatcher only when server/token/agentId/board
 * actually change (restart-guard). So a virgin repo gets wake when `ab init`/
 * `ab join` runs in any terminal — no opencode relaunch, no per-sprint
 * AB_BOARD chore.
 *
 * Safety: read-only observability (never claims/acks on the agent's behalf),
 * dedupe on message id, wake-loop guard (the identity's own mail never
 * fires). Declare the `wake:opencode-session` capability in the heartbeat.
 *
 * Load: auto-discovered from .opencode/plugins/ (project-level). The core
 * lives in .opencode/lib/wake-core.js — NOT in the plugins dir, because the
 * loader invokes every exported function of a plugins-dir module as a plugin.
 */

import { createWakeController } from '../lib/wake-core.js';

export const agentboardWake = async (input) => {
  const { client, directory } = input;
  console.log('[agentboard-wake] plugin loading');
  const log = (message) => {
    console.log(`[agentboard-wake] ${message}`);
    client.app
      .log({ body: { service: 'agentboard-wake', level: 'info', message } })
      .catch(() => {});
  };

  // Lazy binding (#101): re-resolve on a ~5s loop (AB_WAKE_RESOLVE_MS); the
  // watcher starts/restarts only when server/token/agentId/board change.
  const controller = createWakeController({
    client,
    directory,
    log,
    intervalMs: Number(process.env.AB_WAKE_RESOLVE_MS ?? 5000),
  });
  controller.start();
  return {};
};