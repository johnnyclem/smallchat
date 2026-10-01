import type { SelectorMatch, VectorIndex } from '../core/types.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * The vec0 table definition SqliteVectorIndex searches: cosine distance
 * (1 − cosine similarity), the same quantity MemoryVectorIndex returns.
 * Other writers of `vec_selectors` (the SQLite artifact store) declare the
 * same metric, so opening their databases needs no rebuild.
 */
function vecSelectorsTableSql(dimensions: number): string {
  return `CREATE VIRTUAL TABLE vec_selectors USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}] distance_metric=cosine)`;
}

/**
 * SqliteVectorIndex — a persistent vector index using sqlite-vec.
 *
 * A disk-backed alternative to MemoryVectorIndex for large registries.
 * Uses a sqlite-vec vec0 virtual table declared with
 * `distance_metric=cosine`, so search() returns 1 − cosine similarity
 * exactly like MemoryVectorIndex and thresholds mean the same thing on
 * both backends.
 *
 * Databases written before smallchat 1.0 declared no metric, so vec0
 * computed L2 distance, which search() then misread as cosine distance
 * (a 0.90-cosine match scored 0.55). Opening such a database rebuilds the
 * table in place with the cosine metric, keeping every id and vector.
 */
export class SqliteVectorIndex implements VectorIndex {
  private db: Database.Database;
  private dimensions: number;

  constructor(dbPath: string = ':memory:', dimensions = 384) {
    this.dimensions = dimensions;
    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Load the sqlite-vec extension
    sqliteVec.load(this.db);

    this.ensureCosineTable();
  }

  /** Create vec_selectors with the cosine metric, or rebuild an older (L2) one. */
  private ensureCosineTable(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_selectors'")
      .get() as { sql: string } | undefined;
    if (!row) {
      this.db.exec(vecSelectorsTableSql(this.dimensions));
      return;
    }
    if (/distance_metric\s*=\s*cosine/i.test(row.sql)) return;

    const rebuild = this.db.transaction(() => {
      const rows = this.db.prepare('SELECT id, embedding FROM vec_selectors').all() as Array<{ id: string; embedding: Buffer }>;
      this.db.exec('DROP TABLE vec_selectors');
      this.db.exec(vecSelectorsTableSql(this.dimensions));
      const insert = this.db.prepare('INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)');
      for (const r of rows) insert.run(r.id, r.embedding);
    });
    rebuild();
  }

  insert(id: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimensions}, got ${vector.length}`,
      );
    }

    // vec0 virtual tables don't support INSERT OR REPLACE,
    // so delete-then-insert for upsert behavior
    const deleteSt = this.db.prepare('DELETE FROM vec_selectors WHERE id = ?');
    const insertSt = this.db.prepare(
      'INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)',
    );
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    deleteSt.run(id);
    insertSt.run(id, buf);
  }

  search(query: Float32Array, topK: number, threshold: number): SelectorMatch[] {
    if (query.length !== this.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.dimensions}, got ${query.length}`,
      );
    }

    // The table uses distance_metric=cosine: distance = 1 - similarity, so
    // a similarity threshold is a max distance of (1 - threshold).
    const maxDistance = 1 - threshold;

    const stmt = this.db.prepare(`
      SELECT id, distance
      FROM vec_selectors
      WHERE embedding MATCH ?
        AND k = ?
    `);

    const queryBuf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
    const rows = stmt.all(queryBuf, topK) as Array<{ id: string; distance: number }>;

    return rows
      .filter(row => row.distance <= maxDistance)
      .map(row => ({ id: row.id, distance: row.distance }));
  }

  remove(id: string): void {
    const stmt = this.db.prepare('DELETE FROM vec_selectors WHERE id = ?');
    stmt.run(id);
  }

  size(): number {
    const row = this.db.prepare(
      'SELECT count(*) as cnt FROM vec_selectors',
    ).get() as { cnt: number };
    return row.cnt;
  }

  /** Batch insert for compiler performance */
  insertBatch(entries: Array<{ id: string; vector: Float32Array }>): void {
    const deleteSt = this.db.prepare('DELETE FROM vec_selectors WHERE id = ?');
    const insertSt = this.db.prepare(
      'INSERT INTO vec_selectors(id, embedding) VALUES (?, ?)',
    );

    const tx = this.db.transaction(
      (items: Array<{ id: string; vector: Float32Array }>) => {
        for (const { id, vector } of items) {
          if (vector.length !== this.dimensions) {
            throw new Error(
              `Vector dimension mismatch for "${id}": expected ${this.dimensions}, got ${vector.length}`,
            );
          }
          const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
          deleteSt.run(id);
          insertSt.run(id, buf);
        }
      },
    );

    tx(entries);
  }

  /** Get stats about the index */
  stats(): { count: number; dimensions: number; dbPath: string } {
    return {
      count: this.size(),
      dimensions: this.dimensions,
      dbPath: this.db.name,
    };
  }

  /** Run VACUUM to compact the database */
  compact(): void {
    this.db.exec('VACUUM');
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }
}
