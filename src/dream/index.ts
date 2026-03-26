/**
 * Dream module — memory-driven tool re-compilation.
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
