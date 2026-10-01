/**
 * @smallchat/core/artifact — compiled toolkit artifacts, format 1.0.
 *
 * An artifact is the output of `smallchat compile`: every tool of every
 * provider, keyed by canonical tool id `<providerId>/<toolName>`, with its
 * upstream definition (description, inputSchema, outputSchema,
 * annotations), the provider's launch spec (env variable NAMES only), one
 * or more selector embeddings per tool, and the fingerprint of the embedder
 * that produced them. The normative JSON Schema is
 * spec/artifact/artifact.v1.schema.json.
 *
 * Guarantees of this module (and their boundary):
 *   - One writer: buildArtifact() is the only producer; it validates its
 *     own output.
 *   - One validating reader: readArtifact()/parseArtifact()/validateArtifact()
 *     accept only formatVersion "1.0" artifacts that match the schema, are
 *     internally consistent and whose contentHash matches. Pre-1.0 files are
 *     refused with a "recompile with smallchat 1.0" message — never
 *     partially loaded.
 *   - Embedder identity: resolveArtifactEmbedder()/createArtifactIndex()
 *     construct the embedder named by the fingerprint, or verify an
 *     injected one, and throw EmbedderMismatchError otherwise. This checks
 *     the declared fingerprint; it cannot detect a custom embedder that
 *     declares a fingerprint it does not implement.
 *   - Distinct tools stay distinct: each selector points at exactly one tool.
 *
 * Typical use:
 *
 *   const artifact = await readArtifact('tools.toolkit.json');
 *   const tool = artifact.tools['github/create_issue'];
 *   const { selectorTable, embedder } = await createArtifactIndex(artifact);
 *
 * To get a dispatch-ready ToolRuntime, use loadRuntime() from the package
 * root, which is built on this module.
 */

export {
  ARTIFACT_FORMAT_VERSION,
  ArtifactFormatError,
  ArtifactVersionError,
  EmbedderMismatchError,
} from './types.js';
export type {
  ArtifactV1,
  ArtifactProvider,
  ArtifactTool,
  ArtifactSelector,
  ArtifactCollision,
  ArtifactDuplicate,
  ArtifactStats,
  EmbedderFingerprint,
  LaunchSpec,
  StdioLaunchSpec,
  RemoteLaunchSpec,
  ToolAnnotations,
} from './types.js';

export {
  ARTIFACT_HASH_DOMAIN,
  ARTIFACT_SCHEMA_PATH,
  buildArtifact,
  computeContentHash,
  validateArtifact,
  parseArtifact,
  serializeArtifact,
} from './format.js';
export type { BuildArtifactOptions } from './format.js';

export { readArtifact, writeArtifact, isSqliteArtifactPath } from './io.js';

export {
  DEFAULT_EMBEDDER_KIND,
  EmbedderUnavailableError,
  parseEmbedderKind,
  createEmbedder,
  fingerprintOf,
  fingerprintsEqual,
  describeFingerprint,
  assertEmbedderMatches,
  resolveArtifactEmbedder,
  createArtifactIndex,
} from './embedder.js';
export type { BuiltinEmbedderKind } from './embedder.js';

export { toolId, parseToolId } from '../core/tool-id.js';
