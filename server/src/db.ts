import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

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

const SCHEMA = `
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
  created_at   INTEGER NOT NULL
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

function toMessage(r: MessageRow, extras?: { delivery?: DeliveryRecord; deliveries?: DeliveryRecord[] }): MessageRecord {
  return {
    id: r.id,
    board: r.board,
    seq: r.seq,
    from: r.from_agent,
    to: r.to_kind === 'broadcast' ? 'broadcast' : `${r.to_kind}:${r.to_value}`,
    type: r.type as MsgType,
    payload: JSON.parse(r.payload),
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
    ...(extras?.deliveries !== undefined ? { deliveries: extras.deliveries } : {}),
  };
}

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Lightweight migrations for pre-v0.2 databases (CREATE IF NOT EXISTS does
    // not add columns to existing tables).
    this.ensureColumn('messages', 'deadline', 'INTEGER');
    this.ensureColumn('messages', 'late', "INTEGER NOT NULL DEFAULT 0");
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

  // ------------------------------------------------------------------ boards

  boardExists(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM boards WHERE name = ?').get(name) !== undefined;
  }

  /** Read-only board directory (v0.2.1, spec §5.8): every known board + message count. */
  listBoards(): { name: string; createdAt: string; messageCount: number }[] {
    const rows = this.db
      .prepare(
        `SELECT b.name, b.created_at, COUNT(m.id) AS message_count
         FROM boards b LEFT JOIN messages m ON m.board = b.name
         GROUP BY b.name, b.created_at ORDER BY b.name ASC`,
      )
      .all() as { name: string; created_at: number; message_count: number }[];
    return rows.map((r) => ({
      name: r.name,
      createdAt: new Date(r.created_at).toISOString(),
      messageCount: r.message_count,
    }));
  }

  // ------------------------------------------------------------------ agents

  upsertAgent(input: AgentInput, now: number): AgentRecord {
    this.db
      .prepare(
        `INSERT INTO agents (id, provider, roles, capabilities, boards, status, current_task, interval, last_seen, created_at)
         VALUES (@id, @provider, @roles, @capabilities, @boards, @status, @currentTask, @interval, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
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
      this.db.prepare('INSERT OR IGNORE INTO boards (name, created_at) VALUES (?, ?)').run(board, now);
    }
    return this.getAgent(input.agentId, now)!;
  }

  getAgent(id: string, now: number): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    return row ? this.toAgentRecord(row, now) : undefined;
  }

  listAgents(filters: AgentFilters, now: number): AgentRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
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
   * Insert a message. Returns `{ message }` on success or `{ duplicate }`
   * with the original message id when the sender reuses an idempotencyKey.
   */
  insertMessage(
    input: MessageInput,
    now: number,
  ): { message: MessageRecord } | { duplicate: string } {
    const id = `msg_${randomUUID().replaceAll('-', '')}`;
    const tx = this.db.transaction((): { message?: MessageRecord; duplicate?: string } => {
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare('SELECT id FROM messages WHERE from_agent = ? AND idempotency_key = ?')
          .get(input.from, input.idempotencyKey) as { id: string } | undefined;
        if (existing) return { duplicate: existing.id };
      }
      // v0.2: a response to an expired question is accepted and flagged `late`.
      let late = 0;
      if (input.replyTo) {
        const target = this.db
          .prepare('SELECT type, state, deadline FROM messages WHERE id = ?')
          .get(input.replyTo) as { type: string; state: string; deadline: number | null } | undefined;
        if (target && target.type === 'question' && (target.state === 'expired' || (target.deadline !== null && target.deadline < now))) {
          late = 1;
        }
      }
      this.db.prepare('INSERT OR IGNORE INTO boards (name, created_at) VALUES (?, ?)').run(input.board, now);
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages').get() as { seq: number }).seq;
      this.db
        .prepare(
          `INSERT INTO messages
             (id, board, seq, from_agent, to_kind, to_value, type, payload, priority,
              ttl, deadline, late, idempotency_key, reply_to, state, attempts, claim_agent, lease_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?)`,
        )
        .run(
          id, input.board, seq, input.from, input.toKind, input.toValue, input.type,
          JSON.stringify(input.payload), input.priority, input.ttl, input.deadline, late,
          input.idempotencyKey, input.replyTo, now, now,
        );
      // Broadcast fan-out (v0.2): one delivery row per current board member —
      // online or offline; membership is the criterion. Late joiners do not
      // receive past broadcasts (spec §3.2). The sender is a member too.
      if (input.toKind === 'broadcast') {
        const members = this.db
          .prepare('SELECT id FROM agents WHERE EXISTS (SELECT 1 FROM json_each(agents.boards) WHERE value = ?)')
          .all(input.board) as { id: string }[];
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
      return { message: toMessage(this.getRow(id)!, { deliveries: this.deliveriesFor(id) }) };
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
  claimMessages(board: string, forAgent: string, since: number, now: number): MessageRecord[] {
    const tx = this.db.transaction(() => {
      this.sweep(board, now);
      const rows = this.db
        .prepare(
          `SELECT * FROM messages
           WHERE board = ? AND state = 'pending' AND seq > ?
             AND (
               (to_kind = 'agent' AND to_value = ?)
               OR (to_kind = 'role' AND to_value IN
                     (SELECT value FROM json_each((SELECT roles FROM agents WHERE id = ?))))
               OR (to_kind = 'broadcast' AND EXISTS
                     (SELECT 1 FROM deliveries d WHERE d.message_id = messages.id AND d.reader_id = ? AND d.state = 'pending'))
             )
           ORDER BY seq ASC`,
        )
        .all(board, since, forAgent, forAgent, forAgent) as MessageRow[];
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
        toMessage(r, {
          ...(r.to_kind === 'broadcast' ? { delivery: this.deliveryFor(r.id, forAgent)! } : {}),
        }),
      );
    });
    return tx();
  }

  /** Read-only observability view (dashboards, dead-letter inspection). Broadcasts include per-reader deliveries. */
  listMessages(board: string, since: number, status: MsgState | undefined, now: number): MessageRecord[] {
    this.sweep(board, now);
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM messages WHERE board = ? AND seq > ? AND state = ? ORDER BY seq ASC')
          .all(board, since, status) as MessageRow[])
      : (this.db.prepare('SELECT * FROM messages WHERE board = ? AND seq > ? ORDER BY seq ASC').all(board, since) as MessageRow[]);
    return rows.map((r) => toMessage(r, { ...(r.to_kind === 'broadcast' ? { deliveries: this.deliveriesFor(r.id) } : {}) }));
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
  readerWatermark(board: string, reader: string, since: number, now: number): number {
    this.sweep(board, now);
    const minSeq = this.db
      .prepare(
        `SELECT MIN(seq) AS min_seq FROM messages m
         WHERE m.board = ? AND m.seq > ?
           AND (
             (m.to_kind = 'agent' AND m.to_value = ?
               AND m.state IN ('pending','claimed') AND (m.claim_agent IS NULL OR m.claim_agent = ?))
             OR (m.to_kind = 'role' AND m.to_value IN
                   (SELECT value FROM json_each((SELECT roles FROM agents WHERE id = ?)))
               AND m.state IN ('pending','claimed') AND (m.claim_agent IS NULL OR m.claim_agent = ?))
             OR (m.to_kind = 'broadcast' AND EXISTS
                   (SELECT 1 FROM deliveries d WHERE d.message_id = m.id AND d.reader_id = ?
                    AND d.state IN ('pending','claimed')))
           )`,
      )
      .get(board, since, reader, reader, reader, reader, reader) as { min_seq: number | null } | undefined;
    if (minSeq?.min_seq != null) return minSeq.min_seq - 1;
    const maxSeq = this.db
      .prepare('SELECT MAX(seq) AS max_seq FROM messages WHERE board = ?')
      .get(board) as { max_seq: number | null };
    return maxSeq.max_seq ?? since;
  }

  getMessage(id: string): MessageRecord | undefined {
    const row = this.getRow(id);
    return row
      ? toMessage(row, { ...(row.to_kind === 'broadcast' ? { deliveries: this.deliveriesFor(id) } : {}) })
      : undefined;
  }

  /**
   * Ack a claimed message (or, for broadcasts, the caller's delivery).
   * Returns the updated message, `notFound`, or a `conflict` reason
   * (`not_claimer` | `invalid_transition`).
   */
  ackMessage(
    id: string,
    claimer: string,
    status: AckStatus,
    error: string | null,
    now: number,
  ): { message: MessageRecord } | { notFound: true } | { conflict: 'not_claimer' | 'invalid_transition' } {
    const row = this.getRow(id);
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
      this.recomputeMessageState(id, now);
      return { message: toMessage(this.getRow(id)!, { delivery: this.deliveryFor(id, claimer)! }) };
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
    return { message: toMessage(this.getRow(id)!) };
  }

  // ------------------------------------------------------------------ misc

  /**
   * Dead-letter requeue (v0.2, spec §5.7): dead -> pending with attempts reset.
   * Sender-only. Broadcasts reset every reader's delivery. A broadcast with no
   * deliveries at all (posted to a zero-member board) cannot be requeued —
   * there is nothing to redeliver to (409 state_conflict).
   */
  requeueMessage(
    id: string,
    sender: string,
    now: number,
  ): { message: MessageRecord } | { notFound: true } | { forbidden: true } | { wrongState: true } {
    const row = this.getRow(id);
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
      this.recomputeMessageState(id, now);
    } else {
      this.db
        .prepare("UPDATE messages SET state = 'pending', attempts = 0, claim_agent = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(now, id);
    }
    return { message: this.getMessage(id)! };
  }

  /** Delete a message and its deliveries (v0.2, spec §5.7). Sender-only. */
  deleteMessage(id: string, sender: string): { ok: true } | { notFound: true } | { forbidden: true } {
    const row = this.getRow(id);
    if (!row) return { notFound: true };
    if (row.from_agent !== sender) return { forbidden: true };
    this.db.prepare('DELETE FROM deliveries WHERE message_id = ?').run(id);
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return { ok: true };
  }

  private getRow(id: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
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
  private recomputeMessageState(messageId: string, now: number): void {
    const row = this.getRow(messageId);
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
  private sweep(board: string, now: number): void {
    // Non-broadcast message leases.
    this.db
      .prepare(
        `UPDATE messages
         SET state = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
             claim_agent = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE board = ? AND state = 'claimed' AND to_kind != 'broadcast'
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(MAX_ATTEMPTS, now, board, now);
    // Broadcast delivery leases — independent per reader.
    this.db
      .prepare(
        `UPDATE deliveries
         SET state = CASE WHEN attempts >= ? THEN 'dead' ELSE 'pending' END,
             claim_agent = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE message_id IN (SELECT id FROM messages WHERE board = ? AND to_kind = 'broadcast')
           AND state = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
      )
      .run(MAX_ATTEMPTS, now, board, now);
    // TTL / deadline expiry: pending/claimed past ttl (or, for questions, past
    // deadline) -> expired. Applies to whole messages (broadcasts expire all
    // their readers' deliveries at once).
    const expiredIds = this.db
      .prepare(
        `SELECT id FROM messages
         WHERE board = ? AND state IN ('pending','claimed')
           AND (
             (ttl IS NOT NULL AND ttl > 0 AND (created_at + ttl * 1000) < ?)
             OR (type = 'question' AND deadline IS NOT NULL AND deadline < ?)
           )`,
      )
      .all(board, now, now) as { id: string }[];
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
      .prepare("SELECT id FROM messages WHERE board = ? AND to_kind = 'broadcast'")
      .all(board) as { id: string }[];
    for (const b of broadcasts) this.recomputeMessageState(b.id, now);
  }
}