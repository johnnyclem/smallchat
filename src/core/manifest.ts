/**
 * SmallChatManifest — the project-level manifest (`smallchat.json`).
 *
 * Analogous to `package.json` in Node or `Package.swift` in SPM.
 * Declares which pre-compiled vendor tool packages to include,
 * compiler options, and output configuration.
 *
 * Example smallchat.json:
 * ```json
 * {
 *   "name": "my-agent",
 *   "version": "1.0.0",
 *   "dependencies": {
 *     "@smallchat/github": "^1.0.0",
 *     "@smallchat/slack": "^2.1.0",
 *     "acme-internal-tools": "./vendor/acme-tools.json"
 *   },
 *   "compiler": {
 *     "embedder": "onnx",
 *     "deduplicationThreshold": 0.95,
 *     "collisionThreshold": 0.89,
 *     "generateSemanticOverloads": true
 *   },
 *   "output": {
 *     "path": "tools.toolkit.json",
 *     "format": "json"
 *   }
 * }
 * ```
 */

import type { CompilerHint, ProviderCompilerHints } from './types.js';

// ---------------------------------------------------------------------------
// Project manifest — smallchat.json
// ---------------------------------------------------------------------------

export interface SmallChatManifest {
  /** Project name */
  name: string;

  /** Project version (semver) */
  version: string;

  /** Optional human-readable description */
  description?: string;

  /**
   * Dependencies — pre-compiled vendor tool packages.
   *
   * Keys are package names (scoped or unscoped), values are either:
   *   - A semver range (resolved from the registry): "@smallchat/github": "^1.0.0"
   *   - A local file path (resolved relative to smallchat.json): "./vendor/tools.json"
   *   - A URL to a remote manifest: "https://example.com/tools.json"
   */
  dependencies?: Record<string, string>;

  /**
   * Local manifest directories or files to include in compilation.
   * Paths are resolved relative to the smallchat.json location.
   * e.g. ["./manifests", "./extra/custom-manifest.json"]
   */
  manifests?: string[];

  /**
   * Compiler configuration — overrides CLI defaults.
   */
  compiler?: ManifestCompilerConfig;

  /**
   * Output configuration.
   */
  output?: ManifestOutputConfig;

  /**
   * Provider-level compiler hint overrides.
   * Keyed by provider ID — these merge with (and override) any hints
   * declared inside the provider's own manifest.
   *
   * This allows a project to tune vendor-supplied tools without
   * forking the vendor manifest.
   */
  providerHints?: Record<string, ProviderCompilerHints>;

  /**
   * Tool-level compiler hint overrides.
   * Keyed by fully-qualified tool name: "providerId.toolName"
   * These merge with (and override) any hints declared on the tool itself.
   *
   * e.g. { "github.search_code": { "priority": 1.5, "aliases": ["find code"] } }
   */
  toolHints?: Record<string, CompilerHint>;
}

export interface ManifestCompilerConfig {
  /** Embedder type: "onnx" or "local" */
  embedder?: string;
  /** Deduplication threshold (0–1, default 0.95) */
  deduplicationThreshold?: number;
  /** Collision warning threshold (0–1, default 0.89) */
  collisionThreshold?: number;
  /** Enable semantic overload generation */
  generateSemanticOverloads?: boolean;
  /** Semantic overload grouping threshold (0–1, default 0.82) */
  semanticOverloadThreshold?: number;
}

export interface ManifestOutputConfig {
  /** Output file path (relative to smallchat.json) */
  path?: string;
  /** Output format: "json" or "sqlite" */
  format?: 'json' | 'sqlite';
  /** SQLite database path (when format is "sqlite") */
  dbPath?: string;
}

// ---------------------------------------------------------------------------
// Pre-compiled vendor package — what a vendor publishes
// ---------------------------------------------------------------------------

/**
 * SmallChatPackage — the format of a pre-compiled vendor tool package.
 *
 * This is what gets resolved from a dependency declaration.
 * Think of it as a "compiled .framework" or "minified .js bundle" —
 * the vendor has already done the embedding and compilation, and the
 * consumer just links it in.
 */
export interface SmallChatPackage {
  /** Package name (matches the dependency key) */
  name: string;

  /** Package version (semver) */
  version: string;

  /** Human-readable description */
  description?: string;

  /** The vendor/author of this package */
  author?: string;

  /** License identifier (SPDX) */
  license?: string;

  /** Pre-compiled provider manifests included in this package */
  providers: PreCompiledProvider[];

  /**
   * Pre-computed embeddings for all tools.
   * Keyed by "providerId.toolName" → vector as number[].
   * When present, the compiler can skip re-embedding and use these directly.
   */
  embeddings?: Record<string, number[]>;

  /** Embedding model used to generate the pre-computed vectors */
  embeddingModel?: string;

  /** Embedding dimensions */
  embeddingDimensions?: number;

  /** Package-level metadata */
  metadata?: Record<string, unknown>;
}

/**
 * PreCompiledProvider — a provider manifest bundled inside a vendor package,
 * with compiler hints already baked in by the vendor.
 */
export interface PreCompiledProvider {
  /** Provider ID */
  id: string;

  /** Human-readable name */
  name: string;

  /** Transport type */
  transportType: 'mcp' | 'rest' | 'local' | 'grpc';

  /** Endpoint (for remote transports) */
  endpoint?: string;

  /** Provider version */
  version?: string;

  /** Provider-level compiler hints (set by the vendor) */
  compilerHints?: ProviderCompilerHints;

  /** Tool definitions with vendor-supplied compiler hints */
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    compilerHints?: CompilerHint;
  }>;
}
