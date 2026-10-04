import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Store } from '../src/db.js';

function makeStore(): Store {
  return new Store(':memory:');
}

function sha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('workspaces table + bootstrap + token hashing (sprint 8 T1, issue #83)', () => {
  it('the workspaces table exists on a fresh DB (CREATE TABLE IF NOT EXISTS migration)', () => {
    const store = makeStore();
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it('createWorkspace stores a hashed token and is idempotent (never clobbers an existing row)', () => {
    const store = makeStore();
    const now = Date.now();
    const first = store.createWorkspace({ id: 'acme', name: 'Acme', tokenHash: sha256('ws-token-1') }, now);
    expect(first.created).toBe(true);
    expect(first.workspace).toMatchObject({ id: 'acme', name: 'Acme', createdAt: new Date(now).toISOString() });
    expect(first.workspace.tokenHash).toBe(sha256('ws-token-1'));

    // Same id again: row returned untouched — name and token hash survive.
    const again = store.createWorkspace({ id: 'acme', name: 'Renamed', tokenHash: sha256('ws-token-2') }, now + 1);
    expect(again.created).toBe(false);
    expect(again.workspace.name).toBe('Acme');
    expect(again.workspace.tokenHash).toBe(sha256('ws-token-1'));
  });

  it('listWorkspaces returns all rows id-ordered', () => {
    const store = makeStore();
    const now = Date.now();
    store.createWorkspace({ id: 'b', tokenHash: sha256('t-b') }, now);
    store.createWorkspace({ id: 'a', name: 'Alpha', tokenHash: sha256('t-a') }, now);
    const list = store.listWorkspaces();
    expect(list.map((w) => w.id)).toEqual(['a', 'b']);
    expect(list.find((w) => w.id === 'a')?.name).toBe('Alpha');
    expect(list.find((w) => w.id === 'b')?.name).toBe('b'); // name defaults to id
  });

  it('workspaceForToken resolves the SHA-256 hash back to the workspace; unknown tokens are null', () => {
    const store = makeStore();
    store.createWorkspace({ id: 'acme', tokenHash: sha256('ws-token-1') }, Date.now());
    const ws = store.workspaceForToken('ws-token-1');
    expect(ws?.id).toBe('acme');
    expect(store.workspaceForToken('wrong-token')).toBeNull();
    // A workspace without a token never resolves.
    store.createWorkspace({ id: 'naked' }, Date.now());
    expect(store.workspaceForToken('anything')).toBeNull();
  });

  it('revokeWorkspaceToken clears the hash; the row remains but the token stops resolving', () => {
    const store = makeStore();
    store.createWorkspace({ id: 'acme', tokenHash: sha256('ws-token-1') }, Date.now());
    store.revokeWorkspaceToken('acme');
    const ws = store.listWorkspaces().find((w) => w.id === 'acme')!;
    expect(ws.id).toBe('acme');
    expect(ws.tokenHash).toBeNull();
    expect(store.workspaceForToken('ws-token-1')).toBeNull();
  });

  it('bootstrapWorkspace creates the initial row idempotently, hashing AB_TOKEN (plaintext never stored)', () => {
    const store = makeStore();
    const now = Date.now();
    const ws = store.bootstrapWorkspace('default', 'dev-token', now);
    expect(ws).toMatchObject({ id: 'default', name: 'default' });
    expect(ws.tokenHash).toBe(sha256('dev-token'));
    expect(ws.tokenHash).not.toBe('dev-token');

    // Restart with a different token: the existing row is untouched — the
    // configured token only seeds a *missing* workspace (no rotation).
    const again = store.bootstrapWorkspace('default', 'other-token', now + 1);
    expect(again.tokenHash).toBe(sha256('dev-token'));
    expect(store.workspaceForToken('other-token')).toBeNull();
    expect(store.workspaceForToken('dev-token')?.id).toBe('default');
  });

  it('workspaceForToken only matches hashed lookups — a raw token in token_hash never resolves', () => {
    const store = makeStore();
    store.db
      .prepare('INSERT INTO workspaces (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('bad', 'bad', 'plaintext-token', Date.now());
    expect(store.workspaceForToken('plaintext-token')).toBeNull();
  });
});