import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { Store } from './db.js';
import { createApp } from './app.js';
import { payloadCipherFromEnv } from './crypto.js';

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.AB_DB_PATH ?? resolve('data', 'agentboard.db');

if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}

// At-rest payload encryption (sprint 10 T3, #111): opt-in via AB_ENCRYPTION_KEY.
// Unset = the transport-only default (plaintext payloads at rest, byte-identical
// behavior and schema); set = payload cells are AES-256-GCM encrypted on write
// and transparently decrypted on read (see docs/encryption-at-rest.md).
const store = new Store(dbPath, payloadCipherFromEnv());
// createApp bootstraps the initial workspace row idempotently (AB_WORKSPACE +
// AB_TOKEN, token hashed at rest) — single source of truth (sprint 8 T1/T2).
// Route scoping is per-request (sprint 8 T4, #86): the middleware resolves
// the caller's workspace from the bearer (workspace token hash lookup, or the
// agent token's own row) and every store call uses `c.get('workspaceId')`.
const app = createApp(store);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentboard] listening on :${info.port} (db: ${dbPath})`);
});