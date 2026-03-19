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
}

export interface CompilationResult {
  selectors: Map<string, ToolSelector>;
  dispatchTables: Map<string, Map<string, ToolIMP>>;
  protocols: ToolProtocol[];
  toolCount: number;
  uniqueSelectorCount: number;
  mergedCount: number;
  collisions: SelectorCollision[];
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
