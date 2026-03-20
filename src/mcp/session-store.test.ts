import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SessionStore } from './session-store.js';

describe('SessionStore', () => {
  let db: Database.Database;
  let store: SessionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = SessionStore.fromDatabase(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
  });

  it('creates a session with UUID', () => {
    const session = store.create();
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.protocolVersion).toBe('2024-11-05');
    expect(session.createdAt).toBeTruthy();
    expect(session.lastActivityAt).toBeTruthy();
  });

  it('creates a session with custom options', () => {
    const session = store.create({
      protocolVersion: '2025-01-01',
      clientInfo: { name: 'test-client', version: '1.0' },
      metadata: { foo: 'bar' },
    });
    expect(session.protocolVersion).toBe('2025-01-01');
    expect(session.clientInfo).toEqual({ name: 'test-client', version: '1.0' });
    expect(session.metadata).toEqual({ foo: 'bar' });
  });

  it('retrieves a session by ID', () => {
    const created = store.create({ clientInfo: { name: 'test' } });
    const retrieved = store.get(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.clientInfo).toEqual({ name: 'test' });
  });

  it('returns null for unknown session ID', () => {
    expect(store.get('nonexistent-id')).toBeNull();
  });

  it('touches a session to update lastActivityAt', async () => {
    const session = store.create();
    const originalActivity = session.lastActivityAt;

    // Small delay to ensure timestamp changes
    await new Promise(r => setTimeout(r, 10));
    store.touch(session.id);

    const updated = store.get(session.id);
    expect(updated!.lastActivityAt).not.toBe(originalActivity);
  });

  it('updates session metadata with merge', () => {
    const session = store.create({ metadata: { a: 1 } });
    store.updateMetadata(session.id, { b: 2 });

    const updated = store.get(session.id);
    expect(updated!.metadata).toEqual({ a: 1, b: 2 });
  });

  it('deletes a session', () => {
    const session = store.create();
    expect(store.delete(session.id)).toBe(true);
    expect(store.get(session.id)).toBeNull();
  });

  it('returns false when deleting non-existent session', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('lists all sessions', () => {
    store.create({ clientInfo: { name: 'a' } });
    store.create({ clientInfo: { name: 'b' } });
    store.create({ clientInfo: { name: 'c' } });

    const sessions = store.list();
    expect(sessions).toHaveLength(3);
  });

  it('counts sessions', () => {
    expect(store.count()).toBe(0);
    store.create();
    store.create();
    expect(store.count()).toBe(2);
  });

  it('prunes old sessions', async () => {
    store.create();
    // All sessions were created "just now", so pruning with 1hr TTL removes nothing
    expect(store.prune(60 * 60 * 1000)).toBe(0);
    expect(store.count()).toBe(1);

    // Prune with 0ms TTL removes everything
    await new Promise(r => setTimeout(r, 10));
    expect(store.prune(1)).toBe(1);
    expect(store.count()).toBe(0);
  });
});
