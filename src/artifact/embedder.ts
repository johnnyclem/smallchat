/**
 * Embedder identity — choosing, constructing and verifying the embedder an
 * artifact was compiled with.
 *
 * Vectors from different embedders are not comparable (cross-embedder
 * cosine is ~0), so an artifact is only usable with the exact embedder
 * recorded in its fingerprint. Every load path goes through
 * resolveArtifactEmbedder(), which builds that embedder or verifies an
 * injected one, and refuses on any mismatch.
 */

import type { Embedder, EmbedderFingerprint, VectorIndex } from '../core/types.js';
import { SelectorTable } from '../core/selector-table.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { ONNXEmbedder } from '../embedding/onnx-embedder.js';
import { EmbedderMismatchError, type ArtifactV1 } from './types.js';

/** Embedders smallchat can construct from a fingerprint on its own. */
export type BuiltinEmbedderKind = 'onnx' | 'hash';

/**
 * The embedder `smallchat compile`, `setup`, `dream` and in-process
 * compilation (`serve --source <manifest dir>`) use unless told otherwise.
 */
export const DEFAULT_EMBEDDER_KIND: BuiltinEmbedderKind = 'onnx';

/** Thrown when a built-in embedder cannot be constructed (e.g. model missing). */
export class EmbedderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderUnavailableError';
  }
}

/**
 * Parse an embedder name from a CLI flag or smallchat.json. Accepts 'onnx'
 * and 'hash'; 'local' is the 0.x name of 'hash'. Undefined → the default.
 */
export function parseEmbedderKind(value: string | undefined): BuiltinEmbedderKind {
  if (value === undefined) return DEFAULT_EMBEDDER_KIND;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'onnx') return 'onnx';
  if (normalized === 'hash' || normalized === 'local') return 'hash';
  throw new Error(`Unknown embedder "${value}" (expected "onnx" or "hash")`);
}

/**
 * Construct a built-in embedder and wait until it can embed. For 'onnx'
 * this loads and integrity-checks the model; failure throws
 * EmbedderUnavailableError rather than falling back silently.
 */
export async function createEmbedder(
  kind: BuiltinEmbedderKind = DEFAULT_EMBEDDER_KIND,
  options: { dims?: number; maxLength?: number } = {},
): Promise<Embedder> {
  if (kind === 'hash') return new HashEmbedder(options.dims ?? 384);

  const embedder = new ONNXEmbedder(options.maxLength !== undefined ? { maxLength: options.maxLength } : undefined);
  try {
    await embedder.whenReady();
  } catch (e) {
    throw new EmbedderUnavailableError(
      `The ONNX embedder (all-MiniLM-L6-v2) could not be loaded: ${(e as Error).message}`,
    );
  }
  return embedder;
}

/** The fingerprint an embedder declares; throws if it declares none. */
export function fingerprintOf(embedder: Embedder): EmbedderFingerprint {
  if (!embedder.fingerprint) {
    throw new EmbedderMismatchError(
      'The embedder declares no fingerprint. Custom embedders must set `fingerprint` ' +
      '(kind "custom") so artifacts can record and verify which embedder produced their vectors.',
    );
  }
  return embedder.fingerprint;
}

/** True when two fingerprints describe the same embedding function. */
export function fingerprintsEqual(a: EmbedderFingerprint, b: EmbedderFingerprint): boolean {
  return (
    a.kind === b.kind &&
    a.model === b.model &&
    a.modelSha256 === b.modelSha256 &&
    a.dims === b.dims &&
    a.maxLength === b.maxLength &&
    a.pooling === b.pooling &&
    a.normalize === b.normalize
  );
}

/** One-line human description, e.g. for error messages and `inspect`. */
export function describeFingerprint(fp: EmbedderFingerprint): string {
  const details = [
    fp.modelSha256 ? `sha256 ${fp.modelSha256.slice(0, 12)}…` : null,
    `${fp.dims} dims`,
    fp.maxLength !== null ? `maxLength ${fp.maxLength}` : null,
    fp.pooling !== 'none' ? `${fp.pooling} pooling` : null,
    fp.normalize ? 'normalized' : 'unnormalized',
  ].filter(Boolean);
  return `${fp.kind} ${fp.model} (${details.join(', ')})`;
}

/**
 * Throw EmbedderMismatchError unless `embedder` is exactly the embedder
 * described by `expected`.
 */
export function assertEmbedderMatches(
  embedder: Embedder,
  expected: EmbedderFingerprint,
  source = 'artifact',
): void {
  const actual = embedder.fingerprint;
  if (!actual) {
    throw new EmbedderMismatchError(
      `${source} was compiled with ${describeFingerprint(expected)}, but the supplied embedder declares no ` +
      'fingerprint, so it cannot be verified to produce comparable vectors.',
    );
  }
  if (!fingerprintsEqual(actual, expected) || embedder.dimensions !== expected.dims) {
    throw new EmbedderMismatchError(
      `${source} was compiled with ${describeFingerprint(expected)}, but the embedder in use is ` +
      `${describeFingerprint(actual)}. Vectors from different embedders are not comparable — ` +
      'use the embedder the artifact was compiled with, or recompile the artifact.',
    );
  }
}

/**
 * The embedder to use with an artifact: the injected one after verifying it
 * matches the artifact's fingerprint, or a built-in constructed from the
 * fingerprint. Refuses (EmbedderMismatchError) when neither is possible.
 */
export async function resolveArtifactEmbedder(
  fingerprint: EmbedderFingerprint,
  options: { embedder?: Embedder; source?: string } = {},
): Promise<Embedder> {
  const source = options.source ?? 'artifact';
  if (options.embedder) {
    assertEmbedderMatches(options.embedder, fingerprint, source);
    return options.embedder;
  }

  let embedder: Embedder;
  switch (fingerprint.kind) {
    case 'hash':
      embedder = new HashEmbedder(fingerprint.dims);
      break;
    case 'onnx':
      try {
        embedder = await createEmbedder('onnx', { maxLength: fingerprint.maxLength ?? undefined });
      } catch (e) {
        throw new EmbedderMismatchError(
          `${source} was compiled with ${describeFingerprint(fingerprint)}, which is unavailable here: ` +
          `${(e as Error).message}. Run "smallchat doctor" to diagnose, or recompile with --embedder hash.`,
        );
      }
      break;
    case 'custom':
      throw new EmbedderMismatchError(
        `${source} was compiled with a custom embedder (${describeFingerprint(fingerprint)}); ` +
        'pass that embedder explicitly (e.g. loadRuntime(path, { embedder })).',
      );
  }
  assertEmbedderMatches(embedder, fingerprint, source);
  return embedder;
}

/**
 * A searchable selector index over an artifact: the verified embedder, a
 * SelectorTable holding every tool and alias selector under its exact
 * canonical, and the vector index behind it. Used by `resolve`, `repl` and
 * other tools that search an artifact without executing anything.
 */
export async function createArtifactIndex(
  artifact: ArtifactV1,
  options: { embedder?: Embedder; vectorIndex?: VectorIndex; source?: string } = {},
): Promise<{ embedder: Embedder; selectorTable: SelectorTable; vectorIndex: VectorIndex }> {
  const embedder = await resolveArtifactEmbedder(artifact.embedder, options);
  const vectorIndex = options.vectorIndex ?? new MemoryVectorIndex();
  const selectorTable = new SelectorTable(vectorIndex, embedder);
  for (const selector of Object.values(artifact.selectors)) {
    selectorTable.register(Float32Array.from(selector.vector), selector.canonical);
  }
  return { embedder, selectorTable, vectorIndex };
}
