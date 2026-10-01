/**
 * SqliteArtifactStore — persistence layer that stores compiled artifacts
 * in a SQLite database with pre-indexed vectors via sqlite-vec.
 *
 * An alternative to the flat JSON artifact for large toolsets (1000+
 * tools): selector vectors live in a vec0 virtual table (`vec_selectors`,
 * the same table SqliteVectorIndex searches), and everything else — the
 * 1.0 artifact minus its vectors — is one JSON document in `metadata`.
 * load() reassembles the exact artifact that was saved, so its content
 * hash still verifies.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { ARTIFACT_FORMAT_VERSION, ArtifactFormatError, ArtifactVersionError, type ArtifactV1 } from '../artifact/types.js';
import { safeJsonParse } from '../core/safe-json.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SqliteArtifactStoreOptions {
  /** Open without write access (no schema creation, no WAL switch) */
  readonly?: boolean;
}

/** Tables written by 0.x releases; dropped when a 1.0 artifact is saved. */
const LEGACY_TABLES = ['selectors', 'dispatch_entries', 'collisions', 'channels'];

export class SqliteArtifactStore {
  private db: Database.Database;

  constructor(dbPath: string, options: SqliteArtifactStoreOptions = {}) {
    this.db = new Database(dbPath, options.readonly ? { readonly: true, fileMustExist: true } : undefined);
    if (!options.readonly) this.db.pragma('journal_mode = WAL');
    sqliteVec.load(this.db);
    if (!options.readonly) this.ensureSchema();
  }

  // -----------------------------------------------------------------------
  // Write path — called by writeArtifact()
  // -----------------------------------------------------------------------

  /** Persist a 1.0 artifact into the database (replaces any previous one). */
  save(artifact: ArtifactV1): void {
    const dims = artifact.embedder.dims;
    const tx = this.db.transaction(() => {
      for (const table of LEGACY_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      this.db.exec('DELETE FROM metadata');
      // Recreate the vector table at this artifact's dimensionality.
      this.db.exec('DROP TABLE IF EXISTS vec_selectors');
      this.db.exec(`CREATE VIRTUAL TABLE vec_selectors USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dims}] distance_metric=cosine)`);

      const insertVec = this.db.prepare('INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)');
      const skeleton: ArtifactV1 = { ...artifact, selectors: {} };
      for (const [canonical, selector] of Object.entries(artifact.selectors)) {
        skeleton.selectors[canonical] = { ...selector, vector: [] };
        const vec = new Float32Array(selector.vector);
        insertVec.run(canonical, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      }

      const upsertMeta = this.db.prepare('INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)');
      upsertMeta.run('format_version', artifact.formatVersion);
      upsertMeta.run('content_hash', artifact.contentHash);
      upsertMeta.run('artifact', JSON.stringify(skeleton));
    });

    tx();
  }

  // -----------------------------------------------------------------------
  // Read path — called by readArtifact()
  // -----------------------------------------------------------------------

  /**
   * Load the artifact from the database. The caller validates it
   * (readArtifact does); a pre-1.0 database throws ArtifactVersionError.
   */
  load(): ArtifactV1 {
    const hasMetadata = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metadata'")
      .get();
    const meta = new Map(
      hasMetadata
        ? (this.db.prepare('SELECT key, value FROM metadata').all() as Array<{ key: string; value: string }>)
            .map(r => [r.key, r.value])
        : [],
    );

    const formatVersion = meta.get('format_version');
    if (formatVersion === undefined) {
      const legacy = meta.get('version');
      if (legacy !== undefined) {
        throw new ArtifactVersionError(
          `${this.db.name} is a pre-1.0 smallchat artifact (version ${legacy}); ` +
          'recompile with smallchat 1.0 (`smallchat compile --format sqlite`).',
        );
      }
      throw new ArtifactFormatError(`${this.db.name} does not contain a smallchat artifact`);
    }
    if (formatVersion !== ARTIFACT_FORMAT_VERSION) {
      throw new ArtifactVersionError(
        `${this.db.name} has formatVersion "${formatVersion}"; this smallchat reads "${ARTIFACT_FORMAT_VERSION}"`,
      );
    }

    const artifact = safeJsonParse(meta.get('artifact') ?? 'null') as ArtifactV1 | null;
    if (!artifact || typeof artifact !== 'object' || typeof artifact.selectors !== 'object') {
      throw new ArtifactFormatError(`${this.db.name} has a damaged artifact record`);
    }

    const readVec = this.db.prepare('SELECT embedding FROM vec_selectors WHERE id = ?');
    for (const [canonical, selector] of Object.entries(artifact.selectors)) {
      const row = readVec.get(canonical) as { embedding: Buffer } | undefined;
      if (!row) {
        throw new ArtifactFormatError(`${this.db.name} is missing the vector for selector ${canonical}`);
      }
      selector.vector = Array.from(toFloat32(row.embedding));
    }
    return artifact;
  }

  // -----------------------------------------------------------------------
  // Direct vector index access
  // -----------------------------------------------------------------------

  /** Return all selector vectors as { id, vector } pairs for bulk-loading. */
  allVectors(): Array<{ id: string; vector: Float32Array }> {
    const rows = this.db.prepare(
      'SELECT id, embedding FROM vec_selectors',
    ).all() as Array<{ id: string; embedding: Buffer }>;

    return rows.map(row => ({ id: row.id, vector: toFloat32(row.embedding) }));
  }

  /** Number of selector vectors stored. */
  selectorCount(): number {
    const row = this.db.prepare('SELECT count(*) as cnt FROM vec_selectors').get() as { cnt: number };
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
    `);
  }
}

function toFloat32(buf: Buffer): Float32Array {
  // Copy: the Buffer may not be 4-byte aligned within its ArrayBuffer.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}
