/**
 * Memex Module Types — the knowledge base compiler.
 *
 * Inspired by Vannevar Bush's Memex (1945) and Karpathy's LLM Wiki pattern:
 * instead of re-deriving knowledge on every query (RAG), compile sources once
 * into a persistent, cross-referenced knowledge base and keep it current.
 *
 * Maps onto smallchat's existing architecture:
 *   KnowledgeSource  → ProviderManifest  (input to the compiler)
 *   ExtractedClaim   → ParsedTool        (intermediate representation)
 *   ClaimSelector    → ToolSelector      (semantic fingerprint)
 *   WikiPage         → ToolIMP           (the thing you resolve to)
 *   KnowledgeBase    → CompilationResult (compiled artifact)
 *   KnowledgeSchema  → SmallChatManifest (domain configuration)
 */

// ---------------------------------------------------------------------------
// Knowledge sources — the raw inputs to compilation
// ---------------------------------------------------------------------------

/** Supported source document types. */
export type SourceType =
  | 'markdown'
  | 'text'
  | 'html'
  | 'pdf'
  | 'csv'
  | 'jsonl'
  | 'transcript';

/** A single knowledge source document. */
export interface KnowledgeSource {
  /** Unique identifier for this source. */
  id: string;
  /** Source document type. */
  type: SourceType;
  /** Absolute path to the source file. */
  path: string;
  /** Optional descriptive title. */
  title?: string;
  /** User-supplied metadata tags. */
  metadata?: Record<string, string>;
  /** SHA-256 hash of file contents — used for incremental change detection. */
  contentHash?: string;
  /** ISO timestamp of last ingestion. */
  lastIngested?: string;
  /** Byte length of source at last ingestion. */
  sizeBytes?: number;
}

// ---------------------------------------------------------------------------
// Extracted claims — the intermediate representation
// ---------------------------------------------------------------------------

/** A single factual claim extracted from a source document. */
export interface ExtractedClaim {
  /** Unique claim identifier (deterministic from source + span). */
  id: string;
  /** The claim text in normalized form. */
  text: string;
  /** Entity names mentioned in this claim. */
  entities: string[];
  /** Source document ID (provenance). */
  sourceId: string;
  /** Character offsets [start, end] in the source document. */
  sourceSpan: [number, number];
  /** Extraction confidence (0–1). */
  confidence: number;
  /** Temporal context — when the claim was made, if applicable. */
  timestamp?: string;
  /** Section heading this claim was found under. */
  section?: string;
}

/** An entity extracted from source documents. */
export interface ExtractedEntity {
  /** Unique entity ID (slug form). */
  id: string;
  /** Entity type (from schema's entityTypes). */
  type: string;
  /** Human-readable display name. */
  name: string;
  /** Optional properties. */
  properties?: Record<string, string>;
  /** Source IDs where this entity was found. */
  sourceIds: string[];
  /** Number of claims that mention this entity. */
  claimCount: number;
}

/** A relationship between two entities. */
export interface ExtractedRelationship {
  /** Source entity ID. */
  from: string;
  /** Target entity ID. */
  to: string;
  /** Relationship label (e.g., "rules", "located-in", "part-of"). */
  relation: string;
  /** Claim ID that established this relationship. */
  establishedBy: string;
  /** Optional properties. */
  properties?: Record<string, string>;
}

/** Intermediate representation — output of the extraction phase. */
export interface KnowledgeIR {
  /** All claims extracted from a single source. */
  claims: ExtractedClaim[];
  /** Entities discovered. */
  entities: ExtractedEntity[];
  /** Relationships between entities. */
  relationships: ExtractedRelationship[];
  /** Source ID this IR was produced from. */
  sourceId: string;
}

// ---------------------------------------------------------------------------
// Claim selectors — semantic fingerprints for claims
// ---------------------------------------------------------------------------

/** A claim with its embedding — the knowledge analog of ToolSelector. */
export interface ClaimSelector {
  /** Embedding vector. */
  vector: Float32Array;
  /** Canonical claim text (used as the lookup key). */
  canonical: string;
  /** Entity IDs mentioned in this claim. */
  entityIds: string[];
  /** Source claim ID. */
  claimId: string;
}

// ---------------------------------------------------------------------------
// Wiki pages — compiled output
// ---------------------------------------------------------------------------

/** A single page in the compiled wiki. */
export interface WikiPage {
  /** URL-safe slug (e.g., "numenor", "battle-of-pelennor-fields"). */
  slug: string;
  /** Human-readable title. */
  title: string;
  /** Compiled markdown content. */
  content: string;
  /** Page type (from schema's pageTemplates). */
  pageType: 'entity' | 'topic' | 'index' | 'log';
  /** Claim IDs that back this page. */
  claimIds: string[];
  /** Entity IDs referenced on this page. */
  entityIds: string[];
  /** Slugs of pages that link to this page. */
  inboundLinks: string[];
  /** Slugs of pages this page links to. */
  outboundLinks: string[];
  /** Source IDs that contributed to this page. */
  sourceIds: string[];
  /** ISO timestamp of last update. */
  lastUpdated: string;
  /** Estimated token count of the content. */
  tokenCount: number;
}

/** The index page — Karpathy's index.md, a category-organized catalog. */
export interface WikiIndex {
  /** Category → page slugs mapping. */
  categories: Record<string, string[]>;
  /** Total page count. */
  pageCount: number;
  /** Total claim count across all pages. */
  claimCount: number;
  /** ISO timestamp of last rebuild. */
  lastRebuilt: string;
}

/** The ingestion log — Karpathy's log.md, append-only. */
export interface IngestionLogEntry {
  /** ISO timestamp. */
  timestamp: string;
  /** What happened. */
  action: 'ingest' | 'update' | 'remove' | 'lint' | 'recompile';
  /** Source ID affected. */
  sourceId: string;
  /** Human-readable summary. */
  summary: string;
  /** Page slugs that were created or updated. */
  pagesAffected: string[];
  /** Number of new claims extracted. */
  claimsAdded: number;
  /** Number of claims removed or superseded. */
  claimsRemoved: number;
}

// ---------------------------------------------------------------------------
// Knowledge base — the compiled artifact
// ---------------------------------------------------------------------------

/** The compiled knowledge base artifact — analog of CompilationResult. */
export interface KnowledgeBase {
  /** Schema that governed this compilation. */
  schema: KnowledgeSchema;
  /** All wiki pages keyed by slug. */
  pages: Map<string, WikiPage>;
  /** All claims keyed by ID. */
  claims: Map<string, ExtractedClaim>;
  /** All entities keyed by ID. */
  entities: Map<string, ExtractedEntity>;
  /** All relationships. */
  relationships: ExtractedRelationship[];
  /** Claim selectors (embedded claims) keyed by claim ID. */
  claimSelectors: Map<string, ClaimSelector>;
  /** The wiki index page. */
  index: WikiIndex;
  /** The ingestion log. */
  log: IngestionLogEntry[];
  /** Source registry — all ingested sources. */
  sources: Map<string, KnowledgeSource>;

  // --- Compilation stats ---
  /** Total sources compiled. */
  sourceCount: number;
  /** Total claims extracted. */
  claimCount: number;
  /** Claims deduplicated (merged due to high similarity). */
  mergedClaimCount: number;
  /** Total entities discovered. */
  entityCount: number;
  /** Total wiki pages generated. */
  pageCount: number;
  /** Contradictions detected during compilation. */
  contradictions: Contradiction[];
  /** ISO timestamp of compilation. */
  compiledAt: string;
  /** Artifact format version. */
  version: string;
}

// ---------------------------------------------------------------------------
// Contradictions — detected during Link phase
// ---------------------------------------------------------------------------

/** A contradiction between two claims from different sources. */
export interface Contradiction {
  /** First claim ID. */
  claimA: string;
  /** Second claim ID. */
  claimB: string;
  /** Cosine similarity between the two claims. */
  similarity: number;
  /** Why these are contradictory (heuristic explanation). */
  reason: string;
  /** Severity of the contradiction. */
  severity: 'info' | 'warning' | 'critical';
  /** Entity IDs involved. */
  entityIds: string[];
}

// ---------------------------------------------------------------------------
// Query resolution — confidence-tiered dispatch for knowledge
// ---------------------------------------------------------------------------

/** Confidence tier for knowledge query resolution. */
export type KnowledgeConfidenceTier =
  | 'EXACT'    // Direct page match
  | 'HIGH'     // Strong claim match, return page + highlight
  | 'MEDIUM'   // Moderate match, synthesize from multiple pages
  | 'LOW'      // Weak match, decompose into sub-queries
  | 'NONE';    // No match, suggest related pages

/** A single result from knowledge query resolution. */
export interface KnowledgeResult {
  /** The query that was resolved. */
  query: string;
  /** Confidence tier of the resolution. */
  tier: KnowledgeConfidenceTier;
  /** The primary wiki page (if resolved). */
  page: WikiPage | null;
  /** Claims that matched the query, ranked by relevance. */
  matchedClaims: Array<{
    claim: ExtractedClaim;
    score: number;
  }>;
  /** Related pages (for LOW/NONE tiers). */
  relatedPages: Array<{
    page: WikiPage;
    relevance: number;
  }>;
  /** Sub-queries (for LOW tier decomposition). */
  subQueries?: string[];
  /** Synthesized answer text (for MEDIUM tier). */
  synthesis?: string;
}

// ---------------------------------------------------------------------------
// Lint — knowledge base health checks
// ---------------------------------------------------------------------------

/** Lint rule severity. */
export type LintSeverity = 'info' | 'warning' | 'error';

/** A single lint finding. */
export interface LintFinding {
  /** Rule that produced this finding. */
  rule: string;
  /** Severity level. */
  severity: LintSeverity;
  /** Human-readable description. */
  message: string;
  /** Affected page slugs. */
  pages: string[];
  /** Affected claim IDs. */
  claims: string[];
  /** Affected entity IDs. */
  entities: string[];
  /** Suggested fix. */
  suggestion?: string;
}

/** Complete lint report. */
export interface LintReport {
  /** All findings. */
  findings: LintFinding[];
  /** Finding counts by severity. */
  counts: Record<LintSeverity, number>;
  /** Overall pass/fail. */
  passed: boolean;
  /** ISO timestamp. */
  checkedAt: string;
  /** Human-readable summary. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Ingestion — incremental update results
// ---------------------------------------------------------------------------

/** Result of an incremental ingestion operation. */
export interface IngestResult {
  /** Source that was ingested. */
  source: KnowledgeSource;
  /** New claims added. */
  claimsAdded: number;
  /** Existing claims updated. */
  claimsUpdated: number;
  /** Claims removed (source content changed). */
  claimsRemoved: number;
  /** Pages created or updated. */
  pagesAffected: string[];
  /** New contradictions introduced. */
  newContradictions: Contradiction[];
  /** Log entry for this ingestion. */
  logEntry: IngestionLogEntry;
}

// ---------------------------------------------------------------------------
// Configuration — the knowledge schema
// ---------------------------------------------------------------------------

/** Knowledge schema — the domain configuration document (Karpathy's CLAUDE.md). */
export interface KnowledgeSchema {
  /** Knowledge base name. */
  name: string;
  /** Domain description (e.g., "tolkien-lore", "health-tracking"). */
  domain: string;
  /** Version of this schema. */
  version?: string;
  /** Allowed entity types for this domain. */
  entityTypes: string[];
  /** Allowed relationship types. */
  relationTypes?: string[];
  /** Page templates keyed by page type. */
  pageTemplates?: Record<string, string>;
  /** Source directories or file globs. */
  sources: string[];
  /** Extraction hints — domain-specific guidance for claim extraction. */
  extractionHints?: string;
  /** Lint rules to enable/disable. */
  lintRules?: LintRuleConfig;
  /** Output configuration. */
  output?: MemexOutputConfig;
  /** Compiler configuration. */
  compiler?: MemexCompilerConfig;
}

/** Lint rule configuration. */
export interface LintRuleConfig {
  /** Disable specific lint rules by name. */
  disabled?: string[];
  /** Contradiction similarity threshold (default 0.85). */
  contradictionThreshold?: number;
  /** Maximum staleness before warning (days, default 30). */
  stalenessThresholdDays?: number;
  /** Minimum claims per entity before warning (default 1). */
  minClaimsPerEntity?: number;
}

/** Output configuration for the compiled knowledge base. */
export interface MemexOutputConfig {
  /** Output path for the compiled artifact. */
  path?: string;
  /** Output format. */
  format?: 'json' | 'sqlite';
  /** Path to sqlite database (if format is sqlite). */
  dbPath?: string;
  /** Also export as markdown files to this directory. */
  markdownDir?: string;
}

/** Compiler configuration for knowledge compilation. */
export interface MemexCompilerConfig {
  /** Embedder to use. */
  embedder?: 'onnx' | 'local';
  /** Claim deduplication threshold (default 0.92). */
  deduplicationThreshold?: number;
  /** Contradiction detection threshold (default 0.85). */
  contradictionThreshold?: number;
  /** Minimum extraction confidence to keep a claim (default 0.5). */
  minConfidence?: number;
  /** Maximum claims per wiki page (default 50). */
  maxClaimsPerPage?: number;
}

// ---------------------------------------------------------------------------
// Memex configuration — runtime config (like DreamConfig)
// ---------------------------------------------------------------------------

/** Memex runtime configuration — controls how the compiler pipeline behaves. */
export interface MemexConfig {
  /** Path to the knowledge schema file. */
  schemaPath: string;
  /** Source directories/files (overrides schema.sources). */
  sourcePaths: string[];
  /** Output artifact path. */
  outputPath: string;
  /** Embedder type. */
  embedder: 'onnx' | 'local';
  /** Enable watch mode for incremental ingestion. */
  watch: boolean;
  /** Maximum retained artifact versions. */
  maxRetainedVersions: number;
}

// ---------------------------------------------------------------------------
// Compilation pipeline result
// ---------------------------------------------------------------------------

/** Result returned by the knowledge compiler pipeline. */
export interface MemexCompileResult {
  /** The compiled knowledge base. */
  knowledgeBase: KnowledgeBase;
  /** Path to the written artifact (or null if dry-run). */
  artifactPath: string | null;
  /** Human-readable compilation report. */
  report: string;
  /** Warnings generated during compilation. */
  warnings: string[];
}
