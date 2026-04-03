import type { SelectorMatch, VectorIndex } from './types.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * SqliteVectorIndex — a persistent vector index using sqlite-vec.
 *
 * Replaces MemoryVectorIndex with a disk-backed, production-grade
 * vector search index. Uses sqlite-vec's vec0 virtual table for
 * efficient cosine-distance nearest-neighbor queries.
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

    // Create the virtual table if it doesn't exist
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_selectors USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      );
    `);
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

    // sqlite-vec uses distance (lower = closer). For cosine distance,
    // distance = 1 - similarity. So threshold on similarity becomes
    // a max distance of (1 - threshold).
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
