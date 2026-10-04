import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/db.js';

/**
 * Sprint 8 T3 (issue #85): store scoping + workspace_id migration + indexes.
 * Design authority: docs/multi-workspace.md §5/§7.
 */

/** The pre-v0.4 single-workspace schema (as shipped through v0.3.1). */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  name       TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  provider     TEXT,
  roles        TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  boards       TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'idle',
  current_task TEXT,
  interval     INTEGER NOT NULL DEFAULT 60,
  last_seen    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  token_hash   TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  board            TEXT NOT NULL,
  seq              INTEGER NOT NULL UNIQUE,
  from_agent       TEXT NOT NULL,
  to_kind          TEXT NOT NULL,
  to_value         TEXT,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  priority         TEXT NOT NULL DEFAULT 'normal',
  ttl              INTEGER,
  deadline         INTEGER,
  late             INTEGER NOT NULL DEFAULT 0,
  idempotency_key  TEXT,
  reply_to         TEXT,
  state            TEXT NOT NULL DEFAULT 'pending',
  attempts         INTEGER NOT NULL DEFAULT 0,
  claim_agent      TEXT,
  lease_expires_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_board_seq ON messages(board, seq);
CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem
  ON messages(from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS deliveries (
  message_id       TEXT NOT NULL,
  reader_id        TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  claim_agent      TEXT,
  lease_expires_at INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (message_id, reader_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_reader ON deliveries(reader_id, state);
CREATE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(message_id);
`;

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ab-ws3-'));
  return join(dir, 'legacy.db');
}

interface TableInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnsOf(db: Database.Database, table: string): TableInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfo[];
}

function indexNames(db: Database.Database): Set<string> {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'").all() as { name: string }[]).map((r) => r.name),
  );
}

describe('workspace_id migration + indexes (sprint 8 T3, issue #85)', () => {
  it('migrates an existing (legacy) database additively: columns added, all rows land in default', () => {
    const path = tempDbPath();
    const raw = new Database(path);
    raw.exec(LEGACY_SCHEMA);
    const now = Date.now();
    // Seed the legacy DB like the live dogfood copy (73 messages / 4 boards /
    // 14 agents / 47 deliveries class) so the migration runs on real data.
    for (const b of ['board-a', 'board-b', 'board-c', 'board-d']) {
      raw.prepare('INSERT INTO boards (name, created_at) VALUES (?, ?)').run(b, now);
    }
    const insAgent = raw.prepare(
      'INSERT INTO agents (id, provider, roles, capabilities, boards, status, interval, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, 60, ?, ?)',
    );
    for (let i = 0; i < 14; i++) insAgent.run(`agent-${String(i).padStart(2, '0')}`, 'test', '["dev"]', '[]', '["board-a"]', 'idle', now, now);
    const insMsg = raw.prepare(
      `INSERT INTO messages (id, board, seq, from_agent, to_kind, to_value, type, payload, priority, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'agent', ?, 'note', '{}', 'normal', 'pending', ?, ?)`,
    );
    for (let i = 1; i <= 73; i++) {
      const id = `msg_legacy${String(i).padStart(4, '0')}`;
      insMsg.run(id, `board-${'abcd'[(i - 1) % 4]}`, i, 'agent-00', 'agent-01', now, now);
    }
    for (let i = 1; i <= 47; i++) {
      raw
        .prepare('INSERT INTO deliveries (message_id, reader_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(`msg_legacy${String(((i - 1) % 73) + 1).padStart(4, '0')}`, `agent-${String((i - 1) % 14).padStart(2, '0')}`, 'pending', now, now);
    }
    raw.close();

    // Opening the Store runs the lightweight migration on the legacy file.
    const t0 = Date.now();
    const store = new Store(path);
    const durationMs = Date.now() - t0;

    // Columns exist with the 'default' default.
    for (const table of ['boards', 'agents', 'messages']) {
      const ws = columnsOf(store.db, table).find((c) => c.name === 'workspace_id');
      expect(ws, `workspace_id column on ${table}`).toBeDefined();
      expect(ws?.type).toBe('TEXT');
      expect(ws?.notnull).toBe(1);
      expect(ws?.dflt_value).toBe("'default'");
    }
    // Every migrated row landed in 'default' — back-compat is automatic.
    for (const table of ['boards', 'agents', 'messages']) {
      const nonDefault = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id != 'default'`)
        .get() as { n: number };
      expect(nonDefault.n).toBe(0);
    }
    // The scoped methods see the legacy data unchanged (workspace 'default').
    expect(store.listBoards('default').map((b) => b.name).sort()).toEqual(['board-a', 'board-b', 'board-c', 'board-d']);
    expect(store.listBoards('default').find((b) => b.name === 'board-a')?.messageCount).toBe(19); // 73 % 4 pattern
    expect(store.getAgent('default', 'agent-00', Date.now())?.agentId).toBe('agent-00');
    expect(store.boardExists('default', 'board-a')).toBe(true);
    expect(store.boardExists('other-ws', 'board-a')).toBe(false);
    expect(
      store.listMessages('default', 'board-a', 0, undefined, Date.now()).map((m) => m.id).length,
    ).toBe(19);

    // The measured migration is a few ms on this size — generous CI bound.
    expect(durationMs).toBeLessThan(2000);
    store.close();
    rmSync(join(path, '..'), { recursive: true, force: true });
  });

  it('creates the workspace lookup indexes (fresh DB)', () => {
    const store = new Store(':memory:');
    const idx = indexNames(store.db);
    expect(idx.has('idx_messages_ws_board_seq')).toBe(true);
    expect(idx.has('idx_boards_ws_name')).toBe(true);
    expect(idx.has('idx_agents_ws_id')).toBe(true);
    expect(idx.has('idx_messages_idem')).toBe(true);
    // The workspace-scoped idempotency index is the composite one.
    const idem = store.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_idem'")
      .get() as { sql: string };
    expect(idem.sql).toContain('workspace_id');
  });

  it('fresh-DB schema keys boards and agents per workspace (same names, both workspaces)', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    // Two workspaces may host a board with the same name.
    const infoA = store.db
      .prepare('INSERT OR IGNORE INTO boards (workspace_id, name, created_at) VALUES (?, ?, ?)')
      .run('acme', 'team-a', now);
    const infoB = store.db
      .prepare('INSERT OR IGNORE INTO boards (workspace_id, name, created_at) VALUES (?, ?, ?)')
      .run('globex', 'team-a', now);
    expect(infoA.changes).toBe(1);
    expect(infoB.changes).toBe(1);
    // And the same agent id may exist in both workspaces.
    store.upsertAgent('acme', { agentId: 'dev-1', boards: ['team-a'] }, now);
    store.upsertAgent('globex', { agentId: 'dev-1', boards: ['team-a'] }, now);
    expect(store.getAgent('acme', 'dev-1', now)?.agentId).toBe('dev-1');
    expect(store.getAgent('globex', 'dev-1', now)?.agentId).toBe('dev-1');
  });
});

describe('store scoping (sprint 8 T3, issue #85)', () => {
  it('isolates boards, agents, and messages between workspaces with identical names', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    // Identical board names + identical agent ids in two workspaces.
    store.upsertAgent('acme', { agentId: 'dev-1', roles: ['dev'], boards: ['team-a'] }, now);
    store.upsertAgent('globex', { agentId: 'dev-1', roles: ['dev'], boards: ['team-a'] }, now);

    const a = store.insertMessage('acme', {
      board: 'team-a',
      from: 'dev-1',
      toKind: 'agent',
      toValue: 'dev-1',
      type: 'request',
      payload: { text: 'acme task' },
      priority: 'normal',
      ttl: null,
      deadline: null,
      idempotencyKey: 'k-1',
      replyTo: null,
    }, now);
    expect('message' in a).toBe(true);
    const b = store.insertMessage('globex', {
      board: 'team-a',
      from: 'dev-1',
      toKind: 'agent',
      toValue: 'dev-1',
      type: 'request',
      payload: { text: 'globex task' },
      priority: 'normal',
      ttl: null,
      deadline: null,
      idempotencyKey: 'k-1', // same sender + same key, different workspace — NOT a duplicate
      replyTo: null,
    }, now);
    expect('message' in b).toBe(true);

    // Pickup is workspace-scoped: each side only ever sees its own mail.
    const acmePickup = store.claimMessages('acme', 'team-a', 'dev-1', 0, now);
    expect(acmePickup).toHaveLength(1);
    expect((acmePickup[0].payload as { text: string }).text).toBe('acme task');
    const globexPickup = store.claimMessages('globex', 'team-a', 'dev-1', 0, now);
    expect(globexPickup).toHaveLength(1);
    expect((globexPickup[0].payload as { text: string }).text).toBe('globex task');

    // Board directory and presence are scoped too.
    expect(store.listBoards('acme').map((x) => x.name)).toEqual(['team-a']);
    expect(store.listBoards('globex').map((x) => x.name)).toEqual(['team-a']);
    expect(store.listAgents('acme', {}, now)).toHaveLength(1);
    expect(store.listAgents('globex', {}, now)).toHaveLength(1);

    // id-based lookups are cross-workspace invisible (isolated, no leaks).
    const acmeMsg = ('message' in a ? a.message : undefined)!;
    expect(store.getMessage('acme', acmeMsg.id)?.id).toBe(acmeMsg.id);
    expect(store.getMessage('globex', acmeMsg.id)).toBeUndefined();
    // ack/requeue/delete against the wrong workspace = not found.
    expect(store.ackMessage('globex', acmeMsg.id, 'dev-1', 'done', null, now)).toEqual({ notFound: true });
    expect(store.deleteMessage('globex', acmeMsg.id, 'dev-1')).toEqual({ notFound: true });

    // Deliveries inherit their message's workspace via the join: a broadcast
    // only fans out to members of the SAME workspace.
    store.insertMessage('acme', {
      board: 'team-a',
      from: 'dev-1',
      toKind: 'broadcast',
      toValue: null,
      type: 'note',
      payload: { text: 'acme broadcast' },
      priority: 'normal',
      ttl: null,
      deadline: null,
      idempotencyKey: null,
      replyTo: null,
    }, now);
    const globexMsgs = store.listMessages('globex', 'team-a', 0, undefined, now);
    const acmeMsgs = store.listMessages('acme', 'team-a', 0, undefined, now);
    expect(globexMsgs).toHaveLength(1); // only the globex request — no acme broadcast
    expect(acmeMsgs).toHaveLength(2); // request + broadcast
  });

  it('scopes role addressing and readers to the workspace', () => {
    const store = new Store(':memory:');
    const now = Date.now();
    store.upsertAgent('acme', { agentId: 'qa-1', roles: ['qa'], boards: ['team-a'] }, now);
    // Same agent id, different workspace, DIFFERENT roles — must not see acme's mail.
    store.upsertAgent('globex', { agentId: 'qa-1', roles: ['ops'], boards: ['team-a'] }, now);

    store.insertMessage('acme', {
      board: 'team-a',
      from: 'dev-9',
      toKind: 'role',
      toValue: 'qa',
      type: 'request',
      payload: { text: 'for qa only' },
      priority: 'normal',
      ttl: null,
      deadline: null,
      idempotencyKey: null,
      replyTo: null,
    }, now);

    // acme's qa-1 claims it (role qa), globex's qa-1 does not (role ops).
    expect(store.claimMessages('acme', 'team-a', 'qa-1', 0, now)).toHaveLength(1);
    const globexPickup = store.claimMessages('globex', 'team-a', 'qa-1', 0, now);
    expect(globexPickup).toHaveLength(0);
  });
});