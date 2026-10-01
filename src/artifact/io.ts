/**
 * Artifact files — JSON (`*.json`) or SQLite (`*.db`, vectors pre-indexed
 * in a sqlite-vec table). Both go through validateArtifact(), so a file
 * that reads successfully is a complete, intact 1.0 artifact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArtifact, serializeArtifact, validateArtifact } from './format.js';
import { ArtifactFormatError, type ArtifactV1 } from './types.js';

/** True when `path` names a SQLite artifact (by extension). */
export function isSqliteArtifactPath(path: string): boolean {
  return path.endsWith('.db');
}

/** Read and validate an artifact file (.json or .db). */
export async function readArtifact(path: string): Promise<ArtifactV1> {
  if (!existsSync(path)) {
    throw new ArtifactFormatError(`Artifact not found: ${path} (run "smallchat compile" first)`);
  }

  if (isSqliteArtifactPath(path)) {
    // Loaded lazily so JSON-only users never touch the native sqlite modules.
    const { SqliteArtifactStore } = await import('../mcp/sqlite-artifact.js');
    const store = new SqliteArtifactStore(path, { readonly: true });
    try {
      return validateArtifact(store.load(), path);
    } finally {
      store.close();
    }
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new ArtifactFormatError(`Cannot read artifact ${path}: ${(e as Error).message}`);
  }
  return parseArtifact(text, path);
}

/** Validate and write an artifact; `.db` paths are written as SQLite. */
export async function writeArtifact(path: string, artifact: ArtifactV1): Promise<void> {
  validateArtifact(artifact, 'artifact to write');

  if (isSqliteArtifactPath(path)) {
    const { SqliteArtifactStore } = await import('../mcp/sqlite-artifact.js');
    const store = new SqliteArtifactStore(path);
    try {
      store.save(artifact);
    } finally {
      store.close();
    }
    return;
  }

  writeFileSync(path, serializeArtifact(artifact));
}
