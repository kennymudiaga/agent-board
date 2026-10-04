import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from './db.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.AB_DB_PATH ?? resolve('data', 'agentboard.db');

if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

const store = new Store(dbPath);
// createApp bootstraps the initial workspace row idempotently (AB_WORKSPACE +
// AB_TOKEN, token hashed at rest) — single source of truth (sprint 8 T1/T2).
const app = createApp(store);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentboard] listening on :${info.port} (db: ${dbPath})`);
});