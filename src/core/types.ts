/**
 * Core type definitions for ToolKit.
 *
 * Maps directly from the Smalltalk/Objective-C object model:
 *   Object    → ToolProvider
 *   Class     → ToolClass
 *   SEL       → ToolSelector
 *   IMP       → ToolIMP
 *   Method    → ToolMethod
 *   Protocol  → ToolProtocol
 *   Category  → ToolCategory
 */

// ---------------------------------------------------------------------------
// Selector — the semantic fingerprint of a tool intent
// ---------------------------------------------------------------------------

export interface ToolSelector {
  /** Embedding vector — the "interned string" equivalent. This IS the selector. */
  vector: Float32Array;

  /** Human-readable canonical form, e.g. "search:documents:scope" */
  canonical: string;

  /** Selector components split on colons */
  parts: string[];

  /** Number of expected argument slots */
  arity: number;
}

// ---------------------------------------------------------------------------
// IMP — everything needed to execute a tool
// ---------------------------------------------------------------------------

export type TransportType = 'mcp' | 'rest' | 'local' | 'grpc';

export interface ToolResult {
  content: unknown;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface JSONSchemaType {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: JSONSchemaType;
  properties?: Record<string, JSONSchemaType>;
  required?: string[];
  default?: unknown;
}

export interface ArgumentSpec {
  name: string;
  type: JSONSchemaType;
  description: string;
  /** Semantic embedding of this argument's purpose */
  embedding?: Float32Array;
  enum?: unknown[];
  default?: unknown;
  required: boolean;
}

export interface ArgumentConstraints {
  required: ArgumentSpec[];
  optional: ArgumentSpec[];
  validate(args: Record<string, unknown>): ValidationResult;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JSONSchemaType;
  arguments: ArgumentSpec[];
}

export interface ToolIMP {
  /** Which provider owns this tool */
  providerId: string;
  /** Concrete tool name */
  toolName: string;
  /** Transport mechanism */
  transportType: TransportType;
  /** Full schema — null until first dispatch (lazy like NSProxy) */
  schema: ToolSchema | null;
  /** Loads the full schema on demand */
  schemaLoader: () => Promise<ToolSchema>;
  /** Execute the tool */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
  /** Argument type constraints */
  constraints: ArgumentConstraints;
}

// ---------------------------------------------------------------------------
// Method = Selector + IMP
// ---------------------------------------------------------------------------

export interface ToolMethod {
  selector: ToolSelector;
  imp: ToolIMP;
}

// ---------------------------------------------------------------------------
// Protocol — capability interface
// ---------------------------------------------------------------------------

export interface ToolProtocol {
  name: string;
  /** What this capability "means" */
  embedding: Float32Array;
  /** Any conforming provider must handle these */
  requiredSelectors: ToolSelector[];
  /** Optional selectors */
  optionalSelectors: ToolSelector[];
}

// ---------------------------------------------------------------------------
// Category — capability extensions bolted onto a provider
// ---------------------------------------------------------------------------

export interface ToolCategory {
  name: string;
  /** Which protocol this extends */
  extendsProtocol: string;
  /** New methods this category adds */
  methods: ToolMethod[];
}

// ---------------------------------------------------------------------------
// Resolved tool — a cached dispatch resolution
// ---------------------------------------------------------------------------

export interface ResolvedTool {
  selector: ToolSelector;
  imp: ToolIMP;
  confidence: number;
  resolvedAt: number;
  hitCount: number;
  /** Provider ID + version tag at resolution time */
  providerVersion?: string;
  /** Model/embedder version tag at resolution time */
  modelVersion?: string;
  /** Schema fingerprint at resolution time — stale entries expire on mismatch */
  schemaFingerprint?: string;
}

// ---------------------------------------------------------------------------
// Search / match results
// ---------------------------------------------------------------------------

export interface SelectorMatch {
  id: string;
  distance: number;
}

export interface ToolCandidate {
  imp: ToolIMP;
  confidence: number;
  selector: ToolSelector;
}

// ---------------------------------------------------------------------------
// Streaming dispatch events — real-time UI feedback from dispatchStream
// ---------------------------------------------------------------------------

export interface DispatchEventResolving {
  type: 'resolving';
  intent: string;
}

export interface DispatchEventToolStart {
  type: 'tool-start';
  toolName: string;
  providerId: string;
  confidence: number;
  selector: string;
}

export interface DispatchEventChunk {
  type: 'chunk';
  content: unknown;
  /** Index of this chunk in the stream (0-based) */
  index: number;
}

export interface DispatchEventDone {
  type: 'done';
  result: ToolResult;
}

export interface DispatchEventError {
  type: 'error';
  error: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Progressive inference — token-level deltas from provider streams
// ---------------------------------------------------------------------------

/**
 * InferenceDelta — a single token/delta from an LLM provider stream.
 *
 * Maps directly to what OpenAI and Anthropic SSE streams emit:
 *   OpenAI:    choices[0].delta.content
 *   Anthropic: content_block_delta.delta.text
 */
export interface InferenceDelta {
  /** The token text (may be a partial word, whitespace, or punctuation) */
  text: string;
  /** Provider-specific finish reason, if this is the final delta */
  finishReason?: 'stop' | 'length' | 'tool_use' | 'end_turn' | null;
  /** Provider-assigned index (e.g. OpenAI choice index, Anthropic block index) */
  index?: number;
  /** Optional provider-specific metadata (logprobs, usage, etc.) */
  providerMeta?: Record<string, unknown>;
}

export interface DispatchEventInferenceDelta {
  type: 'inference-delta';
  delta: InferenceDelta;
  /** Running character count across all deltas in this stream */
  tokenIndex: number;
}

export type DispatchEvent =
  | DispatchEventResolving
  | DispatchEventToolStart
  | DispatchEventChunk
  | DispatchEventInferenceDelta
  | DispatchEventDone
  | DispatchEventError;

// ---------------------------------------------------------------------------
// Compiler types
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchemaType;
  providerId: string;
  transportType: TransportType;
}

export interface ProviderManifest {
  id: string;
  name: string;
  tools: ToolDefinition[];
  transportType: TransportType;
  endpoint?: string;
  /** Opaque version string — cache entries tagged with this expire on change */
  version?: string;
}

export interface CompilationResult {
  selectors: Map<string, ToolSelector>;
  dispatchTables: Map<string, Map<string, ToolIMP>>;
  protocols: ToolProtocol[];
  toolCount: number;
  uniqueSelectorCount: number;
  mergedCount: number;
  collisions: SelectorCollision[];
  /** Overload tables keyed by selector canonical name */
  overloadTables: Map<string, OverloadTableData>;
  /** Diagnostic info about compiler-generated semantic overloads */
  semanticOverloads: SemanticOverloadGroup[];
}

/** Serializable representation of an overload table (for compilation output) */
export interface OverloadTableData {
  selectorCanonical: string;
  overloads: OverloadEntryData[];
}

export interface OverloadEntryData {
  signatureKey: string;
  parameterNames: string[];
  parameterTypes: string[];
  arity: number;
  toolName: string;
  providerId: string;
  isSemanticOverload: boolean;
}

/** A group of semantically similar tools that were overloaded together */
export interface SemanticOverloadGroup {
  canonicalSelector: string;
  tools: Array<{ providerId: string; toolName: string; similarity: number }>;
  /** Why these tools were grouped */
  reason: string;
}

export interface SelectorCollision {
  selectorA: string;
  selectorB: string;
  similarity: number;
  hint: string;
}

// ---------------------------------------------------------------------------
// Embedder interface — abstracts the embedding model
// ---------------------------------------------------------------------------

export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
}

// ---------------------------------------------------------------------------
// Vector index interface
// ---------------------------------------------------------------------------

export interface VectorIndex {
  insert(id: string, vector: Float32Array): void;
  search(vector: Float32Array, topK: number, threshold: number): SelectorMatch[];
  remove(id: string): void;
  size(): number;
}

// ---------------------------------------------------------------------------
// Cache versioning — provider + model version tagging
// ---------------------------------------------------------------------------

/** Tracks current versions for cache entry tagging and staleness checks */
export interface CacheVersionContext {
  /** Map of providerId → current version string */
  providerVersions: Map<string, string>;
  /** Current model/embedder version — entries from a different model expire */
  modelVersion: string;
  /** Map of providerId → current schema fingerprint */
  schemaFingerprints: Map<string, string>;
}

/**
 * InvalidationHook — registered callback that fires on invalidation events.
 * Use for hot-reload coordination: the hook can trigger downstream cache
 * clears, re-compilation, or UI refresh without a full restart.
 */
export type InvalidationEvent =
  | { type: 'flush' }
  | { type: 'provider'; providerId: string }
  | { type: 'selector'; selector: ToolSelector }
  | { type: 'stale'; reason: 'provider-version' | 'model-version' | 'schema-change'; key: string };

export type InvalidationHook = (event: InvalidationEvent) => void;
