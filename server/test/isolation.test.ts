import { describe, it, expect } from 'vitest';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

/**
 * Sprint 8 T4 (issue #86) — the SECURITY GATE acceptance core: cross-workspace
 * isolation at the API/SSE/A2A surface. Design authority:
 * docs/multi-workspace.md §4/§7; docs/sprint-8/plan.md T4.
 *
 * Two workspaces are minted off one server process; both host a board with the
 * SAME name and an agent with the SAME id. Every assertion below proves a
 * leak would be caught: boards/agents/messages/directory/SSE/A2A stay in the
 * caller's workspace; a token can never read, claim, or touch another
 * workspace's mail.
 */

const TOKEN = 'test-token';

interface WsCtx {
  id: string;
  token: string;
}

function makeCtx() {
  const store = new Store(':memory:');
  const app = createApp(store, { token: TOKEN });
  return { store, app };
}

type App = ReturnType<typeof createApp>;

/** Request with an explicit bearer (workspace or agent token). */
function api(app: App, method: string, path: string, opts: { body?: unknown; bearer?: string; agent?: string } = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.bearer ?? TOKEN}`,
    'content-type': 'application/json',
    ...(opts.agent ? { 'x-agent-id': opts.agent } : {}),
  };
  return app.request(path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
}

async function mintWorkspace(app: App, id: string): Promise<WsCtx> {
  const res = await api(app, 'POST', '/v1/workspaces', { body: { id, name: id } });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; token: string };
  return { id: body.id, token: body.token };
}

async function mintAgentToken(app: App, ws: WsCtx, agentId: string): Promise<string> {
  const res = await api(app, 'POST', '/v1/tokens', { bearer: ws.token, body: { agentId } });
  expect(res.status).toBe(201);
  return (await res.json()).token as string;
}

async function heartbeat(app: App, bearer: string, agentId: string, extra: Record<string, unknown> = {}) {
  const res = await api(app, 'POST', '/v1/heartbeat', {
    bearer,
    body: { agentId, interval: 15, status: 'idle', boards: ['team-a'], roles: ['dev'], ...extra },
  });
  return res;
}

/** POST a message as `agent` (workspace tokens need an X-Agent-ID on mutating routes). */
async function send(app: App, bearer: string, board: string, body: Record<string, unknown>, agent = 'dev-1') {
  const res = await api(app, 'POST', `/v1/boards/${board}/messages`, { bearer, agent, body });
  expect(res.status).toBe(201);
  return (await res.json()).message as { id: string };
}

/**
 * Read board messages: with a workspace token (no identity) this is the
 * read-only observability view; with an agent token it is real pickup/claim.
 */
async function pickup(app: App, bearer: string, board: string, since = 0) {
  const res = await api(app, 'GET', `/v1/boards/${board}/messages?since=${since}&wait=0`, { bearer });
  expect(res.status).toBe(200);
  return (await res.json()).messages as { id: string; payload: unknown; state?: string }[];
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

/** Standard two-workspace rig: acme + globex, both with board `team-a` and agent `dev-1`. */
async function twoWsRig(app: App) {
  const acme = await mintWorkspace(app, 'acme');
  const globex = await mintWorkspace(app, 'globex');
  const hbA = await heartbeat(app, acme.token, 'dev-1', { roles: ['dev'] });
  const hbG = await heartbeat(app, globex.token, 'dev-1', { roles: ['dev'] });
  expect(hbA.status).toBe(200);
  expect(hbG.status).toBe(200);
  return { acme, globex };
}

describe('cross-workspace API isolation (sprint 8 T4, issue #86)', () => {
  it('two workspaces with identical board names: no board/agent/message leaks in either direction', async () => {
    const { store, app } = makeCtx();
    const { acme, globex } = await twoWsRig(app);

    // Same board name exists in BOTH workspaces — the point of the test.
    const boardsA = await api(app, 'GET', '/v1/boards', { bearer: acme.token });
    const boardsG = await api(app, 'GET', '/v1/boards', { bearer: globex.token });
    expect((await boardsA.json()).boards.map((b: { name: string }) => b.name)).toEqual(['team-a']);
    expect((await boardsG.json()).boards.map((b: { name: string }) => b.name)).toEqual(['team-a']);

    // acme posts to team-a; globex's team-a must never see it.
    const msgId = (await send(app, acme.token, 'team-a', { to: 'agent:dev-1', type: 'request', payload: { text: 'acme task' } })).id;

    const globexPickup = await pickup(app, globex.token, 'team-a');
    expect(globexPickup).toHaveLength(0); // no leak into globex
    const acmePickup = await pickup(app, acme.token, 'team-a');
    expect(acmePickup).toHaveLength(1);
    expect((acmePickup[0].payload as { text: string }).text).toBe('acme task');
    expect(acmePickup[0].id).toBe(msgId);

    // The reverse direction: a globex message is invisible to acme.
    await send(app, globex.token, 'team-a', { to: 'agent:dev-1', type: 'request', payload: { text: 'globex task' } });
    const acmeView = await api(app, 'GET', '/v1/boards/team-a/messages?since=0', { bearer: acme.token });
    expect((await acmeView.json()).messages).toHaveLength(1); // still only the acme message

    // Directory scoping: each workspace sees exactly its own agent row.
    const agentsA = await api(app, 'GET', '/v1/agents', { bearer: acme.token });
    const agentsG = await api(app, 'GET', '/v1/agents', { bearer: globex.token });
    expect((await agentsA.json()).agents).toHaveLength(1);
    expect((await agentsG.json()).agents).toHaveLength(1);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM agents WHERE id = ?').get('dev-1')).toEqual({ n: 2 }); // distinct rows
  });

  it('the same agent id in two workspaces is a distinct identity: token resolution is per-workspace', async () => {
    const { app } = makeCtx();
    const { acme, globex } = await twoWsRig(app);

    // Mint a per-agent token for 'dev-1' in BOTH workspaces.
    const tokenA = await mintAgentToken(app, acme, 'dev-1');
    const tokenG = await mintAgentToken(app, globex, 'dev-1');

    // Each token registers the SAME id in ITS OWN workspace.
    const hbA = await heartbeat(app, tokenA, 'dev-1');
    const hbG = await heartbeat(app, tokenG, 'dev-1');
    expect(hbA.status).toBe(200);
    expect(hbG.status).toBe(200);
    expect((await hbA.json()).workspaceId).toBe('acme');
    expect((await hbG.json()).workspaceId).toBe('globex');

    // acme's message is claimable only by acme's dev-1 token.
    const msgId = (await send(app, acme.token, 'team-a', { to: 'agent:dev-1', type: 'request', payload: { text: 'for acme dev-1' } })).id;
    expect(await pickup(app, tokenG, 'team-a')).toHaveLength(0); // globex's DEV-1 cannot claim acme mail
    const picked = await pickup(app, tokenA, 'team-a');
    expect(picked).toHaveLength(1);
    expect((picked[0].payload as { text: string }).text).toBe('for acme dev-1');

    // Heartbeats don't clobber across workspaces: each row keeps its own boards/roles.
    const agentsA = await api(app, 'GET', '/v1/agents', { bearer: acme.token });
    expect((await agentsA.json()).agents[0]).toMatchObject({ agentId: 'dev-1', boards: ['team-a'] });
  });

  it('token A can never read, ack, requeue, or purge B\'s mail (cross-workspace 404 on every id route)', async () => {
    const { app } = makeCtx();
    const { acme, globex } = await twoWsRig(app);

    const msgId = (await send(app, acme.token, 'team-a', { to: 'agent:dev-1', type: 'request', payload: { text: 'acme secret' } })).id;
    // Claim it with acme's own per-agent identity so ack is meaningful.
    const tokenA = await mintAgentToken(app, acme, 'dev-1');
    const claimed = await pickup(app, tokenA, 'team-a');
    expect(claimed).toHaveLength(1);
    expect(claimed[0].state).toBe('claimed');

    const g = globex.token;
    // globex's workspace token (with a globex identity) can only reach globex's
    // data: every acme id is invisible (404 — getRow is workspace-scoped).
    expect((await api(app, 'POST', `/v1/messages/${msgId}/ack`, { bearer: g, agent: 'dev-1', body: { status: 'done' } })).status).toBe(404);
    expect((await api(app, 'POST', `/v1/messages/${msgId}/requeue`, { bearer: g, agent: 'dev-1' })).status).toBe(404);
    expect((await api(app, 'DELETE', `/v1/messages/${msgId}`, { bearer: g, agent: 'dev-1' })).status).toBe(404);
    // Same-id agent token from B cannot touch A's message either.
    const tokenG = await mintAgentToken(app, globex, 'dev-1');
    expect((await api(app, 'POST', `/v1/messages/${msgId}/ack`, { bearer: tokenG, body: { status: 'done' } })).status).toBe(404);

    // The message survives untouched (globex never reached it) and is still acked by its real claimer.
    const view = await api(app, 'GET', '/v1/boards/team-a/messages?since=0', { bearer: acme.token });
    const m = (await view.json()).messages.find((x: { id: string }) => x.id === msgId);
    expect(m.state).toBe('claimed');
    expect((await api(app, 'POST', `/v1/messages/${msgId}/ack`, { bearer: tokenA, body: { status: 'done' } })).status).toBe(200);
  });

  it('role addressing and reader identity stay in the workspace (same role name, other ws never sees it)', async () => {
    const { app } = makeCtx();
    const acme = await mintWorkspace(app, 'acme');
    const globex = await mintWorkspace(app, 'globex');
    // Same agent id, same board, DIFFERENT roles per workspace.
    await heartbeat(app, acme.token, 'qa-1', { roles: ['qa'] });
    await heartbeat(app, globex.token, 'qa-1', { roles: ['ops'] });

    const msgId = (await send(app, acme.token, 'team-a', { to: 'role:qa', type: 'request', payload: { text: 'qa only' } }, 'qa-1')).id;

    // globex's qa-1 (role ops) cannot claim a role:qa message in acme's board.
    const tokenG = await mintAgentToken(app, globex, 'qa-1');
    expect(await pickup(app, tokenG, 'team-a')).toHaveLength(0);
    // acme's own qa-1 (per-agent token) claims it.
    const tokenA = await mintAgentToken(app, acme, 'qa-1');
    const picked = await pickup(app, tokenA, 'team-a');
    expect(picked).toHaveLength(1);
    expect(picked[0].id).toBe(msgId);
  });
});

describe('SSE + A2A workspace scoping (sprint 8 T4, issue #86)', () => {
  it('SSE /v1/events streams only the authenticated workspace — a same-named board in B feeds nothing through', async () => {
    const { app } = makeCtx();
    const { acme, globex } = await twoWsRig(app);

    const res = await app.request(`/v1/events?token=${acme.token}&board=team-a`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // hello arrives first.
    const hello = await withTimeout(reader.read(), 2000, null);
    buf += decoder.decode(hello?.value ?? new Uint8Array(0));
    expect(buf).toContain('event: hello');

    // Positive: an acme message (matching board) flows through the stream —
    // proves the workspace+board filter is live and the stream works.
    await send(app, acme.token, 'team-a', { to: 'agent:dev-1', type: 'request', payload: { text: 'acme news' } });
    buf += decoder.decode((await reader.read()).value);
    expect(buf).toContain('event: message');

    // Negative: a globex message on the SAME board name must NOT produce a new
    // stream event for acme's stream (single reader — one outstanding read).
    const lenBefore = buf.length;
    await send(app, globex.token, 'team-a', { to: 'agent:dev-1', type: 'request', payload: { text: 'globex noise' } });
    const leakProbe = await withTimeout(reader.read(), 500, null);
    buf += decoder.decode(leakProbe?.value ?? new Uint8Array(0));
    expect(buf.slice(lenBefore)).not.toContain('event: message');

    await reader.cancel();
  }, 10_000);

  it('A2A relay: tasks are scoped to the caller token\'s workspace — same agent id, other ws sees task not found', async () => {
    const { app } = makeCtx();
    const { acme, globex } = await twoWsRig(app);
    const tokenA = await mintAgentToken(app, acme, 'dev-1');
    const tokenG = await mintAgentToken(app, globex, 'dev-1');

    const a2a = (bearer: string, body: unknown) =>
      api(app, 'POST', '/a2a/dev-1', { bearer, body });

    // acme's dev-1 sends a task into acme's board.
    const sent = await a2a(tokenA, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/send',
      params: { message: { role: 'user', parts: [{ text: 'acme a2a task' }] }, metadata: { board: 'team-a' } },
    });
    expect(sent.status).toBe(200);
    const task = (await sent.json()).result as { id: string; status: { state: string } };
    expect(task.status.state).toBe('submitted');

    // globex's dev-1 (same agent id!) cannot see acme's task.
    const crossGet = await a2a(tokenG, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: task.id } });
    const crossBody = (await crossGet.json()) as { error: { code: number } };
    expect(crossBody.error.code).toBe(-32002); // TASK_NOT_FOUND — invisible cross-workspace

    // acme's own token reads it back fine.
    const ownGet = await a2a(tokenA, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: task.id } });
    const ownBody = (await ownGet.json()) as { result: { id: string } };
    expect(ownBody.result.id).toBe(task.id);

    // And the reverse: a globex task is invisible to acme.
    const sentG = await a2a(tokenG, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tasks/send',
      params: { message: { role: 'user', parts: [{ text: 'globex a2a task' }] }, metadata: { board: 'team-a' } },
    });
    const taskG = (await sentG.json()).result as { id: string };
    const crossGetA = await a2a(tokenA, { jsonrpc: '2.0', id: 5, method: 'tasks/get', params: { id: taskG.id } });
    const crossBodyA = (await crossGetA.json()) as { error: { code: number } };
    expect(crossBodyA.error.code).toBe(-32002);

    // The two tasks live on the same board name but belong to separate workspaces.
    const boardsA = (await (await api(app, 'GET', '/v1/boards', { bearer: acme.token })).json()).boards as { name: string; messageCount: number }[];
    const boardsG = (await (await api(app, 'GET', '/v1/boards', { bearer: globex.token })).json()).boards as { name: string; messageCount: number }[];
    expect(boardsA.find((b) => b.name === 'team-a')?.messageCount).toBe(1);
    expect(boardsG.find((b) => b.name === 'team-a')?.messageCount).toBe(1);
  });
});