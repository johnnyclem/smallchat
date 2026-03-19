// ToolKit — A Message-Passing Tool Compiler
// v0.0.1

// Core types
export type {
  ArgumentConstraints,
  ArgumentSpec,
  CompilationResult,
  Embedder,
  JSONSchemaType,
  ProviderManifest,
  ResolvedTool,
  SelectorCollision,
  SelectorMatch,
  ToolCandidate,
  ToolCategory,
  ToolDefinition,
  ToolIMP,
  ToolMethod,
  ToolProtocol,
  ToolResult,
  ToolSchema,
  ToolSelector,
  TransportType,
  ValidationError,
  ValidationResult,
  VectorIndex,
} from './core/types.js';

// Core classes
export { SelectorTable, canonicalize } from './core/selector-table.js';
export { ResolutionCache } from './core/resolution-cache.js';
export { ToolClass, ToolProxy } from './core/tool-class.js';

// Runtime
export { DispatchContext, UnrecognizedIntent, toolkit_dispatch } from './runtime/dispatch.js';
export { ToolRuntime } from './runtime/runtime.js';
export type { RuntimeOptions } from './runtime/runtime.js';

// Compiler
export { ToolCompiler } from './compiler/compiler.js';
export type { CompilerOptions } from './compiler/compiler.js';
export { parseMCPManifest, parseOpenAPISpec, parseRawSchema } from './compiler/parser.js';
export type { ParsedTool } from './compiler/parser.js';

// Embedding
export { LocalEmbedder } from './embedding/local-embedder.js';
export { MemoryVectorIndex } from './embedding/memory-vector-index.js';
