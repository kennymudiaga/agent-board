import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { makePayloadCipher, type PayloadCipher } from './crypto.js';

/**
 * Storage layer for the AgentBoard reference server.
 * Implements `docs/spec.md` v0.1: entities, message lifecycle
 * (pending -> claimed -> done|failed -> retry -> dead), leases,
 * idempotency, and presence derivation.
 */

export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const LEASE_MS = 5 * 60 * 1000; // 5-minute claim lease
export const MAX_ATTEMPTS = 3; // max total delivery attempts
export const DEFAULT_INTERVAL = 60; // seconds; presence TTL = 3x interval

export type MsgType = 'request' | 'response' | 'question' | 'note' | 'event';
export const MSG_TYPES: MsgType[] = ['request', 'response', 'question', 'note', 'event'];
export type Priority = 'low' | 'normal' | 'high';
export const PRIORITIES: Priority[] = ['low', 'normal', 'high'];
export type MsgState = 'pending' | 'claimed' | 'done' | 'failed' | 'dead' | 'expired';
export const MSG_STATES: MsgState[] = ['pending', 'claimed', 'done', 'failed', 'dead', 'expired'];
export type AgentStatus = 'busy' | 'idle';
export const AGENT_STATUSES: AgentStatus[] = ['busy', 'idle'];

export interface AgentInput {
  agentId: string;
  provider?: string | null;
  roles?: string[];
  capabilities?: string[];
  boards?: string[];
  status?: AgentStatus;
  currentTask?: string | null;
  interval?: number;
}

export interface AgentRecord {
  agentId: string;
  provider: string | null;
  roles: string[];
  capabilities: string[];
  boards: string[];
  status: AgentStatus;
  currentTask: string | null;
  interval: number;
  lastSeen: string;
  createdAt: string;
  presence: 'online' | 'offline';
}

export interface WorkspaceInput {
  id: string;
  name?: string;
  tokenHash?: string | null;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  tokenHash: string | null;
  createdAt: string;
}

export interface MessageInput {
  board: string;
  from: string;
  toKind: 'agent' | 'role' | 'broadcast';
  toValue: string | null;
  type: MsgType;
  payload: unknown;
  priority: Priority;
  ttl: number | null;
  deadline: number | null;
  idempotencyKey: string | null;
  replyTo: string | null;
}

export interface MessageRecord {
  id: string;
  board: string;
  seq: number;
  from: string;
  to: string;
  type: MsgType;
  payload: unknown;
  priority: Priority;
  ttl: number | null;
  /** Question only (v0.2): ISO 8601 UTC deadline, server-validated. */
  deadline: string | null;
  /** Response only (v0.2): true when replying to an expired question. */
  late: boolean;
  idempotencyKey: string | null;
  replyTo: string | null;
  state: MsgState;
  attempts: number;
  claimAgent: string | null;
  leaseExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
  /** Broadcast only: the caller's own per-reader delivery (pickup/ack responses). */
  delivery?: DeliveryRecord;
  /** Broadcast only: all per-reader deliveries (observability responses). */
  deliveries?: DeliveryRecord[];
  /** Broadcast only (observability): read-state aggregate derived from deliveries (sprint 5 T6). */
  reads?: BroadcastReads;
}

export interface DeliveryRecord {
  readerId: string;
  state: MsgState;
  attempts: number;
  claimAgent: string | null;
  leaseExpiresAt: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Broadcast read-state aggregate (sprint 5 T6, spec §6.1): counts of the
 * per-reader deliveries by state, for dashboards ("who has read this").
 * Derived from the copy-per-member deliveries — no protocol rework.
 */
export interface BroadcastReads {
  total: number;
  done: number;
  pending: number;
  claimed: number;
  dead: number;
  expired: number;
}

export interface AgentFilters {
  board?: string;
  role?: string;
  status?: AgentStatus;
}

export type AckStatus = 'claimed' | 'done' | 'failed';

interface MessageRow {
  id: string;
  board: string;
  seq: number;
  from_agent: string;
  to_kind: string;
  to_value: string | null;
  type: string;
  payload: string;
  priority: string;
  ttl: number | null;
  deadline: number | null;
  late: number;
  idempotency_key: string | null;
  reply_to: string | null;
  state: string;
  attempts: number;
  claim_agent: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AgentRow {
  id: string;
  provider: string | null;
  roles: string;
  capabilities: string;
  boards: string;
  status: string;
  current_task: string | null;
  interval: number;
  last_seen: number;
  created_at: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  token_hash: string | null;
  created_at: number;
}

/** PRAGMA table_info row — used to introspect legacy keys for the T4 rebuild. */
interface TableColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

const SCHEMA = `
-- Multi-workspace server (sprint 8, issues #83/#85): every shared table
-- carries workspace_id; boards/agents use composite primary keys so board
-- names and agent ids may repeat across workspaces (isolation boundary).
-- Legacy (pre-v0.4) databases keep their single-column PKs and gain the
-- column via the additive migration in the constructor — rows land in
-- workspace 'default' (back-compat).
CREATE TABLE IF NOT EXISTS boards (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, name)
);

-- Multi-workspace server (sprint 8 T1, issue #83): one row per workspace;
-- the workspace token is stored SHA-256 hashed (same as agent tokens §5.9).
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  workspace_id TEXT NOT NULL DEFAULT 'default',
  id           TEXT NOT NULL,
  provider     TEXT,
  roles        TEXT NOT NULL DEFAULT '[]',
  capabilities TEXT NOT NULL DEFAULT '[]',
  boards       TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'idle',
  current_task TEXT,
  interval     INTEGER NOT NULL DEFAULT 60,
  last_seen    INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  token_hash   TEXT,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL DEFAULT 'default',
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

/**
 * Multi-workspace lookup indexes (sprint 8 T3, issue #85). Created AFTER the
 * additive `workspace_id` migration because legacy databases do not have the
 * column until `ensureColumn` has run (CREATE INDEX inside SCHEMA would fail
 * on them). Fresh databases get the columns from SCHEMA, so the same block
 * works for both. `(workspace_id, board, seq)` serves the hot pickup query;
 * `(workspace_id, name)`/`(workspace_id, id)` serve board/agent lookups
 * (redundant with the composite PKs on fresh DBs, load-bearing on migrated
 * legacy DBs). The idempotency unique index is workspace-scoped here too —
 * agent ids may repeat across workspaces, so `(from_agent, idempotency_key)`
 * alone is no longer globally unique (legacy DBs keep their pre-v0.4 index;
 * single-workspace behavior is unchanged). `workspaces.token_hash` is indexed
 * too (non-blocking, issue #85 note): W2 resolves the bearer token on every
 * request via that hash lookup.
 */
const WORKSPACE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_messages_ws_board_seq ON messages(workspace_id, board, seq);
CREATE INDEX IF NOT EXISTS idx_boards_ws_name ON boards(workspace_id, name);
CREATE INDEX IF NOT EXISTS idx_agents_ws_id ON agents(workspace_id, id);
-- W2 (#84) resolves the bearer on EVERY request via this hash lookup — index it.
CREATE INDEX IF NOT EXISTS idx_workspaces_token_hash ON workspaces(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem
  ON messages(workspace_id, from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

interface DeliveryRow {
  message_id: string;
  reader_id: string;
  state: string;
  claim_agent: string | null;
  lease_expires_at: number | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

function toDelivery(r: DeliveryRow): DeliveryRecord {
  return {
    readerId: r.reader_id,
    state: r.state as MsgState,
    attempts: r.attempts,
    claimAgent: r.claim_agent,
    leaseExpiresAt: r.lease_expires_at,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

function aggregateReads(deliveries: DeliveryRecord[]): BroadcastReads {
  const reads: BroadcastReads = { total: deliveries.length, done: 0, pending: 0, claimed: 0, dead: 0, expired: 0 };
  for (const d of deliveries) {
    if (d.state in reads) reads[d.state as keyof BroadcastReads] += 1;
  }
  return reads;
}

function toMessage(r: MessageRow, cipher: PayloadCipher, extras?: { delivery?: DeliveryRecord; deliveries?: DeliveryRecord[] }): MessageRecord {
  const deliveries = extras?.deliveries;
  return {
    id: r.id,
    board: r.board,
    seq: r.seq,
    from: r.from_agent,
    to: r.to_kind === 'broadcast' ? 'broadcast' : `${r.to_kind}:${r.to_value}`,
    type: r.type as MsgType,
    // At-rest payload decryption (sprint 10 T3, #111): the cipher decrypts
    // `abenc1:` envelopes transparently; plaintext cells (legacy rows, or a
    // deployment without a key) pass through untouched. A missing key on an
    // encrypted envelope throws a clear error from the cipher instead of a
    // JSON.parse crash.
    payload: JSON.parse(cipher.decrypt(r.payload)),
    priority: r.priority as Priority,
    ttl: r.ttl,
    deadline: r.deadline !== null && r.deadline !== undefined ? new Date(r.deadline).toISOString() : null,
    late: r.late === 1,
    idempotencyKey: r.idempotency_key,
    replyTo: r.reply_to,
    state: r.state as MsgState,
    attempts: r.attempts,
    claimAgent: r.claim_agent,
    leaseExpiresAt: r.lease_expires_at,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    ...(extras?.delivery !== undefined ? { delivery: extras.delivery } : {}),
    ...(deliveries !== undefined && r.to_kind === 'broadcast' ? { deliveries, reads: aggregateReads(deliveries) } : {}),
  };
}

export class Store {
  readonly db: Database.Database;
  private readonly cipher: PayloadCipher;

  constructor(path: string, cipher?: PayloadCipher) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    // At-rest payload encryption (sprint 10 T3, #111): the default cipher is
    // the transport-only plaintext pass-through; index.ts injects the
    // AB_ENCRYPTION_KEY-backed cipher when the operator opted in. Encryption
    // and decryption happen at the payload-cell boundary below, so every
    // reader (pickup, observability, replies, A2A relay, dashboard) sees
    // decrypted payloads transparently.
    this.cipher = cipher ?? makePayloadCipher(undefined);
    this.db.exec(SCHEMA);
    // Lightweight migrations for pre-v0.2 databases (CREATE TABLE IF NOT
    // EXISTS does not add columns to existing tables).
    this.ensureColumn('messages', 'deadline', 'INTEGER');
    this.ensureColumn('messages', 'late', "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn('agents', 'token_hash', 'TEXT');
    this.ensureColumn('agents', 'token_expires_at', 'INTEGER');
    // Multi-workspace (sprint 8 T3, #85): additive `workspace_id` column on
    // every shared table — measured 3.9 ms / 0% growth on the live DB copy;
    // all rows land in workspace 'default' (back-compat). Then the workspace
    // indexes (columns must exist before we index them).
    this.ensureColumn('boards', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn('agents', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
    this.ensureColumn('messages', 'workspace_id', "TEXT NOT NULL DEFAULT 'default'");
    // Sprint 8 T4 (#86) hardening (qa-5 findings from the T3 sign-off):
    // 1. Migrated legacy DBs keep single-column primary keys on `boards`
    //    (name) and `agents` (id). Under per-request workspaces, workspace B
    //    registering/upserting the same board name or agent id would silently
    //    hijack workspace A's row (bare ON CONFLICT / INSERT OR IGNORE). Rebuild
    //    both tables onto their workspace-composite keys when the current key
    //    is not already workspace-scoped. `messages` keeps `id` as PK — message
    //    ids are globally unique by construction, no rebuild needed.
    this.rebuildLegacyKeys();
    // 2. Migrated legacy DBs keep the OLD global `(from_agent, idempotency_key)`
    //    unique index under `idx_messages_idem` — a cross-workspace same
    //    (agent, key) pair would 500 post-T4. Drop it so the workspace-scoped
    //    recreate in WORKSPACE_INDEXES wins (safe: all legacy rows are in
    //    'default'; a no-op on fresh DBs where the index does not exist yet).
    this.db.exec('DROP INDEX IF EXISTS idx_messages_idem');
    this.db.exec(WORKSPACE_INDEXES);
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
      // "duplicate column name" — already migrated.
      if (!(e instanceof Error && e.message.includes('duplicate column name'))) throw e;
    }
  }

  /**
   * Sprint 8 T4 (#86), qa-5 hardening (b): rebuild `boards` and `agents` onto
   * workspace-composite primary keys when a migrated legacy database still
   * keys them by name/id alone. Without this, `upsertAgent`'s bare
   * `ON CONFLICT DO UPDATE` and the boards `INSERT OR IGNORE` let workspace B
   * overwrite workspace A's same-named row (roles/boards/status hijacked).
   *
   * The rebuild is a schema change at startup (same class as the additive
   * migration): rename the old table, create the composite-key shape matching
   * the SCHEMA, copy all rows (explicit column list — order-agnostic), drop
   * the old table. Column definitions are introspected from the live schema so
   * the result always matches the migrated state (e.g. `token_expires_at`).
   * Fresh databases are already composite-keyed — skipped.
   */
  private rebuildLegacyKeys(): void {
    for (const table of ['boards', 'agents'] as const) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as TableColumnInfo[];
      const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);
      if (pkCols.includes('workspace_id')) continue; // already composite-keyed
      const colList = cols.map((c) => c.name).join(', ');
      const defs = cols
        .map((c) => {
          let d = `"${c.name}" ${c.type || 'TEXT'}`;
          if (c.notnull) d += ' NOT NULL';
          if (c.dflt_value !== null && c.dflt_value !== undefined) d += ` DEFAULT ${c.dflt_value}`;
          return d;
        })
        .join(',\n    ');
      try {
        this.db.exec(`
          BEGIN;
          ALTER TABLE ${table} RENAME TO ${table}_legacy;
          CREATE TABLE ${table} (
            ${defs},
            PRIMARY KEY (workspace_id, ${pkCols.join(', ')})
          );
          INSERT INTO ${table} (${colList}) SELECT ${colList} FROM ${table}_legacy;
          DROP TABLE ${table}_legacy;
          COMMIT;
        `);
      } catch (e) {
        // A partial rebuild must not leave an open transaction behind.
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  // ------------------------------------------------------------------ boards

  /**
   * Board lookup key is `(workspace_id, board)` (sprint 8 T3, #85): board
   * names may repeat across workspaces, so presence is scoped.
   */
  boardExists(workspaceId: string, name: string): boolean {
    return this.db.prepare('SELECT 1 FROM boards WHERE workspace_id = ? AND name = ?').get(workspaceId, name) !== undefined;
  }

  /** Read-only board directory (v0.2.1, spec §5.8): every known board + message count, workspace-scoped. */
  listBoards(workspaceId: string): { name: string; createdAt: string; messageCount: number }[] {
    const rows = this.db
      .prepare(
        `SELECT b.name, b.created_at, COUNT(m.id) AS message_count
         FROM boards b LEFT JOIN messages m
           ON m.workspace_id = b.workspace_id AND m.board = b.name
         WHERE b.workspace_id = ?
         GROUP BY b.name, b.created_at ORDER BY b.name ASC`,
      )
      .all(workspaceId) as { name: string; created_at: number; message_count: number }[];
    return rows.map((r) => ({
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      messageCount: r.message_count,
    }));
  }

  // ------------------------------------------------------------- workspaces

  private toWorkspace(r: WorkspaceRow): WorkspaceRecord {
    return {
      id: r.id,
      name: r.name,
      tokenHash: r.token_hash,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  public getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return row ? this.toWorkspace(row) : undefined;
  }

  /**
   * Create a workspace row idempotently (sprint 8 T1, #83): INSERT OR IGNORE
   * semantics — an existing row (and its token hash) is never clobbered.
   * Returns the row and whether this call created it.
   */
  createWorkspace(input: WorkspaceInput, now: number): { workspace: WorkspaceRecord; created: boolean } {
    const info = this.db
      .prepare('INSERT OR IGNORE INTO workspaces (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(input.id, input.name ?? input.id, input.tokenHash ?? null, now);
    return { workspace: this.getWorkspace(input.id)!, created: info.changes > 0 };
  }

  /** All workspaces, id-ordered (sprint 8 T1, #83). */
  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY id ASC').all() as WorkspaceRow[];
    return rows.map((r) => this.toWorkspace(r));
  }

  /**
   * Resolve a bearer token to its workspace (sprint 8 T1, #83): SHA-256 hash
   * lookup, mirroring agent-token resolution (§5.9). `null` when no workspace
   * holds this token. Workspace tokens have no expiry in v0.4.
   */
  workspaceForToken(bearer: string): WorkspaceRecord | null {
    const hash = createHash('sha256').update(bearer).digest('hex');
    const row = this.db.prepare('SELECT * FROM workspaces WHERE token_hash = ?').get(hash) as WorkspaceRow | undefined;
    return row ? this.toWorkspace(row) : null;
  }

  /**
   * Workspace of an agent (sprint 8 T2 #84 / T4 #86): reads `workspace_id`
   * from the agent row — the T2 `'default'` stub is gone. NOTE for auth paths:
   * agent ids may repeat across workspaces, so a bare-id lookup is only
   * unambiguous when the id exists in one workspace. Token-bound resolution
   * (middleware, A2A relay) MUST use `tokenAgent(...).workspaceId` — the
   * token's own row is authoritative and never ambiguous.
   */
  workspaceForAgent(agentId: string): string {
    const row = this.db.prepare('SELECT workspace_id FROM agents WHERE id = ?').get(agentId) as
      | { workspace_id: string }
      | undefined;
    return row?.workspace_id ?? 'default';
  }

  /**
   * Mint a workspace token (sprint 8 T2, #84, admin): generates a fresh
   * token, stores its SHA-256 hash, and creates the workspace row. Returns
   * `null` when the id already exists — tokens are never re-minted for an
   * existing workspace (revoke + recreate instead); the plaintext token is
   * shown exactly once.
   */
  mintWorkspaceToken(id: string, name: string, now: number): { token: string; workspace: WorkspaceRecord } | null {
    const token = `abw_${randomBytes(24).toString('hex')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const res = this.createWorkspace({ id, name, tokenHash: hash }, now);
    if (!res.created) return null;
    return { token, workspace: res.workspace };
  }

  /** Revoke a workspace token (sprint 8 T1, #83): clears the stored hash; the row remains. */
  revokeWorkspaceToken(id: string): void {
    this.db.prepare('UPDATE workspaces SET token_hash = NULL WHERE id = ?').run(id);
  }

  /**
   * Startup bootstrap (sprint 8 T1, #83): the initial workspace
   * (`AB_WORKSPACE`, default `default`) + the configured token create the row
   * idempotently if missing. The token is stored SHA-256 hashed — plaintext
   * only ever enters via env/config. An existing row is untouched (no rotation
   * on restart), so a single-workspace deployment behaves exactly as today.
   */
  bootstrapWorkspace(workspaceId: string, token: string, now: number): WorkspaceRecord {
    const hash = createHash('sha256').update(token).digest('hex');
    return this.createWorkspace({ id: workspaceId, tokenHash: hash }, now).workspace;
  }

  // ------------------------------------------------------------------ agents

  /**
   * Register/heartbeat an agent inside a workspace. The upsert targets no
   * explicit conflict column (`ON CONFLICT DO UPDATE`): fresh databases key
   * agents on `(workspace_id, id)` (issue #85) while migrated legacy tables
   * keep `id` as the primary key — a bare-target upsert matches whichever
   * uniqueness constraint the schema defines. Both schemas behave identically
   * for single-workspace deployments.
   */
  upsertAgent(workspaceId: string, input: AgentInput, now: number): AgentRecord {
    this.db
      .prepare(
        `INSERT INTO agents (workspace_id, id, provider, roles, capabilities, boards, status, current_task, interval, last_seen, created_at)
         VALUES (@workspaceId, @id, @provider, @roles, @capabilities, @boards, @status, @currentTask, @interval, @now, @now)
         ON CONFLICT DO UPDATE SET
           provider = excluded.provider,
           roles = excluded.roles,
           capabilities = excluded.capabilities,
           boards = excluded.boards,
           status = excluded.status,
           current_task = excluded.current_task,
           interval = excluded.interval,
           last_seen = excluded.last_seen`,
      )
      .run({
        workspaceId,
        id: input.agentId,
        provider: input.provider ?? null,
        roles: JSON.stringify(input.roles ?? []),
        capabilities: JSON.stringify(input.capabilities ?? []),
        boards: JSON.stringify(input.boards ?? []),
        status: input.status ?? 'idle',
        currentTask: input.currentTask ?? null,
        interval: input.interval ?? DEFAULT_INTERVAL,
        now,
      });
    for (const board of input.boards ?? []) {
      this.db
        .prepare('INSERT OR IGNORE INTO boards (workspace_id, name, created_at) VALUES (?, ?, ?)')
        .run(workspaceId, board, now);
    }
    return this.getAgent(workspaceId, input.agentId, now)!;
  }

  getAgent(workspaceId: string, id: string, now: number): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as AgentRow | undefined;
    return row ? this.toAgentRecord(row, now) : undefined;
  }

  listAgents(workspaceId: string, filters: AgentFilters, now: number): AgentRecord[] {
    const where: string[] = ['workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (filters.board) {
      where.push('EXISTS (SELECT 1 FROM json_each(agents.boards) WHERE value = ?)');
      params.push(filters.board);
    }
    if (filters.role) {
      where.push('EXISTS (SELECT 1 FROM json_each(agents.roles) WHERE value = ?)');
      params.push(filters.role);
    }
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    const sql = `SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all(...params) as AgentRow[];
    return rows.map((r) => this.toAgentRecord(r, now));
  }

  private toAgentRecord(row: AgentRow, now: number): AgentRecord {
    const ttlMs = row.interval * 3 * 1000;
    const presence: 'online' | 'offline' = now - row.last_seen <= ttlMs ? 'online' : 'offline';
    return {
      agentId: row.id,
      provider: row.provider,
      roles: JSON.parse(row.roles),
      capabilities: JSON.parse(row.capabilities),
      boards: JSON.parse(row.boards),
      status: row.status as AgentStatus,
      currentTask: row.current_task,
      interval: row.interval,
      lastSeen: new Date(row.last_seen).toISOString(),
      createdAt: new Date(row.created_at).toISOString(),
      presence,
    };
  }

  // ---------------------------------------------------------------- messages

  /**
   * Insert a message into a workspace. Returns `{ message }` on success or
   * `{ duplicate }` with the original message id when the sender reuses an
   * idempotencyKey. Idempotency is workspace-scoped: agent ids may repeat
   * across workspaces, so the uniqueness key is `(workspace_id, from_agent,
   * idempotency_key)` (issue #85).
   */
  insertMessage(
    workspaceId: string,
    input: MessageInput,
    now: number,
  ): { message: MessageRecord } | { duplicate: string } {
    const id = `msg_${randomUUID().replaceAll('-', '')}`;
    const tx = this.db.transaction((): { message?: MessageRecord; duplicate?: string } => {
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare('SELECT id FROM messages WHERE workspace_id = ? AND from_agent = ? AND idempotency_key = ?')
          .get(workspaceId, input.from, input.idempotencyKey) as { id: string } | undefined;
        if (existing) return { duplicate: existing.id };
      }
      // v0.2: a response to an expired question is accepted and flagged `late`.
      let late = 0;
      if (input.replyTo) {
        const target = this.db
          .prepare('SELECT type, state, deadline FROM messages WHERE id = ? AND workspace_id = ?')
          .get(input.replyTo, workspaceId) as { type: string; state: string; deadline: number | null } | undefined;
        if (target && target.type === 'question' && (target.state === 'expired' || (target.deadline !== null && target.deadline < now))) {
          late = 1;
        }
      }
      this.db
        .prepare('INSERT OR IGNORE INTO boards (workspace_id, name, created_at) VALUES (?, ?, ?)')
        .run(workspaceId, input.board, now);
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages').get() as { seq: number }).seq;
      this.db
        .prepare(
          `INSERT INTO messages
             (id, workspace_id, board, seq, from_agent, to_kind, to_value, type, payload, priority,
              ttl, deadline, late, idempotency_key, reply_to, state, attempts, claim_agent, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
        )
        .run(
          id, workspaceId, input.board, seq, input.from, input.toKind, input.toValue, input.type,
          this.cipher.encrypt(JSON.stringify(input.payload)), input.priority, input.ttl, input.deadline, late,
          input.idempotencyKey, input.replyTo, now, now,
        );
      // Broadcast fan-out (v0.2): one delivery row per current board member —
      // online or offline; membership is the criterion. Late joiners do not
      // receive past broadcasts (spec §3.2). The sender is a member too.
      // Members are scoped to the message's workspace (issue #85).
      if (input.toKind === 'broadcast') {
        const members = this.db
          .prepare(
            `SELECT id FROM agents
             WHERE workspace_id = ?
               AND EXISTS (SELECT 1 FROM json_each(agents.boards) WHERE value = ?)`,
          )
          .all(workspaceId, input.board) as { id: string }[];
        const ins = this.db.prepare(
          `INSERT INTO deliveries (message_id, reader_id, state, attempts, created_at, updated_at)
           VALUES (?, ?, 'pending', 0, ?, ?)`,
        );
        for (const m of members) ins.run(id, m.id, now, now);
        if (members.length === 0) {
          // A broadcast nobody is subscribed to can never be delivered.
          this.db.prepare("UPDATE messages SET state = 'dead', updated_at = ? WHERE id = ?").run(now, id);
        }
      }
      return { message: toMessage(this.getRow(workspaceId, id)!, this.cipher, { deliveries: this.deliveriesFor(id) }) };
    });
    const result = tx();
    if (result.duplicate) return { duplicate: result.duplicate };
    return { message: result.message! };
  }

  /**
   * Pickup: atomically claim matching pending messages (or deliveries, for
   * broadcasts) for `forAgent`. Runs housekeeping (lease expiry, ttl expiry)
   * first. Broadcast responses carry the caller's own `delivery`.
   */
  claimMessages(workspaceId: string, board: string, forAgent: string, since: number, now: number): MessageRecord[] {
    const tx = this.db.transaction(() => {
      this.sweep(workspaceId, board, now);
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE workspace_id = ? AND board = ? AND state = 'pending' AND seq > ?
             AND (
               (to_kind = 'agent' AND to_value = ?)
               OR (to_kind = 'role' AND to_value IN
                     (SELECT value FROM json_each((SELECT roles FROM agents WHERE id = ? AND workspace_id = ?))))
               OR (to_kind = 'broadcast' AND EXISTS
                     (SELECT 1 FROM deliveries d WHERE d.message_id = messages.id AND d.reader_id = ? AND d.state = 'pending'))
             )
           ORDER BY seq ASC`,
        )
        .all(workspaceId, board, since, forAgent, forAgent, workspaceId, forAgent) as MessageRow[];
      if (rows.length === 0) return [];
      const updMsg = this.db.prepare(
        `UPDATE messages SET state = 'claimed', claim_agent = ?, lease_expires_at = ?,
           attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      );
      const updDel = this.db.prepare(
        `UPDATE deliveries SET state = 'claimed', claim_agent = ?, lease_expires_at = ?,
           attempts = attempts + 1, updated_at = ? WHERE message_id = ? AND reader_id = ?`,
      );
      for (const r of rows) {
        if (r.to_kind === 'broadcast') {
          updDel.run(forAgent, now + LEASE_MS, now, r.id, forAgent);
        } else {
          updMsg.run(forAgent, now + LEASE_MS, now, r.id);
        }
      }
      // Re-select so the returned rows carry the fresh claim state.
      const placeholders = rows.map(() => '?').join(',');
      const fresh = this.db
        .prepare(`SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY seq ASC`)
        .all(...rows.map((r) => r.id)) as MessageRow[];
      return fresh.map((r) =>
        toMessage(r, this.cipher, {
          ...(r.to_kind === 'broadcast' ? { delivery: this.deliveryFor(r.id, forAgent)! } : {}),
        }),
      );
    });
    return tx();
  }

  /** Read-only observability view (dashboards, dead-letter inspection). Broadcasts include per-reader deliveries. */
  listMessages(workspaceId: string, board: string, since: number, status: MsgState | undefined, now: number): MessageRecord[] {
    this.sweep(workspaceId, board, now);
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM messages WHERE workspace_id = ? AND board = ? AND seq > ? AND state = ? ORDER BY seq ASC')
          .all(workspaceId, board, since, status) as MessageRow[])
      : (this.db
          .prepare('SELECT * FROM messages WHERE workspace_id = ? AND board = ? AND seq > ? ORDER BY seq ASC')
          .all(workspaceId, board, since) as MessageRow[]);
    return rows.map((r) => toMessage(r, this.cipher, { ...(r.to_kind === 'broadcast' ? { deliveries: this.deliveriesFor(r.id) } : {}) }));
  }

  /**
   * True cursor watermark for a reader (spec §6.2, v0.2): the highest seq S
   * such that every message with `since < seq <= S` is either NOT addressed to
   * the reader or FINALIZED for the reader. Computed from authoritative server
   * state, so a crashed client's claimed-but-unacked messages still block the
   * watermark — a client-side max-over-batch can never skip redeliveries.
   *
   * A message blocks the watermark for the reader when it is addressed to the
   * reader and not finalized for them: pending (they could still claim it) or
   * claimed BY them. Claimed by another reader (role/broadcast race) or any
   * terminal state does not block.
   */
  readerWatermark(workspaceId: string, board: string, reader: string, since: number, now: number): number {
    this.sweep(workspaceId, board, now);
    const minSeq = this.db
      .prepare(
        `SELECT MIN(seq) AS min_seq FROM messages m
         WHERE m.workspace_id = ? AND m.board = ? AND m.seq > ?
           AND (
             (m.to_kind = 'agent' AND m.to_value = ?
               AND m.state IN ('pending','claimed') AND (m.claim_agent IS NULL OR m.claim_agent = ?))
             OR (m.to_kind = 'role' AND m.to_value IN
                   (SELECT value FROM json_each((SELECT roles FROM agents WHERE id = ? AND workspace_id = ?)))
               AND m.state IN ('pending','claimed') AND (m.claim_agent IS NULL OR m.claim_agent = ?))
             OR (m.to_kind = 'broadcast' AND EXISTS
                   (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.reader_id = ?
                    AND d.state IN ('pending','claimed')))
           )`,
      )
      .get(workspaceId, board, since, reader, reader, reader, workspaceId, reader, reader) as { min_seq: number | null } | undefined;
    if (minSeq?.min_seq != null) return minSeq.min_seq - 1;
    const maxSeq = this.db
      .prepare('SELECT MAX(seq) AS max_seq FROM messages WHERE workspace_id = ? AND board = ?')
      .get(workspaceId, board) as { max_seq: number | null };
    return maxSeq.max_seq ?? since;
  }

  getMessage(workspaceId: string, id: string): MessageRecord | undefined {
    const row = this.getRow(workspaceId, id);
    return row
      ? toMessage(row, this.cipher, { ...(row.to_kind === 'broadcast' ? { deliveries: this.deliveriesFor(id) } : {}) })
      : undefined;
  }

  /**
   * Direct replies to a message (thread children), oldest first. Sweeps the
   * board first so callers observe fresh states (used by the A2A relay).
   * Replies are scoped to the parent's workspace (issue #85).
   */
  listReplies(workspaceId: string, messageId: string, now: number): MessageRecord[] {
    const row = this.getRow(workspaceId, messageId);
    if (!row) return [];
    this.sweep(workspaceId, row.board, now);
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE reply_to = ? AND workspace_id = ? ORDER BY seq ASC')
      .all(messageId, workspaceId) as MessageRow[];
    return rows.map((r) => toMessage(r, this.cipher));
  }

  /**
   * Ack a claimed message (or, for broadcasts, the caller's delivery).
   * Returns the updated message, `notFound`, or a `conflict` reason
   * (`not_claimer` | `invalid_transition`).
   */
  ackMessage(
    workspaceId: string,
    id: string,
    claimer: string,
    status: AckStatus,
    error: string | null,
    now: number,
  ): { message: MessageRecord } | { notFound: true } | { conflict: 'not_claimer' | 'invalid_transition' } {
    const row = this.getRow(workspaceId, id);
    if (!row) return { notFound: true };
    if (row.to_kind === 'broadcast') {
      const delivery = this.deliveryFor(id, claimer);
      if (!delivery || delivery.state !== 'claimed' || delivery.claimAgent !== claimer) {
        return { conflict: !delivery || delivery.state !== 'claimed' ? 'invalid_transition' : 'not_claimer' };
      }
      if (status === 'claimed') {
        this.db
          .prepare("UPDATE deliveries SET state = 'claimed', lease_expires_at = ?, updated_at = ? WHERE message_id = ? AND reader_id = ?")
          .run(now + LEASE_MS, now, id, claimer);
      } else if (status === 'done') {
        this.db
          .prepare("UPDATE deliveries SET state = 'done', claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE message_id = ? AND reader_id = ?")
          .run(now, id, claimer);
      } else {
        const nextState = delivery.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
        this.db
          .prepare("UPDATE deliveries SET state = ?, claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE message_id = ? AND reader_id = ?")
          .run(nextState, now, id, claimer);
      }
      this.recomputeMessageState(workspaceId, id, now);
      return { message: toMessage(this.getRow(workspaceId, id)!, this.cipher, { delivery: this.deliveryFor(id, claimer)! }) };
    }
    if (row.state !== 'claimed' || row.claim_agent !== claimer) {
      return { conflict: row.state !== 'claimed' ? 'invalid_transition' : 'not_claimer' };
    }
    if (status === 'claimed') {
      // Lease renewal — claimer stays the same.
      this.db
        .prepare("UPDATE messages SET state = 'claimed', lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(now + LEASE_MS, now, id);
    } else if (status === 'done') {
      this.db
        .prepare("UPDATE messages SET state = 'done', claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, id);
    } else {
      // failed: retry (max MAX_ATTEMPTS) then dead-letter. `error` is recorded in payload history
      // by the client; the row keeps state only.
      const nextState = row.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
      this.db
        .prepare("UPDATE messages SET state = ?, claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(nextState, now, id);
    }
    return { message: toMessage(this.getRow(workspaceId, id)!, this.cipher) };
  }

  // ------------------------------------------------------------------ misc

  /**
   * Per-agent credentials (v0.2.1, spec §5.9; expiry/rotation sprint 5 T5):
   * mint a token bound to one agent. Only the plaintext hash is stored; the
   * token itself is returned once. Admin-only (workspace token). Upserts a
   * minimal agent row when the agent hasn't heartbeated yet (provisioning).
   * Expiry is per-token (the stored hash carries its own expires_at): a mint
   * for an agent that already has a token atomically REPLACES the hash —
   * rotation by construction (the old token dies immediately). Agents are
   * keyed per-workspace (issue #85) — the minted identity is scoped.
   */
  mintToken(workspaceId: string, agentId: string, now: number, ttlDays?: number): { token: string; expiresAt: string | null } {
    const token = `abt_${randomBytes(24).toString('hex')}`;
    const hash = createHash('sha256').update(token).digest('hex');
    const expiresAt = ttlDays !== undefined && ttlDays > 0 ? now + ttlDays * 86_400_000 : null;
    this.db
      .prepare(
        `INSERT INTO agents (workspace_id, id, status, interval, last_seen, created_at, token_hash, token_expires_at)
         VALUES (?, ?, 'idle', 60, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET token_hash = excluded.token_hash, token_expires_at = excluded.token_expires_at`,
      )
      .run(workspaceId, agentId, now, now, hash, expiresAt);
    return { token, expiresAt: expiresAt !== null ? new Date(expiresAt).toISOString() : null };
  }

  /** Revoke an agent's token (admin-only). */
  revokeToken(workspaceId: string, agentId: string): void {
    this.db.prepare('UPDATE agents SET token_hash = NULL, token_expires_at = NULL WHERE workspace_id = ? AND id = ?').run(workspaceId, agentId);
  }

  /**
   * Resolve a bearer token: `null` when no agent holds this hash, otherwise
   * the bound agent, its workspace, and whether its token has expired (sprint
   * 5 T5 — an expired token is distinguishable from a wrong one, so clients
   * get the `token_expired` code instead of a generic 401).
   *
   * The returned `workspaceId` comes from the token's OWN agent row
   * (`agents.workspace_id`, T3 #85) — token hashes are unique per mint, so
   * this resolution is never ambiguous even when the same agent id exists in
   * several workspaces (T4 #86 — the isolation boundary for per-agent tokens).
   */
  tokenAgent(bearer: string, now: number): { agentId: string; workspaceId: string; expired: boolean } | null {
    const hash = createHash('sha256').update(bearer).digest('hex');
    const row = this.db.prepare('SELECT id, workspace_id, token_expires_at FROM agents WHERE token_hash = ?').get(hash) as
      | { id: string; workspace_id: string; token_expires_at: number | null }
      | undefined;
    if (!row) return null;
    return { agentId: row.id, workspaceId: row.workspace_id, expired: row.token_expires_at !== null && row.token_expires_at <= now };
  }

  /**
   * Dead-letter requeue (v0.2, spec §5.7): dead -> pending with attempts reset.
   * Sender-only. Broadcasts reset every reader's delivery. A broadcast with no
   * deliveries at all (posted to a zero-member board) cannot be requeued —
   * there is nothing to redeliver to (409 state_conflict).
   */
  requeueMessage(
    workspaceId: string,
    id: string,
    sender: string,
    now: number,
  ): { message: MessageRecord } | { notFound: true } | { forbidden: true } | { wrongState: true } {
    const row = this.getRow(workspaceId, id);
    if (!row) return { notFound: true };
    if (row.from_agent !== sender) return { forbidden: true };
    if (row.state !== 'dead') return { wrongState: true };
    if (row.to_kind === 'broadcast') {
      const deliveries = this.db
        .prepare('SELECT COUNT(*) AS n FROM deliveries WHERE message_id = ?')
        .get(id) as { n: number };
      if (deliveries.n === 0) return { wrongState: true }; // nothing to requeue to
      this.db
        .prepare("UPDATE deliveries SET state = 'pending', attempts = 0, claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE message_id = ?")
        .run(now, id);
      this.recomputeMessageState(workspaceId, id, now);
    } else {
      this.db
        .prepare("UPDATE messages SET state = 'pending', attempts = 0, claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, id);
    }
    return { message: this.getMessage(workspaceId, id)! };
  }

  /** Delete a message and its deliveries (v0.2, spec §5.7). Sender-only. */
  deleteMessage(workspaceId: string, id: string, sender: string): { ok: true } | { notFound: true } | { forbidden: true } {
    const row = this.getRow(workspaceId, id);
    if (!row) return { notFound: true };
    if (row.from_agent !== sender) return { forbidden: true };
    this.db.prepare('DELETE FROM deliveries WHERE message_id = ?').run(id);
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return { ok: true };
  }

  private getRow(workspaceId: string, id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as MessageRow | undefined;
  }

  private getDeliveryRow(messageId: string, readerId: string): DeliveryRow | undefined {
    return this.db
      .prepare('SELECT * FROM deliveries WHERE message_id = ? AND reader_id = ?')
      .get(messageId, readerId) as DeliveryRow | undefined;
  }

  private deliveryFor(messageId: string, readerId: string): DeliveryRecord | undefined {
    const row = this.getDeliveryRow(messageId, readerId);
    return row ? toDelivery(row) : undefined;
  }

  private deliveriesFor(messageId: string): DeliveryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM deliveries WHERE message_id = ? ORDER BY reader_id ASC')
      .all(messageId) as DeliveryRow[];
    return rows.map(toDelivery);
  }

  /**
   * Broadcast aggregate (spec §6.1): `pending` while any delivery is active,
   * `done` once all are terminal (any done wins over dead/expired), `dead`
   * when all failed, `expired` when all expired. Zero deliveries -> `dead`
   * (a broadcast nobody was subscribed to can never be delivered).
   */
  private recomputeMessageState(workspaceId: string, messageId: string, now: number): void {
    const row = this.getRow(workspaceId, messageId);
    if (!row || row.to_kind !== 'broadcast') return;
    const counts = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM deliveries WHERE message_id = ? GROUP BY state')
      .all(messageId) as { state: string; n: number }[];
    if (counts.length === 0) {
      this.db.prepare("UPDATE messages SET state = 'dead', updated_at = ? WHERE id = ?").run(now, messageId);
      return;
    }
    const byState = new Map(counts.map((c) => [c.state, c.n]));
    const active = (byState.get('pending') ?? 0) + (byState.get('claimed') ?? 0) > 0;
    let state: string;
    if (active) state = 'pending';
    else if ((byState.get('done') ?? 0) > 0) state = 'done';
    else if ((byState.get('dead') ?? 0) > 0) state = 'dead';
    else state = 'expired';
    if (row.state !== state) {
      this.db.prepare('UPDATE messages SET state = ?, updated_at = ? WHERE id = ?').run(state, now, messageId);
    }
  }

  /** Lazy housekeeping: expired leases return to pending (or dead at max attempts); ttl-expired messages die. */
  private sweep(workspaceId: string, board: string, now: number): void {
    // Non-broadcast message leases.
    this.db
      .prepare(
        `UPDATE messages
         SET state = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
             claim_agent = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE workspace_id = ? AND board = ? AND state = 'claimed' AND to_kind != 'broadcast'
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(MAX_ATTEMPTS, now, workspaceId, board, now);
    // Broadcast delivery leases — independent per reader.
    this.db
      .prepare(
        `UPDATE deliveries
         SET state = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
             claim_agent = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE message_id IN (SELECT id FROM messages WHERE workspace_id = ? AND board = ? AND to_kind = 'broadcast')
           AND state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(MAX_ATTEMPTS, now, workspaceId, board, now);
    // TTL / deadline expiry: pending/claimed past ttl (or, for questions, past
    // deadline) -> expired. Applies to whole messages (broadcasts expire all
    // their readers' deliveries at once).
    const expiredIds = this.db
      .prepare(
        `SELECT id FROM messages
         WHERE workspace_id = ? AND board = ? AND state IN ('pending','claimed')
           AND (
             (ttl IS NOT NULL AND ttl > 0 AND (created_at + ttl * 1000) < ?)
             OR (type = 'question' AND deadline IS NOT NULL AND deadline < ?)
           )`,
      )
      .all(workspaceId, board, now, now) as { id: string }[];
    if (expiredIds.length > 0) {
      const ids = expiredIds.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(
          `UPDATE messages SET state = 'expired', claim_agent = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id IN (${placeholders})`,
        )
        .run(now, ...ids);
      this.db
        .prepare(
          `UPDATE deliveries SET state = 'expired', claim_agent = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE message_id IN (${placeholders}) AND state IN ('pending','claimed')`,
        )
        .run(now, ...ids);
    }
    // Recompute broadcast aggregates so message state tracks its deliveries
    // (including broadcasts that just expired — "any done wins" per §6.1).
    const broadcasts = this.db
      .prepare("SELECT id FROM messages WHERE workspace_id = ? AND board = ? AND to_kind = 'broadcast'")
      .all(workspaceId, board) as { id: string }[];
    for (const b of broadcasts) this.recomputeMessageState(workspaceId, b.id, now);
  }
}