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
  /** When present, indicates the dispatch requires caller refinement (Pillar 4) */
  refinement?: ToolRefinementNeeded;
}

/**
 * ToolRefinementNeeded — returned when confidence is NONE and the runtime
 * cannot resolve the intent. The caller should present the options to the
 * user and re-dispatch with the refined intent.
 */
export interface ToolRefinementNeeded {
  type: 'tool_refinement_needed';
  originalIntent: string;
  question: string;
  options: Array<{
    label: string;
    intent: string;
    confidence: number;
  }>;
  narrowedIntents: string[];
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
  /** Optional MCP Apps ui:// resource URI — present when this tool has an interactive view */
  uiUri?: string;
  /** Visibility for the UI resource: which audiences can invoke it */
  uiVisibility?: Array<'model' | 'app'>;
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

// ---------------------------------------------------------------------------
// App/UI streaming events — MCP Apps Extension lifecycle events
// ---------------------------------------------------------------------------

/** Tool has an associated ui:// resource; host should prepare the iframe */
export interface DispatchEventUIAvailable {
  type: 'ui-available';
  componentUri: string;
  capabilities: string[];
  confidence: number;
  /** Which audiences can access this view ("model" | "app") */
  visibility: string[];
}

/** AppBridge connect() completed — view is initialized and ready */
export interface DispatchEventUIReady {
  type: 'ui-ready';
  displayMode: 'inline' | 'fullscreen' | 'pip';
}

/** Tool result delivered to the view via ui/notifications/tool-result */
export interface DispatchEventUIUpdate {
  type: 'ui-update';
  data: unknown;
}

/** View fired a tool call or message back through the host */
export interface DispatchEventUIInteraction {
  type: 'ui-interaction';
  event: string;
  sourceToolName: string;
  payload: unknown;
}

export type DispatchEvent =
  | DispatchEventResolving
  | DispatchEventToolStart
  | DispatchEventChunk
  | DispatchEventInferenceDelta
  | DispatchEventDone
  | DispatchEventError
  | DispatchEventUIAvailable
  | DispatchEventUIReady
  | DispatchEventUIUpdate
  | DispatchEventUIInteraction;

// ---------------------------------------------------------------------------
// Compiler hints — vendor-supplied directives that steer semantic mapping
// ---------------------------------------------------------------------------

/**
 * CompilerHint — an optional directive attached to a tool or provider that
 * influences how the compiler maps it into the selector table.
 *
 * Analogous to `__attribute__((objc_direct))` or `NS_SWIFT_NAME()` — metadata
 * that doesn't change what a tool *does*, but steers how it's compiled.
 */
export interface CompilerHint {
  /**
   * Additional semantic text appended to the tool description during embedding.
   * Use this to steer the vector into a different region of the semantic space.
   * e.g. "This tool is for file I/O, not network requests."
   */
  selectorHint?: string;

  /**
   * Pin this tool to a specific canonical selector, bypassing vector-based
   * interning entirely. The tool will be registered under this exact selector.
   * e.g. "files.read_file" — forces the canonical regardless of embedding.
   */
  pinSelector?: string;

  /**
   * Semantic aliases — additional intent phrases that should resolve to this tool.
   * Each alias is embedded and interned as an additional selector pointing to
   * the same IMP, expanding the tool's "catch surface" in the vector space.
   * e.g. ["download file", "fetch document", "get blob"]
   */
  aliases?: string[];

  /**
   * Priority multiplier for dispatch ranking (default 1.0).
   * Values > 1.0 boost this tool in ambiguous resolutions.
   * Values < 1.0 demote it (useful for deprecated tools).
   * e.g. 1.5 makes this tool 50% more likely to win ties.
   */
  priority?: number;

  /**
   * Mark this tool as the preferred resolution when multiple tools collide
   * within the collision threshold. Only one tool per collision group should
   * set this to true — the compiler warns if multiple do.
   */
  preferred?: boolean;

  /**
   * Exclude this tool from compilation entirely. Useful for vendors who ship
   * tools that are platform-specific or require opt-in activation.
   */
  exclude?: boolean;

  /**
   * Vendor-defined opaque metadata — passed through to the artifact unchanged.
   * Vendors can store build config, feature flags, or registry metadata here.
   */
  vendorMeta?: Record<string, unknown>;
}

/**
 * ProviderCompilerHints — hints applied at the provider (MCP server) level.
 * These act as defaults for all tools in the manifest and can be overridden
 * per-tool.
 */
export interface ProviderCompilerHints {
  /**
   * Default priority multiplier for all tools from this provider.
   */
  priority?: number;

  /**
   * Namespace prefix prepended to all selector canonicals from this provider.
   * e.g. "vendor.github" → selectors become "vendor.github.search_code"
   */
  namespace?: string;

  /**
   * Semantic context appended to ALL tool descriptions from this provider
   * during embedding. Useful for disambiguating providers that overlap.
   * e.g. "All tools in this set operate on the GitHub REST API v4."
   */
  selectorHint?: string;

  /**
   * Vendor-defined opaque metadata — passed through to the artifact unchanged.
   */
  vendorMeta?: Record<string, unknown>;
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
  /** Optional compiler hints that steer semantic mapping for this tool */
  compilerHints?: CompilerHint;
  /** MCP Apps ui:// resource URI declared in _meta.ui.resourceUri */
  uiResourceUri?: string;
  /** MCP Apps visibility — which audiences can invoke the view */
  uiVisibility?: Array<'model' | 'app'>;
}

export interface ProviderManifest {
  id: string;
  name: string;
  tools: ToolDefinition[];
  transportType: TransportType;
  endpoint?: string;
  /** Opaque version string — cache entries tagged with this expire on change */
  version?: string;
  /** Provider-level compiler hints — defaults for all tools in this manifest */
  compilerHints?: ProviderCompilerHints;
  /** Channel metadata — present when this provider is a Claude Code channel */
  channel?: {
    /** Whether this provider is a channel */
    isChannel: boolean;
    /** Whether the channel is two-way (has reply tool) */
    twoWay: boolean;
    /** Whether permission relay is supported */
    permissionRelay: boolean;
    /** Name of the reply tool (if two-way) */
    replyToolName?: string;
    /** Channel-specific instructions text */
    instructions?: string;
  };
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
  /** Compiled app/UI artifact — present when any tools declare uiResourceUri */
  appArtifact?: AppArtifact;
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
  search(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] | Promise<SelectorMatch[]>;
  remove(id: string): void;
  size(): number | Promise<number>;
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
  | { type: 'stale'; reason: 'provider-version' | 'model-version' | 'schema-change'; key: string }
  | { type: 'ui-resource'; uri: string };

export type InvalidationHook = (event: InvalidationEvent) => void;

// ---------------------------------------------------------------------------
// MCP Apps Extension — App/UI types (io.modelcontextprotocol/ui, spec 2026-01-26)
//
// Maps the Obj-C object model onto interactive UI component dispatch:
//   ComponentSelector  → SEL  (semantic fingerprint of a UI intent)
//   AppIMP             → IMP  (ui:// URI + capabilities; the "display method pointer")
//   AppClass           → Class (component dispatch table per provider)
//   AppProtocol        → Protocol (UI capability interface, e.g. ChartProtocol)
//   AppExtension       → Category (adds component types to an existing AppProtocol)
//   AppCompilerHint    → __attribute__ / NS_SWIFT_NAME (steers component compilation)
// ---------------------------------------------------------------------------

/**
 * ComponentSelector — SEL equivalent for UI dispatch.
 * Identical shape to ToolSelector; kept separate so tool and component
 * intent spaces remain distinct (separate VectorIndex instances).
 */
export interface ComponentSelector {
  vector: Float32Array;
  canonical: string;
  parts: string[];
  arity: number;
}

/**
 * AppIMP — IMP equivalent for UI components.
 * Everything needed to mount an MCP Apps view.
 */
export interface AppIMP {
  /** Provider that owns this component */
  providerId: string;
  /** Tool name this view is associated with */
  toolName: string;
  /** The ui:// resource URI, e.g. "ui://weather/view.html" */
  componentUri: string;
  /** MCP Apps MIME type */
  mimeType: 'text/html;profile=mcp-app';
  /** Semantic capability tags, e.g. ["chart", "interactive", "resizable"] */
  capabilities: string[];
  /**
   * Which audiences can invoke this view.
   * "model" = AI only, "app" = UI only, both = unrestricted.
   */
  visibility: Array<'model' | 'app'>;
  /** CSP metadata from McpUiResourceMeta */
  csp?: { allowedDomains?: string[] };
  /** Preferred initial display mode */
  preferredDisplayMode?: 'inline' | 'fullscreen' | 'pip';
  /** Check whether this component handles a given capability tag */
  supportsCapability(cap: string): boolean;
}

/** AppMethod = ComponentSelector + AppIMP (mirrors ToolMethod) */
export interface AppMethod {
  selector: ComponentSelector;
  imp: AppIMP;
}

/**
 * AppProtocol — Protocol equivalent for UI capability interfaces.
 * e.g. ChartProtocol requires render(data) + zoom() + pan() components.
 */
export interface AppProtocol {
  name: string;
  embedding: Float32Array;
  requiredComponents: ComponentSelector[];
  optionalComponents: ComponentSelector[];
}

/**
 * AppExtension — Category equivalent.
 * Adds new component types to an existing AppProtocol without modifying
 * the base AppClass. e.g. a "Maps" extension adds geo-view to DataVizProtocol.
 */
export interface AppExtension {
  name: string;
  extendsProtocol: string;
  methods: AppMethod[];
}

/**
 * AppCompilerHint — build-time directive that steers component compilation.
 * Analogous to CompilerHint for tools.
 */
export interface AppCompilerHint {
  /** Semantic steering text appended to the component description during embedding */
  componentHint?: string;
  /** Pin to a specific canonical component selector, bypassing vector interning */
  pinComponent?: string;
  /** Additional UI intent phrases: "show as chart", "visualize data" */
  componentAliases?: string[];
  /** Pre-fetch the ui:// HTML on runtime mount (hot-path hint) */
  preload?: boolean;
  /** Preferred display mode hint */
  displayModePreference?: 'inline' | 'fullscreen' | 'pip';
}

/**
 * AppArtifact — the compiled output of AppCompiler.
 * Stored in CompilationResult.appArtifact when any tools declare uiResourceUri.
 */
export interface AppArtifact {
  /** AppClass dispatch tables keyed by providerId */
  appClasses: Map<string, SerializedAppClass>;
  /** ComponentSelector table — canonical → serialized selector */
  componentSelectors: Map<string, SerializedComponentSelector>;
  /** Total number of compiled UI components */
  componentCount: number;
  /** ISO timestamp of compilation */
  compiledAt: string;
}

/** Wire-format representation of an AppClass (JSON-serializable) */
export interface SerializedAppClass {
  providerId: string;
  name: string;
  /** canonical → AppIMP */
  componentDispatchTable: Record<string, SerializedAppIMP>;
  superclassName?: string;
  protocolNames: string[];
}

/** Wire-format representation of an AppIMP */
export interface SerializedAppIMP {
  providerId: string;
  toolName: string;
  componentUri: string;
  capabilities: string[];
  visibility: string[];
  csp?: { allowedDomains?: string[] };
  preferredDisplayMode?: string;
}

/** Wire-format representation of a ComponentSelector */
export interface SerializedComponentSelector {
  canonical: string;
  parts: string[];
  arity: number;
  vector: number[];   // Float32Array serialized as plain number[]
}
