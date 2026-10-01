/**
 * Artifact diagnosis — what `smallchat doctor --artifact <path>` checks.
 *
 * An artifact is usable only with the embedder that produced its vectors,
 * and only through an index that holds those vectors. Each check states
 * what it verified:
 *
 *   artifact     the file is an intact format 1.0 artifact (schema, content hash)
 *   embedder     the embedder named by its fingerprint can be built here
 *   vectors      every selector vector has the fingerprint's dimensions (and
 *                unit length when the fingerprint says normalized)
 *   reproduce    re-embedding each tool's selector text on this machine gives
 *                the stored vector (cosine >= 0.999) — catches a different
 *                model file, tokenizer or platform drift
 *   index        the vector index the runtime searches holds exactly the
 *                artifact's selectors with the cosine metric, and each
 *                selector finds itself first (for .db artifacts: the
 *                sqlite-vec table, opened read-only)
 *   duplicates   distinct tools whose selectors are so close (cosine >=
 *                0.90 by default) that intents near them will usually need
 *                disambiguation; and tools compiled under --allow-duplicates
 *   shared names tool names that more than one provider uses — a bare name
 *                is ambiguous, call those tools by canonical id
 */

import type { Embedder, VectorIndex } from '../core/types.js';
import { cosineSimilarity } from '../core/vector-math.js';
import { toolEmbeddingText } from '../compiler/compiler.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { readArtifact, isSqliteArtifactPath } from './io.js';
import { describeFingerprint, resolveArtifactEmbedder } from './embedder.js';
import type { ArtifactV1 } from './types.js';

export type CheckStatus = 'pass' | 'info' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Specific items behind a warn/fail (tool ids, pairs), at most a few dozen */
  items?: string[];
}

export interface NearDuplicate {
  toolA: string;
  toolB: string;
  similarity: number;
}

export interface ArtifactDiagnosis {
  path: string;
  /** contentHash when the artifact could be read */
  artifactHash: string | null;
  checks: DoctorCheck[];
  nearDuplicates: NearDuplicate[];
  /** No check failed (warnings allowed) */
  ok: boolean;
}

export interface DiagnoseOptions {
  /** Embedder to verify instead of building one from the fingerprint */
  embedder?: Embedder;
  /** Cosine at or above which two distinct tools are reported (default 0.90) */
  nearDuplicateThreshold?: number;
  /** Re-embedded vectors must reach this cosine with the stored ones (default 0.999) */
  reproduceThreshold?: number;
  /** Re-embed at most this many tool selectors (default: all) */
  reproduceLimit?: number;
}

const MAX_ITEMS = 25;

/** Run every artifact check (see module doc). Never throws for a bad artifact; it reports it. */
export async function diagnoseArtifact(path: string, options: DiagnoseOptions = {}): Promise<ArtifactDiagnosis> {
  const checks: DoctorCheck[] = [];
  const done = (artifactHash: string | null, nearDuplicates: NearDuplicate[] = []): ArtifactDiagnosis => ({
    path,
    artifactHash,
    checks,
    nearDuplicates,
    ok: checks.every(c => c.status !== 'fail'),
  });

  let artifact: ArtifactV1;
  try {
    artifact = await readArtifact(path);
  } catch (err) {
    checks.push({ name: 'artifact', status: 'fail', detail: (err as Error).message });
    return done(null);
  }
  checks.push({
    name: 'artifact',
    status: 'pass',
    detail: `format ${artifact.formatVersion}, ${artifact.stats.toolCount} tools, ${artifact.stats.selectorCount} selectors, ` +
      `${artifact.stats.providerCount} providers; content hash ${artifact.contentHash.slice(0, 16)}… verified`,
  });

  let embedder: Embedder;
  try {
    embedder = await resolveArtifactEmbedder(artifact.embedder, { embedder: options.embedder, source: path });
    checks.push({ name: 'embedder', status: 'pass', detail: describeFingerprint(artifact.embedder) });
  } catch (err) {
    checks.push({ name: 'embedder', status: 'fail', detail: (err as Error).message });
    checks.push(...sharedNameChecks(artifact));
    const nearDuplicates = findNearDuplicates(artifact, options.nearDuplicateThreshold ?? 0.9);
    checks.push(duplicateCheck(artifact, nearDuplicates, options.nearDuplicateThreshold ?? 0.9));
    return done(artifact.contentHash, nearDuplicates);
  }

  checks.push(vectorCheck(artifact, embedder));
  checks.push(await reproduceCheck(artifact, embedder, options));
  checks.push(await indexCheck(path, artifact));
  const threshold = options.nearDuplicateThreshold ?? 0.9;
  const nearDuplicates = findNearDuplicates(artifact, threshold);
  checks.push(duplicateCheck(artifact, nearDuplicates, threshold));
  checks.push(...sharedNameChecks(artifact));
  return done(artifact.contentHash, nearDuplicates);
}

function vectorCheck(artifact: ArtifactV1, embedder: Embedder): DoctorCheck {
  const dims = artifact.embedder.dims;
  const wrongDims: string[] = [];
  const notUnit: string[] = [];
  for (const selector of Object.values(artifact.selectors)) {
    if (selector.vector.length !== dims) {
      wrongDims.push(`${selector.canonical} (${selector.vector.length})`);
      continue;
    }
    if (artifact.embedder.normalize) {
      const norm = Math.sqrt(selector.vector.reduce((sum, x) => sum + x * x, 0));
      if (Math.abs(norm - 1) > 1e-3) notUnit.push(`${selector.canonical} (|v| = ${norm.toFixed(4)})`);
    }
  }
  if (embedder.dimensions !== dims) {
    return { name: 'vectors', status: 'fail', detail: `the embedder produces ${embedder.dimensions}-dim vectors; the artifact holds ${dims}-dim vectors` };
  }
  if (wrongDims.length > 0) {
    return { name: 'vectors', status: 'fail', detail: `${wrongDims.length} selector vector(s) are not ${dims}-dimensional`, items: wrongDims.slice(0, MAX_ITEMS) };
  }
  if (notUnit.length > 0) {
    return { name: 'vectors', status: 'fail', detail: `${notUnit.length} selector vector(s) are not unit length, but the embedder normalizes`, items: notUnit.slice(0, MAX_ITEMS) };
  }
  return { name: 'vectors', status: 'pass', detail: `${Object.keys(artifact.selectors).length} vectors, ${dims} dims${artifact.embedder.normalize ? ', unit length' : ''}` };
}

async function reproduceCheck(artifact: ArtifactV1, embedder: Embedder, options: DiagnoseOptions): Promise<DoctorCheck> {
  const threshold = options.reproduceThreshold ?? 0.999;
  const tools = Object.values(artifact.tools).slice(0, options.reproduceLimit ?? Infinity);
  const drifted: Array<{ id: string; cosine: number }> = [];
  let worst = 1;
  for (const tool of tools) {
    const stored = artifact.selectors[tool.selector];
    if (!stored || stored.vector.length !== embedder.dimensions) continue;
    const hint = (tool.compilerHints?.selectorHint ?? artifact.providers[tool.providerId]?.compilerHints?.selectorHint) as string | undefined;
    const fresh = await embedder.embed(toolEmbeddingText(tool.name, tool.description, hint));
    const cosine = cosineSimilarity(fresh, Float32Array.from(stored.vector));
    worst = Math.min(worst, cosine);
    if (cosine < threshold) drifted.push({ id: tool.id, cosine });
  }
  const checked = `${tools.length} tool selector(s) re-embedded; lowest cosine to the stored vector ${worst.toFixed(6)}`;
  if (drifted.length === 0) return { name: 'reproduce', status: 'pass', detail: checked };
  drifted.sort((a, b) => a.cosine - b.cosine);
  const items = drifted.slice(0, MAX_ITEMS).map(d => `${d.id} (cosine ${d.cosine.toFixed(6)})`);
  // Most selectors drifting means this machine's embedder is not the one that compiled the artifact.
  if (drifted.length * 2 > tools.length) {
    return {
      name: 'reproduce',
      status: 'fail',
      detail: `${drifted.length} of ${tools.length} selectors do not reproduce (cosine < ${threshold}): this machine's embedder ` +
        'does not produce the vectors the artifact was compiled with; recompile here or fix the model files',
      items,
    };
  }
  return {
    name: 'reproduce',
    status: 'warn',
    detail: `${drifted.length} of ${tools.length} selectors do not reproduce (cosine < ${threshold}); hint overrides from ` +
      'smallchat.json are not recorded in the artifact, so their selectors cannot be re-derived — otherwise recompile',
    items,
  };
}

async function indexCheck(path: string, artifact: ArtifactV1): Promise<DoctorCheck> {
  const selectors = Object.values(artifact.selectors);
  if (isSqliteArtifactPath(path)) return sqliteIndexCheck(path, artifact);

  const index: VectorIndex = new MemoryVectorIndex();
  for (const s of selectors) index.insert(s.canonical, Float32Array.from(s.vector));
  return selfRetrieval(selectors, index, 'in-memory index');
}

async function selfRetrieval(
  selectors: ArtifactV1['selectors'][string][],
  index: Pick<VectorIndex, 'search'>,
  label: string,
): Promise<DoctorCheck> {
  const misses: string[] = [];
  for (const s of selectors) {
    const [top] = await index.search(Float32Array.from(s.vector), 1, 0);
    // An identical vector under another id ties at distance 0; that is a duplicate, not an index fault.
    if (!top || (top.id !== s.canonical && top.distance > 1e-4)) {
      misses.push(`${s.canonical} → ${top ? `${top.id} (distance ${top.distance.toFixed(4)})` : 'nothing'}`);
    }
  }
  if (misses.length > 0) {
    return { name: 'index', status: 'fail', detail: `${misses.length} selector(s) do not find themselves in the ${label}`, items: misses.slice(0, MAX_ITEMS) };
  }
  return { name: 'index', status: 'pass', detail: `${label}: ${selectors.length} selectors, each finds itself first (cosine metric)` };
}

async function sqliteIndexCheck(path: string, artifact: ArtifactV1): Promise<DoctorCheck> {
  const selectors = Object.values(artifact.selectors);
  const Database = (await import('better-sqlite3')).default;
  let db: InstanceType<typeof Database> | null = null;
  try {
    const sqliteVec = await import('sqlite-vec');
    db = new Database(path, { readonly: true, fileMustExist: true });
    sqliteVec.load(db);
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_selectors'").get() as { sql: string } | undefined;
    if (!table) return { name: 'index', status: 'fail', detail: `${path} has no vec_selectors table` };
    const dims = /FLOAT\[(\d+)\]/i.exec(table.sql)?.[1];
    if (Number(dims) !== artifact.embedder.dims) {
      return { name: 'index', status: 'fail', detail: `vec_selectors holds ${dims}-dim vectors; the embedder produces ${artifact.embedder.dims}` };
    }
    if (!/distance_metric\s*=\s*cosine/i.test(table.sql)) {
      return { name: 'index', status: 'fail', detail: 'vec_selectors does not use the cosine metric (a pre-1.0 index); recompile the artifact' };
    }
    const ids = new Set((db.prepare('SELECT id FROM vec_selectors').all() as Array<{ id: string }>).map(r => r.id));
    const missing = selectors.filter(s => !ids.has(s.canonical)).map(s => s.canonical);
    const extra = [...ids].filter(id => !artifact.selectors[id]);
    if (missing.length > 0 || extra.length > 0) {
      return {
        name: 'index',
        status: 'fail',
        detail: `vec_selectors does not match the artifact: ${missing.length} selector(s) missing, ${extra.length} unknown row(s)`,
        items: [...missing.map(id => `missing ${id}`), ...extra.map(id => `unknown ${id}`)].slice(0, MAX_ITEMS),
      };
    }
    const nearest = db.prepare('SELECT id, distance FROM vec_selectors WHERE embedding MATCH ? AND k = 1');
    const sqliteIndex = {
      search: (vector: Float32Array) =>
        nearest.all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)) as Array<{ id: string; distance: number }>,
    };
    return await selfRetrieval(selectors, sqliteIndex, 'sqlite-vec index');
  } catch (err) {
    return { name: 'index', status: 'fail', detail: `could not open the sqlite-vec index: ${(err as Error).message}` };
  } finally {
    db?.close();
  }
}

/** Pairs of distinct tools whose closest selectors are at or above `threshold`, most similar first. */
export function findNearDuplicates(artifact: ArtifactV1, threshold: number): NearDuplicate[] {
  const selectors = Object.values(artifact.selectors).map(s => ({ toolId: s.toolId, vector: Float32Array.from(s.vector) }));
  const best = new Map<string, NearDuplicate>();
  for (let i = 0; i < selectors.length; i++) {
    for (let j = i + 1; j < selectors.length; j++) {
      const a = selectors[i];
      const b = selectors[j];
      if (a.toolId === b.toolId || a.vector.length !== b.vector.length) continue;
      const similarity = cosineSimilarity(a.vector, b.vector);
      if (similarity < threshold) continue;
      const [toolA, toolB] = a.toolId < b.toolId ? [a.toolId, b.toolId] : [b.toolId, a.toolId];
      const key = `${toolA}\u0000${toolB}`;
      const previous = best.get(key);
      if (!previous || similarity > previous.similarity) best.set(key, { toolA, toolB, similarity });
    }
  }
  return [...best.values()].sort((x, y) => y.similarity - x.similarity || (x.toolA < y.toolA ? -1 : 1));
}

function duplicateCheck(artifact: ArtifactV1, nearDuplicates: NearDuplicate[], threshold: number): DoctorCheck {
  const compiled = artifact.duplicates.length;
  if (nearDuplicates.length === 0 && compiled === 0) {
    return { name: 'duplicates', status: 'pass', detail: `no two tools are at cosine >= ${threshold}` };
  }
  return {
    name: 'duplicates',
    status: 'warn',
    detail: `${nearDuplicates.length} pair(s) of distinct tools at cosine >= ${threshold}` +
      `${compiled > 0 ? ` (${compiled} compiled with --allow-duplicates)` : ''}; intents near them usually need disambiguation — ` +
      'give them distinct descriptions or call them by tool id',
    items: nearDuplicates.slice(0, MAX_ITEMS).map(d => `${d.toolA} ~ ${d.toolB} (cosine ${d.similarity.toFixed(4)})`),
  };
}

function sharedNameChecks(artifact: ArtifactV1): DoctorCheck[] {
  const byName = new Map<string, string[]>();
  for (const tool of Object.values(artifact.tools)) {
    const ids = byName.get(tool.name) ?? [];
    ids.push(tool.id);
    byName.set(tool.name, ids);
  }
  const shared = [...byName].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => (a < b ? -1 : 1));
  if (shared.length === 0) return [{ name: 'shared names', status: 'pass', detail: 'every tool name belongs to one provider' }];
  return [{
    name: 'shared names',
    status: 'info',
    detail: `${shared.length} tool name(s) are used by more than one provider; call those tools by canonical id`,
    items: shared.slice(0, MAX_ITEMS).map(([name, ids]) => `${name}: ${ids.sort().join(', ')}`),
  }];
}

/** Human-readable diagnosis (what `smallchat doctor --artifact` prints). */
export function formatDiagnosis(d: ArtifactDiagnosis): string {
  const icon: Record<CheckStatus, string> = { pass: '✓', info: 'i', warn: '!', fail: '✗' };
  const width = Math.max(...d.checks.map(c => c.name.length));
  const lines = [`Artifact ${d.path}:`];
  for (const c of d.checks) {
    lines.push(`  ${icon[c.status]} ${c.name.padEnd(width)}  ${c.status.toUpperCase().padEnd(4)}  ${c.detail}`);
    for (const item of c.items ?? []) lines.push(`      ${item}`);
  }
  return lines.join('\n');
}
