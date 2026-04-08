/**
 * Memex — the knowledge base compiler module.
 *
 * Compiles document sources into a persistent, cross-referenced knowledge
 * wiki with semantic search, incremental ingestion, and lint checks.
 *
 * Inspired by Vannevar Bush's Memex (1945) and Karpathy's LLM Wiki pattern.
 */

// Types
export type {
  SourceType,
  KnowledgeSource,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelationship,
  KnowledgeIR,
  ClaimSelector,
  WikiPage,
  WikiIndex,
  IngestionLogEntry,
  KnowledgeBase,
  Contradiction,
  KnowledgeConfidenceTier,
  KnowledgeResult,
  LintSeverity,
  LintFinding,
  LintReport,
  IngestResult,
  KnowledgeSchema,
  LintRuleConfig,
  MemexOutputConfig,
  MemexCompilerConfig,
  MemexConfig,
  MemexCompileResult,
} from './types.js';

// Config
export {
  DEFAULT_MEMEX_CONFIG,
  DEFAULT_KNOWLEDGE_SCHEMA,
  loadMemexConfig,
  saveMemexConfig,
  loadKnowledgeSchema,
  saveKnowledgeSchema,
} from './config.js';

// Source Reader
export {
  inferSourceType,
  hashFileContents,
  discoverSources,
  generateSourceId,
  readSource,
  readSources,
  stripMarkdown,
} from './source-reader.js';
export type { SourceContent } from './source-reader.js';

// Claim Extractor
export {
  extractKnowledge,
  extractKnowledgeBatch,
  splitSentences,
  extractClaims,
  extractEntities,
  extractEntityMentions,
  extractRelationships,
  mergeKnowledgeIRs,
  generateClaimId,
  slugify,
} from './claim-extractor.js';

// Knowledge Compiler
export {
  compile,
  ingest,
  cosineSimilarity,
  serializeKnowledgeBase,
  deserializeKnowledgeBase,
} from './knowledge-compiler.js';
export type { CompileOptions } from './knowledge-compiler.js';

// Wiki Emitter
export {
  emitWikiPages,
  emitWikiIndex,
  renderIndexMarkdown,
  renderLogMarkdown,
  estimateTokens,
} from './wiki-emitter.js';

// Resolver
export {
  resolve as resolveQuery,
  computeTier,
  DEFAULT_KNOWLEDGE_THRESHOLDS,
} from './resolver.js';
export type { KnowledgeTierThresholds, ResolverOptions } from './resolver.js';

// Lint
export {
  lint,
  listLintRules,
} from './lint.js';
