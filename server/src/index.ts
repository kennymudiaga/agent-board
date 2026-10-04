import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.AB_DB_PATH ?? resolve('data', 'agentboard.db');
// Sprint 8 T1 (#83): the initial workspace id + token mirror createApp's
// defaults (AB_WORKSPACE -> 'default', AB_TOKEN -> 'dev-token') so the
// bootstrap row always matches the workspace token the server authenticates.
const workspaceId = process.env.AB_WORKSPACE ?? 'default';
const workspaceToken = process.env.AB_TOKEN ?? 'dev-token';

if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

const store = new Store(dbPath);
// Idempotent bootstrap: creates the workspace row (token hashed at rest) if
// missing; never touches an existing row. No single-workspace behavior change.
store.bootstrapWorkspace(workspaceId, workspaceToken, Date.now());
// Sprint 8 T3 (#85): the app scopes every store call to the same workspace
// the bootstrap seeded (AB_WORKSPACE, default 'default'). T2 replaces this
// constant with per-request token resolution.
const app = createApp(store, { token: workspaceToken, workspaceId });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentboard] listening on :${info.port} (db: ${dbPath})`);
});