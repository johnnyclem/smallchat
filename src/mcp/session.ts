/**
 * SessionManager — SQLite-backed stateful MCP session lifecycle.
 *
 * Sessions are identified by UUIDv4, conveyed via the MCP-Session-Id header.
 * Default TTL: 24h.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { McpSession, McpClientCapabilities, SessionStatus } from './types.js';

export type ResumeResult = McpSession | 'expired' | 'not_found' | 'closed';

export interface CreateSessionParams {
  clientName: string;
  clientVersion: string;
  selectedVersion: string;
  capabilities: McpClientCapabilities;
  ttlMs: number;
}

export class SessionManager {
  private db: Database.Database;
  private janitorHandle: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sessionId       TEXT PRIMARY KEY,
        status          TEXT NOT NULL DEFAULT 'active',
        createdAt       TEXT NOT NULL,
        lastSeenAt      TEXT NOT NULL,
        expiresAt       TEXT NOT NULL,
        clientName      TEXT NOT NULL,
        clientVersion   TEXT NOT NULL,
        selectedVersion TEXT NOT NULL,
        capabilities    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        subscriptionId TEXT PRIMARY KEY,
        sessionId      TEXT NOT NULL,
        resourceId     TEXT NOT NULL,
        UNIQUE(sessionId, resourceId),
        FOREIGN KEY (sessionId) REFERENCES sessions(sessionId)
      );
    `);
  }

  create(params: CreateSessionParams): McpSession {
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.ttlMs);

    const session: McpSession = {
      sessionId,
      status: 'active',
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      clientName: params.clientName,
      clientVersion: params.clientVersion,
      selectedVersion: params.selectedVersion,
      capabilities: params.capabilities,
    };

    this.db
      .prepare(
        `INSERT INTO sessions
         (sessionId, status, createdAt, lastSeenAt, expiresAt, clientName, clientVersion, selectedVersion, capabilities)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.sessionId,
        session.status,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.clientName,
        session.clientVersion,
        session.selectedVersion,
        JSON.stringify(session.capabilities),
      );

    return session;
  }

  resume(sessionId: string): ResumeResult {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE sessionId = ?')
      .get(sessionId) as DbSession | undefined;

    if (!row) return 'not_found';

    const session = rowToSession(row);

    if (session.status === 'closed') return 'closed';

    if (new Date(session.expiresAt) <= new Date()) {
      this.db
        .prepare("UPDATE sessions SET status = 'closed' WHERE sessionId = ?")
        .run(sessionId);
      return 'expired';
    }

    this.touch(sessionId);
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  touch(sessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET lastSeenAt = ? WHERE sessionId = ?')
      .run(new Date().toISOString(), sessionId);
  }

  close(sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET status = 'closed' WHERE sessionId = ?")
      .run(sessionId);
    this.db
      .prepare('DELETE FROM subscriptions WHERE sessionId = ?')
      .run(sessionId);
  }

  get(sessionId: string): McpSession | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE sessionId = ?')
      .get(sessionId) as DbSession | undefined;
    return row ? rowToSession(row) : null;
  }

  /**
   * Subscribe a session to a resource. Idempotent — returns the same
   * subscriptionId for duplicate (sessionId, resourceId) pairs.
   */
  subscribe(sessionId: string, resourceId: string): string {
    // Deterministic ID: first 16 hex chars of sha256(sessionId+resourceId)
    const subscriptionId = createHash('sha256')
      .update(sessionId + resourceId)
      .digest('hex')
      .slice(0, 16);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO subscriptions (subscriptionId, sessionId, resourceId)
         VALUES (?, ?, ?)`,
      )
      .run(subscriptionId, sessionId, resourceId);

    return subscriptionId;
  }

  unsubscribeAll(sessionId: string): void {
    this.db
      .prepare('DELETE FROM subscriptions WHERE sessionId = ?')
      .run(sessionId);
  }

  getSubscriptions(sessionId: string): string[] {
    const rows = this.db
      .prepare('SELECT resourceId FROM subscriptions WHERE sessionId = ?')
      .all(sessionId) as Array<{ resourceId: string }>;
    return rows.map((r) => r.resourceId);
  }

  /**
   * Background janitor: mark sessions with passed expiresAt as closed.
   * Returns the interval handle so the caller can clear it.
   */
  startJanitor(intervalMs = 60_000): ReturnType<typeof setInterval> {
    const handle = setInterval(() => {
      this.db
        .prepare(
          `UPDATE sessions SET status = 'closed'
           WHERE status = 'active' AND expiresAt <= ?`,
        )
        .run(new Date().toISOString());
    }, intervalMs);
    // Allow Node.js to exit even if the janitor is still running
    if (typeof handle.unref === 'function') handle.unref();
    this.janitorHandle = handle;
    return handle;
  }

  close_db(): void {
    if (this.janitorHandle) {
      clearInterval(this.janitorHandle);
      this.janitorHandle = null;
    }
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DbSession {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  clientName: string;
  clientVersion: string;
  selectedVersion: string;
  capabilities: string; // JSON
}

function rowToSession(row: DbSession): McpSession {
  return {
    sessionId: row.sessionId,
    status: row.status,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    clientName: row.clientName,
    clientVersion: row.clientVersion,
    selectedVersion: row.selectedVersion,
    capabilities: JSON.parse(row.capabilities) as McpClientCapabilities,
  };
}
