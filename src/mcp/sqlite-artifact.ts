/**
 * SqliteArtifactStore — persistence layer that stores compiled artifacts
 * in a SQLite database with pre-indexed vectors via sqlite-vec.
 *
 * Replaces the flat JSON artifact format for large toolsets (1000+ tools)
 * where parsing a multi-MB JSON file and rebuilding the vector index on
 * every load is too slow. The SQLite format keeps vectors pre-indexed in
 * a vec0 virtual table, so the Link phase during loadRuntime is O(rows)
 * sequential reads instead of O(n) insert + index-build.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { SerializedArtifact } from './artifact.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class SqliteArtifactStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    sqliteVec.load(this.db);
    this.ensureSchema();
  }

  // -----------------------------------------------------------------------
  // Write path — called by the compiler
  // -----------------------------------------------------------------------

  /** Persist a full compiled artifact into the database (replaces previous). */
  save(artifact: SerializedArtifact): void {
    const tx = this.db.transaction(() => {
      // Clear previous data
      this.db.exec('DELETE FROM selectors');
      this.db.exec('DELETE FROM vec_selectors');
      this.db.exec('DELETE FROM dispatch_entries');
      this.db.exec('DELETE FROM collisions');
      this.db.exec('DELETE FROM channels');

      // Upsert metadata
      const upsertMeta = this.db.prepare(
        `INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)`,
      );
      upsertMeta.run('version', artifact.version);
      upsertMeta.run('timestamp', (artifact as ArtifactWithTimestamp).timestamp ?? new Date().toISOString());

      const embedding = (artifact as ArtifactWithEmbedding).embedding;
      if (embedding) {
        upsertMeta.run('embedding_model', embedding.model);
        upsertMeta.run('embedding_dimensions', String(embedding.dimensions));
        upsertMeta.run('embedding_type', embedding.embedderType);
      }

      // Stats
      upsertMeta.run('stat_toolCount', String(artifact.stats.toolCount));
      upsertMeta.run('stat_uniqueSelectorCount', String(artifact.stats.uniqueSelectorCount));
      upsertMeta.run('stat_providerCount', String(artifact.stats.providerCount));
      upsertMeta.run('stat_collisionCount', String(artifact.stats.collisionCount));
      if ('mergedCount' in artifact.stats) {
        upsertMeta.run('stat_mergedCount', String((artifact.stats as StatsWithMerged).mergedCount));
      }
      if ('channelCount' in artifact.stats) {
        upsertMeta.run('stat_channelCount', String((artifact.stats as StatsWithChannel).channelCount));
      }

      // Selectors + vectors
      const insertSelector = this.db.prepare(
        `INSERT INTO selectors(canonical, parts, arity) VALUES (?, ?, ?)`,
      );
      const insertVec = this.db.prepare(
        `INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)`,
      );

      for (const [key, sel] of Object.entries(artifact.selectors)) {
        insertSelector.run(key, JSON.stringify(sel.parts), sel.arity);
        const vec = new Float32Array(sel.vector);
        const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
        insertVec.run(key, buf);
      }

      // Dispatch entries
      const insertDispatch = this.db.prepare(
        `INSERT INTO dispatch_entries(provider_id, canonical, tool_name, transport_type, input_schema)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const [providerId, methods] of Object.entries(artifact.dispatchTables)) {
        for (const [canonical, imp] of Object.entries(methods)) {
          insertDispatch.run(
            providerId,
            canonical,
            imp.toolName,
            imp.transportType,
            imp.inputSchema ? JSON.stringify(imp.inputSchema) : null,
          );
        }
      }

      // Collisions (from extended artifact)
      const collisions = (artifact as ArtifactWithCollisions).collisions;
      if (collisions && collisions.length > 0) {
        const insertCollision = this.db.prepare(
          `INSERT INTO collisions(selector_a, selector_b, similarity, hint) VALUES (?, ?, ?, ?)`,
        );
        for (const c of collisions) {
          insertCollision.run(c.selectorA, c.selectorB, c.similarity, c.hint);
        }
      }

      // Channels (from extended artifact)
      const channels = (artifact as ArtifactWithChannels).channels;
      if (channels) {
        const insertChannel = this.db.prepare(
          `INSERT INTO channels(provider_id, config) VALUES (?, ?)`,
        );
        for (const [id, cfg] of Object.entries(channels)) {
          insertChannel.run(id, JSON.stringify(cfg));
        }
      }
    });

    tx();
  }

  // -----------------------------------------------------------------------
  // Read path — called by loadRuntime
  // -----------------------------------------------------------------------

  /** Load the full artifact from the database. */
  load(): SerializedArtifact {
    // Metadata
    const metaRows = this.db.prepare('SELECT key, value FROM metadata').all() as Array<{ key: string; value: string }>;
    const meta = new Map(metaRows.map(r => [r.key, r.value]));

    // Selectors
    const selectorRows = this.db.prepare('SELECT canonical, parts, arity FROM selectors').all() as Array<{
      canonical: string;
      parts: string;
      arity: number;
    }>;

    // Vectors — read raw blobs from vec_selectors via the shadow rowid table
    const selectors: SerializedArtifact['selectors'] = {};
    for (const row of selectorRows) {
      const vecRow = this.db.prepare(
        'SELECT embedding FROM vec_selectors WHERE id = ?',
      ).get(row.canonical) as { embedding: Buffer } | undefined;

      const vector = vecRow
        ? Array.from(new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4))
        : [];

      selectors[row.canonical] = {
        canonical: row.canonical,
        parts: JSON.parse(row.parts),
        arity: row.arity,
        vector,
      };
    }

    // Dispatch tables
    const dispatchRows = this.db.prepare(
      'SELECT provider_id, canonical, tool_name, transport_type, input_schema FROM dispatch_entries',
    ).all() as Array<{
      provider_id: string;
      canonical: string;
      tool_name: string;
      transport_type: string;
      input_schema: string | null;
    }>;

    const dispatchTables: SerializedArtifact['dispatchTables'] = {};
    for (const row of dispatchRows) {
      if (!dispatchTables[row.provider_id]) {
        dispatchTables[row.provider_id] = {};
      }
      dispatchTables[row.provider_id][row.canonical] = {
        providerId: row.provider_id,
        toolName: row.tool_name,
        transportType: row.transport_type,
        inputSchema: row.input_schema ? JSON.parse(row.input_schema) : undefined,
      };
    }

    // Collisions
    const collisionRows = this.db.prepare(
      'SELECT selector_a, selector_b, similarity, hint FROM collisions',
    ).all() as Array<{ selector_a: string; selector_b: string; similarity: number; hint: string }>;

    // Channels
    const channelRows = this.db.prepare(
      'SELECT provider_id, config FROM channels',
    ).all() as Array<{ provider_id: string; config: string }>;
    const channels: Record<string, object> = {};
    for (const row of channelRows) {
      channels[row.provider_id] = JSON.parse(row.config);
    }

    const artifact: Record<string, unknown> = {
      version: meta.get('version') ?? '0.1.0',
      timestamp: meta.get('timestamp'),
      stats: {
        toolCount: parseInt(meta.get('stat_toolCount') ?? '0', 10),
        uniqueSelectorCount: parseInt(meta.get('stat_uniqueSelectorCount') ?? '0', 10),
        providerCount: parseInt(meta.get('stat_providerCount') ?? '0', 10),
        collisionCount: parseInt(meta.get('stat_collisionCount') ?? '0', 10),
        ...(meta.has('stat_mergedCount') ? { mergedCount: parseInt(meta.get('stat_mergedCount')!, 10) } : {}),
        ...(meta.has('stat_channelCount') ? { channelCount: parseInt(meta.get('stat_channelCount')!, 10) } : {}),
      },
      selectors,
      dispatchTables,
    };

    if (meta.has('embedding_model')) {
      artifact.embedding = {
        model: meta.get('embedding_model'),
        dimensions: parseInt(meta.get('embedding_dimensions') ?? '384', 10),
        embedderType: meta.get('embedding_type') ?? 'local',
      };
    }

    if (collisionRows.length > 0) {
      artifact.collisions = collisionRows.map(r => ({
        selectorA: r.selector_a,
        selectorB: r.selector_b,
        similarity: r.similarity,
        hint: r.hint,
      }));
    }

    if (Object.keys(channels).length > 0) {
      artifact.channels = channels;
    }

    return artifact as unknown as SerializedArtifact;
  }

  // -----------------------------------------------------------------------
  // Direct vector index access — used by loadRuntime to populate the
  // runtime's VectorIndex without re-embedding
  // -----------------------------------------------------------------------

  /** Return all selector vectors as { id, vector } pairs for bulk-loading. */
  allVectors(): Array<{ id: string; vector: Float32Array }> {
    const rows = this.db.prepare(
      'SELECT id, embedding FROM vec_selectors',
    ).all() as Array<{ id: string; embedding: Buffer }>;

    return rows.map(row => ({
      id: row.id,
      vector: new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    }));
  }

  /** Number of selectors stored. */
  selectorCount(): number {
    const row = this.db.prepare('SELECT count(*) as cnt FROM selectors').get() as { cnt: number };
    return row.cnt;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  // -----------------------------------------------------------------------
  // Schema
  // -----------------------------------------------------------------------

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS selectors (
        canonical TEXT PRIMARY KEY,
        parts     TEXT NOT NULL,   -- JSON array
        arity     INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_selectors USING vec0(
        id        TEXT PRIMARY KEY,
        embedding FLOAT[384]
      );

      CREATE TABLE IF NOT EXISTS dispatch_entries (
        provider_id    TEXT NOT NULL,
        canonical      TEXT NOT NULL,
        tool_name      TEXT NOT NULL,
        transport_type TEXT NOT NULL,
        input_schema   TEXT,         -- JSON or NULL
        PRIMARY KEY (provider_id, canonical)
      );

      CREATE TABLE IF NOT EXISTS collisions (
        selector_a TEXT NOT NULL,
        selector_b TEXT NOT NULL,
        similarity REAL NOT NULL,
        hint       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        provider_id TEXT PRIMARY KEY,
        config      TEXT NOT NULL   -- JSON
      );
    `);
  }
}

// ---------------------------------------------------------------------------
// Internal type extensions for the full serialized artifact shape
// (the core SerializedArtifact type is minimal; the compiler emits extras)
// ---------------------------------------------------------------------------

interface ArtifactWithTimestamp {
  timestamp?: string;
}

interface ArtifactWithEmbedding {
  embedding?: {
    model: string;
    dimensions: number;
    embedderType: string;
  };
}

interface ArtifactWithCollisions {
  collisions?: Array<{
    selectorA: string;
    selectorB: string;
    similarity: number;
    hint: string;
  }>;
}

interface ArtifactWithChannels {
  channels?: Record<string, object>;
}

interface StatsWithMerged {
  mergedCount: number;
}

interface StatsWithChannel {
  channelCount: number;
}
