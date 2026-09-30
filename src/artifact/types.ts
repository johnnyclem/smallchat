/**
 * Artifact format 1.0 — types.
 *
 * The JSON Schema in spec/artifact/artifact.v1.schema.json is the normative
 * definition; these types mirror it. See src/artifact/index.ts for the API.
 */

import type {
  EmbedderFingerprint,
  LaunchSpec,
  ToolAnnotations,
  TransportType,
} from '../core/types.js';

export type { EmbedderFingerprint, LaunchSpec, StdioLaunchSpec, RemoteLaunchSpec, ToolAnnotations } from '../core/types.js';

/** The only format version this release reads and writes. */
export const ARTIFACT_FORMAT_VERSION = '1.0' as const;

/** One upstream server (MCP server, REST API, local handler set). */
export interface ArtifactProvider {
  /** Provider id; never contains '/' */
  id: string;
  name: string;
  transportType: TransportType;
  version?: string;
  /** How to start or reach the upstream server, when known */
  launch?: LaunchSpec;
  /** Provider-level compiler hints, passed through unchanged */
  compilerHints?: Record<string, unknown>;
  /** Present when the provider is a Claude Code channel */
  channel?: {
    isChannel: boolean;
    twoWay: boolean;
    permissionRelay: boolean;
    replyToolName?: string;
    instructions?: string;
  };
}

/** One upstream tool, keyed in the artifact by its canonical id. */
export interface ArtifactTool {
  /** Canonical tool id: `<providerId>/<name>` */
  id: string;
  providerId: string;
  /** Upstream tool name, verbatim */
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  transportType: TransportType;
  /** Canonical of the tool's primary selector (a key of `selectors`) */
  selector: string;
  /** Tool-level compiler hints, passed through unchanged */
  compilerHints?: Record<string, unknown>;
  /** MCP Apps view, when the tool declares one */
  ui?: { resourceUri: string; visibility?: Array<'model' | 'app'> };
}

/** A dispatchable selector: one embedding pointing at exactly one tool. */
export interface ArtifactSelector {
  canonical: string;
  /** The tool this selector dispatches to */
  toolId: string;
  /** 'tool' for a tool's primary selector, 'alias' for a compiler-hint alias */
  kind: 'tool' | 'alias';
  /** Embedding produced by the artifact's embedder (length = embedder.dims) */
  vector: number[];
}

export interface ArtifactCollision {
  selectorA: string;
  selectorB: string;
  similarity: number;
  hint: string;
}

/** Two distinct tools compiled under --allow-duplicates (never merged). */
export interface ArtifactDuplicate {
  toolA: string;
  toolB: string;
  selectorA: string;
  selectorB: string;
  similarity: number;
}

export interface ArtifactStats {
  toolCount: number;
  selectorCount: number;
  providerCount: number;
  collisionCount: number;
  duplicateCount: number;
}

/** A compiled toolkit artifact, format 1.0. */
export interface ArtifactV1 {
  formatVersion: typeof ARTIFACT_FORMAT_VERSION;
  /** The embedder every selector vector was produced with */
  embedder: EmbedderFingerprint;
  providers: Record<string, ArtifactProvider>;
  tools: Record<string, ArtifactTool>;
  selectors: Record<string, ArtifactSelector>;
  collisions: ArtifactCollision[];
  duplicates: ArtifactDuplicate[];
  stats: ArtifactStats;
  /** Tool-specific metadata (covered by contentHash; ignored by loaders) */
  extensions?: Record<string, unknown>;
  /**
   * sha256hex(UTF8("smallchat.artifact.v1") || 0x00 ||
   *           UTF8(JCS(artifact without contentHash)))
   */
  contentHash: string;
}

/** Thrown when a file is not a valid, intact 1.0 artifact. */
export class ArtifactFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactFormatError';
  }
}

/** Thrown when a file is an artifact from an older (or newer) format. */
export class ArtifactVersionError extends ArtifactFormatError {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactVersionError';
  }
}

/** Thrown when an embedder does not match an artifact's fingerprint. */
export class EmbedderMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedderMismatchError';
  }
}
