import { randomUUID } from 'node:crypto';

/**
 * MCPSession — a single client session with metadata.
 *
 * Sessions persist across server restarts via SQLite backing.
 * Each session tracks its creation time, last activity, and
 * client-supplied metadata (protocol version, capabilities, etc.).
 */
export interface MCPSession {
  /** Unique session identifier (UUID v4) */
  id: string;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last-activity timestamp */
  lastActivityAt: string;
  /** Client-reported protocol version */
  protocolVersion: string;
  /** Client info (name, version) from initialize */
  clientInfo: Record<string, unknown>;
  /** Server-side metadata (active subscriptions, scopes, etc.) */
  metadata: Record<string, unknown>;
}

/**
 * SessionStore — SQLite-backed session persistence.
 *
 * Uses the same better-sqlite3 driver the rest of smallchat uses.
 * Sessions survive server restarts and can be resumed by ID.
 */
export class SessionStore {
  private db!: import('better-sqlite3').Database;

  constructor(dbOrPath: string | import('better-sqlite3').Database = 'smallchat.db') {
    if (typeof dbOrPath === 'string') {
      // Synchronous import via createRequire for ESM compatibility
      const { createRequire } = require('node:module') as typeof import('node:module');
      const req = createRequire(import.meta.url);
      const Database = req('better-sqlite3') as typeof import('better-sqlite3');
      this.db = new Database(dbOrPath);
      this.db.pragma('journal_mode = WAL');
    } else {
      this.db = dbOrPath;
    }
    this.init();
  }

  /** Initialize from an already-open database handle */
  static fromDatabase(db: import('better-sqlite3').Database): SessionStore {
    return new SessionStore(db);
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        protocol_version TEXT NOT NULL DEFAULT '2024-11-05',
        client_info TEXT NOT NULL DEFAULT '{}',
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);
  }

  /** Create a new session, returning its ID */
  create(options?: {
    protocolVersion?: string;
    clientInfo?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): MCPSession {
    const now = new Date().toISOString();
    const session: MCPSession = {
      id: randomUUID(),
      createdAt: now,
      lastActivityAt: now,
      protocolVersion: options?.protocolVersion ?? '2024-11-05',
      clientInfo: options?.clientInfo ?? {},
      metadata: options?.metadata ?? {},
    };

    this.db
      .prepare(
        `INSERT INTO mcp_sessions (id, created_at, last_activity_at, protocol_version, client_info, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.createdAt,
        session.lastActivityAt,
        session.protocolVersion,
        JSON.stringify(session.clientInfo),
        JSON.stringify(session.metadata),
      );

    return session;
  }

  /** Get a session by ID, or null if not found */
  get(id: string): MCPSession | null {
    const row = this.db
      .prepare('SELECT * FROM mcp_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;

    if (!row) return null;

    return rowToSession(row);
  }

  /** Touch a session's last-activity timestamp */
  touch(id: string): void {
    this.db
      .prepare('UPDATE mcp_sessions SET last_activity_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  /** Update session metadata (merge) */
  updateMetadata(id: string, metadata: Record<string, unknown>): void {
    const session = this.get(id);
    if (!session) return;

    const merged = { ...session.metadata, ...metadata };
    this.db
      .prepare('UPDATE mcp_sessions SET metadata = ?, last_activity_at = ? WHERE id = ?')
      .run(JSON.stringify(merged), new Date().toISOString(), id);
  }

  /** Delete a session */
  delete(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM mcp_sessions WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  /** List all sessions, optionally filtering by age */
  list(options?: { maxAgeMs?: number }): MCPSession[] {
    let rows: SessionRow[];
    if (options?.maxAgeMs) {
      const cutoff = new Date(Date.now() - options.maxAgeMs).toISOString();
      rows = this.db
        .prepare('SELECT * FROM mcp_sessions WHERE last_activity_at >= ? ORDER BY last_activity_at DESC')
        .all(cutoff) as SessionRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM mcp_sessions ORDER BY last_activity_at DESC')
        .all() as SessionRow[];
    }

    return rows.map(rowToSession);
  }

  /** Prune sessions older than maxAgeMs */
  prune(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db
      .prepare('DELETE FROM mcp_sessions WHERE last_activity_at < ?')
      .run(cutoff);
    return result.changes;
  }

  /** Count active sessions */
  count(): number {
    const row = this.db
      .prepare('SELECT count(*) as cnt FROM mcp_sessions')
      .get() as { cnt: number };
    return row.cnt;
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  created_at: string;
  last_activity_at: string;
  protocol_version: string;
  client_info: string;
  metadata: string;
}

function rowToSession(row: SessionRow): MCPSession {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    protocolVersion: row.protocol_version,
    clientInfo: JSON.parse(row.client_info),
    metadata: JSON.parse(row.metadata),
  };
}
