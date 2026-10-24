/**
 * agentboard-wake — opencode plugin (sprint 5 T2, docs/wake-on-mail.md tier 1;
 * sprint 9 T1, issue #101 — lazy binding + global-config fallback;
 * sprint 11 T1, issue #117 — session-scoped wake, no project-wide echo).
 *
 * Wakes the opencode session that should act when AgentBoard mail addressed to
 * this identity arrives: a background BoardWatcher (wake-core.js, mirror of
 * `ab watch`) long-polls the board, and each matching message is injected into
 * exactly ONE session via `client.session.promptAsync(...)` — recipient marker,
 * message id, board, thread refs, sender, and text. The agent loop then acts on
 * it (pick up, work, reply, ack — docs/conventions.md §5).
 *
 * Why one session (#117): the plugin API is server/project-scoped, not
 * per-session — `PluginInput` carries `client, project, worktree, directory,
 * experimental_workspace, serverUrl, $` and NO session id (probe, opencode
 * 1.18.9; docs/wake-on-mail.md §7.1). `client.session.list()` returns every
 * session of the project, sender included, so the old fan-out woke the sender
 * with its own outgoing mail. We therefore track only sessions this process
 * observes through its own hooks (`session.created` / `session.updated` /
 * `chat.message`) — another process's session (the usual sender) never enters
 * that set — and inject only when exactly one candidate remains. Several live
 * sessions in one process are ambiguous: skip with a warning (a wrong wake is
 * worse than a missed one) or pin one with `AB_WAKE_SESSION`.
 *
 * Config (mirrors cli/src/config.js precedence, re-resolved lazily):
 *   env AB_SERVER/AB_TOKEN/AB_AGENT_ID/AB_BOARD → workspace `.agentboard.json`
 *   → machine-wide global config (`ab init --global`, #41); `AB_WAKE_SESSION`
 *   optionally pins the injection target.
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
 * Do NOT call client APIs while the plugin factory runs — the server is still
 * booting and the call blocks indefinitely (observed: session.list at load
 * hung `opencode run` past 5 minutes; §7.1).
 */

import { createWakeController, wakeResolveMs } from '../lib/wake-core.js';

export const agentboardWake = async (input) => {
  const { client, directory } = input;
  console.log('[agentboard-wake] plugin loading');
  const log = (message) => {
    console.log(`[agentboard-wake] ${message}`);
    client.app
      .log({ body: { service: 'agentboard-wake', level: 'info', message } })
      .catch(() => {});
  };

  // Lazy binding (#101): re-resolve on a ~5s loop (AB_WAKE_RESOLVE_MS — NaN-
  // coerced, #110 follow-up: a non-numeric value must fall back, not spin).
  const controller = createWakeController({
    client,
    directory,
    log,
    intervalMs: wakeResolveMs(),
  });
  controller.start();
  return {
    // Sessions are only "live" for wake purposes if THIS process saw them —
    // that is the sender-isolation guarantee (#117). Event payloads carry
    // `properties.sessionID` (verified against opencode 1.18.9).
    event: async ({ event }) => {
      const id = event?.properties?.sessionID;
      if (id && (event.type?.startsWith('session.') || event.type?.startsWith('message.'))) {
        controller.noteSession(id);
      }
    },
    // First user turn of an existing (restored) session: same bookkeeping.
    'chat.message': async (hookInput) => {
      controller.noteSession(hookInput?.sessionID);
    },
  };
};
