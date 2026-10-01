#!/usr/bin/env node
/**
 * A2A demo client (docs/a2a.md) — dependency-free Node.
 *
 * Discovers the board agent's Agent Card and drives tasks/send -> tasks/get
 * to completion against the reference server's A2A relay. Any A2A client
 * (e.g. the Python A2A SDK) speaks the same JSON-RPC 2.0 surface.
 *
 * env:
 *   A2A_SERVER  default http://localhost:8080
 *   A2A_AGENT   relay agent id (default a2a-1)
 *   A2A_TOKEN   that agent's per-agent token — REQUIRED (mint: ab token --agent-id <id>)
 *   A2A_BOARD   target board (default sprint-8)
 *   A2A_TO      target address (default role:qa)
 *   A2A_TEXT    task text (default "review PR #12")
 */
const SERVER = process.env.A2A_SERVER ?? 'http://localhost:8080';
const AGENT = process.env.A2A_AGENT ?? 'a2a-1';
const TOKEN = process.env.A2A_TOKEN;
const BOARD = process.env.A2A_BOARD ?? 'sprint-8';
const TO = process.env.A2A_TO ?? 'role:qa';
const TEXT = process.env.A2A_TEXT ?? 'review PR #12';

if (!TOKEN) {
  console.error('A2A_TOKEN is required — mint one with: ab token --agent-id <id>');
  process.exit(2);
}

async function rpc(method, params, id) {
  const res = await fetch(`${SERVER}/a2a/${AGENT}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return res.json();
}

// 1. Discover the Agent Card.
const cardRes = await fetch(`${SERVER}/.well-known/agent.json?agent=${AGENT}`);
if (!cardRes.ok) {
  console.error(`card discovery failed (${cardRes.status}): ${await cardRes.text()}`);
  process.exit(1);
}
const card = await cardRes.json();
console.log(`card: ${card.name} — endpoint ${card.endpoints[0].url}`);
console.log(`boards: ${(card.boards ?? []).join(', ') || '(none — pass A2A_BOARD)'}`);

// 2. Send the task (the message id becomes the task id).
const sent = await rpc(
  'tasks/send',
  { message: { role: 'user', parts: [{ text: TEXT }] }, metadata: { board: BOARD, to: TO } },
  1,
);
if (sent.error) {
  console.error(`tasks/send failed: ${sent.error.message}`);
  process.exit(1);
}
const taskId = sent.result.id;
console.log(`task ${taskId} ${sent.result.status.state} — waiting for a board worker… (${TO} on ${BOARD})`);

// 3. Poll tasks/get until the thread settles.
const deadline = Date.now() + 120_000;
let last;
while (Date.now() < deadline) {
  const got = await rpc('tasks/get', { id: taskId }, 2);
  if (got.error) {
    console.error(`tasks/get: ${got.error.message}`);
    process.exit(1);
  }
  last = got.result;
  const note = last.status.message ? ` — ${last.status.message}` : '';
  console.log(`  ${last.status.state}${note}`);
  if (['completed', 'failed', 'canceled'].includes(last.status.state)) break;
  await new Promise((r) => setTimeout(r, 2000));
}

if (!last || !['completed', 'failed', 'canceled'].includes(last.status.state)) {
  console.error('timeout waiting for the task to settle');
  process.exit(1);
}
if (last.artifacts?.length) {
  const result = last.artifacts.map((a) => a.parts.map((p) => p.text).join('')).join('\n');
  console.log(`result: ${result}`);
}
if (last.status.state !== 'completed') process.exit(1);
console.log('demo OK: client saw completed');