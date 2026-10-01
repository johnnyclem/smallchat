/**
 * `@smallchat/core/dream` — memory-driven tool re-compilation.
 *
 * @experimental Dream is an optimization satellite, not part of the
 * inference core: its API, heuristics and versioning layout may change in
 * any 1.x release, and it is not covered by the 1.0 claims in the README.
 * Its usage statistics come from heuristics over session logs; it proposes
 * exclusions but never applies one unless configured to. The root entry
 * (`@smallchat/core`) no longer re-exports it.
 */

export { compileLatest, dream } from './dream-compiler.js';
export type { CompileLatestOptions } from './dream-compiler.js';
export { readMemoryFiles, extractToolMentions } from './memory-reader.js';
export { discoverLogFiles, analyzeSessionLog, aggregateUsageStats } from './log-analyzer.js';
export { prioritizeTools, generateReport } from './tool-prioritizer.js';
export { loadDreamConfig, saveDreamConfig, DEFAULT_DREAM_CONFIG } from './config.js';
export {
  loadManifest,
  saveManifest,
  archiveCurrentArtifact,
  promoteArtifact,
  rollbackToFallback,
  pruneOldVersions,
  listVersions,
} from './artifact-versioning.js';

export type {
  ToolUsageRecord,
  ToolUsageStats,
  MemoryFileContent,
  MemoryToolMention,
  ToolPriorityHints,
  DreamAnalysis,
  DreamResult,
  DreamConfig,
  ArtifactVersion,
  ArtifactManifest,
} from './types.js';
