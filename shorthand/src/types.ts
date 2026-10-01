/**
 * Core types for @shorthand/core
 * Progressive context compaction for LLMs.
 */

import type { SignalWeights } from './importance/types.js';

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * A single message in a conversation — the one message type every module
 * (compaction, importance, CRDT memory, truth bridge) consumes.
 */
export interface ConversationMessage {
  id: string;
  role: MessageRole;
  content: string;
  /**
   * Epoch milliseconds, or an ISO 8601 string as serialized transcripts
   * carry it. Use `normalizeTimestamp` before doing arithmetic on it.
   */
  timestamp: number | string;
  /** Optional metadata attached by the host application. */
  metadata?: Record<string, unknown>;
  /** Pre-computed embedding vector (optional — populated by the host's embedding layer). */
  embedding?: Float32Array;
  /** Tool call metadata, for `role: 'tool'` messages and assistant tool calls. */
  toolCall?: {
    name: string;
    input: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
  };
  /** Id of a prior message this one corrects/supersedes. */
  supersedes?: string;
}

/**
 * Normalize a message timestamp to epoch milliseconds.
 * Accepts epoch numbers and ISO 8601 strings; an unparseable string
 * yields NaN rather than throwing.
 */
export function normalizeTimestamp(ts: number | string): number {
  return typeof ts === 'string' ? new Date(ts).getTime() : ts;
}

// ---------------------------------------------------------------------------
// Compaction levels (LSM-tree model)
// ---------------------------------------------------------------------------

/** The five compaction levels, from hot (L0) to cold (L4). */
export enum CompactionLevel {
  /** Raw recent messages, verbatim. Full fidelity. */
  L0_MEMTABLE = 0,
  /** Conversational noise stripped, deduplication applied. */
  L1_COMPACTED = 1,
  /** Topic-clustered summaries with entity/decision extraction. */
  L2_SUMMARIES = 2,
  /** Entity-relationship graph. Nodes and edges only. */
  L3_GRAPH = 3,
  /** Core invariants that must survive indefinitely. */
  L4_INVARIANTS = 4,
}

// ---------------------------------------------------------------------------
// Tombstones (correction tracking)
// ---------------------------------------------------------------------------

export interface Tombstone {
  /**
   * Stable, content-derived id. Archived items point at it (`by`), and
   * `CompactionEngine.revertCorrection` takes it. Set by `RegexCompactor`
   * and `CompactionEngine.correct`.
   */
  id?: string;
  /** The content that was superseded. */
  supersededContent: string;
  /** Message ID where the original (now-wrong) statement was made. */
  originalMessageId: string;
  /** Message ID where the correction was made. */
  correctionMessageId: string;
  /** Why the original was invalidated. */
  reason: string;
  /** Timestamp of the correction. */
  timestamp: number;
  /** The entity or key being corrected, if identifiable. */
  key?: string;
  /** The new/corrected value. */
  correctedValue?: string;
  /**
   * How the correction is known. `explicit`: declared by the host through
   * `CompactionEngine.correct` — authoritative. `inferred`: detected by
   * `RegexCompactor` pattern matching — a low-confidence suggestion that is
   * applied (reversibly) but not proposed to the truth ledger by default.
   * Absent on tombstones built by hand or by the snapshot pipeline.
   */
  confidence?: 'explicit' | 'inferred';
}

// ---------------------------------------------------------------------------
// Entity-relationship graph (L3)
// ---------------------------------------------------------------------------

export type EntityType =
  | 'component'
  | 'schema'
  | 'decision'
  | 'constraint'
  | 'technology'
  | 'person'
  | 'concept'
  | 'artifact'
  | 'custom';

export interface Entity {
  name: string;
  type: EntityType;
  properties: Record<string, string>;
  /** Message ID where this entity was first mentioned. */
  firstMention: string;
  /** Message ID where this entity was last mentioned. */
  lastMention: string;
}

export type EdgeRelation =
  | 'depends_on'
  | 'replaces'
  | 'implements'
  | 'constrains'
  | 'rejected_in_favor_of'
  | 'related_to'
  | 'custom';

export interface Edge {
  source: string;
  target: string;
  relation: EdgeRelation;
  properties: Record<string, string>;
  /** Message ID where this relationship was established. */
  sourceMessage: string;
}

export interface KnowledgeGraph {
  entities: Map<string, Entity>;
  edges: Edge[];
}

// ---------------------------------------------------------------------------
// Decision tracking
// ---------------------------------------------------------------------------

export interface Decision {
  /** What was decided. */
  description: string;
  /** The chosen option. */
  chosen: string;
  /** Alternatives that were considered and rejected. */
  alternatives: Array<{ option: string; reason: string }>;
  /** Message ID where the decision was made. */
  messageId: string;
  /** Whether this decision was later superseded. */
  superseded: boolean;
  /** If superseded, the tombstone that invalidated it. */
  tombstoneId?: string;
  /**
   * Other tombstones that supersede it too. Reverting `tombstoneId` hands
   * the decision to the first of them still present instead of reviving it.
   */
  alsoBy?: string[];
}

// ---------------------------------------------------------------------------
// Topic summaries (L2)
// ---------------------------------------------------------------------------

export interface TopicSummary {
  /** Unique ID for this summary. */
  id: string;
  /** Short label for the topic. */
  topic: string;
  /** Structured summary of what happened. */
  summary: string;
  /** Decisions made within this topic. */
  decisions: Decision[];
  /** Entities referenced. */
  entityNames: string[];
  /** Range of message IDs covered. */
  messageRange: { first: string; last: string };
  /** Estimated token count of this summary. */
  tokenEstimate: number;
}

// ---------------------------------------------------------------------------
// Core invariants (L4)
// ---------------------------------------------------------------------------

export interface Invariant {
  key: string;
  value: string;
  /** Message ID where this invariant was established. */
  sourceMessage: string;
  /** Lamport timestamp for CRDT ordering. */
  timestamp: number;
  /** Set on archived invariants: the id of the tombstone that displaced it. */
  displacedBy?: string;
}

// ---------------------------------------------------------------------------
// L1 entries, code spans and the archive
// ---------------------------------------------------------------------------

/** One L1 entry: a message kept verbatim (noise dropped, never reworded). */
export interface CompactedEntry {
  originalMessageId: string;
  /** The message text, verbatim. Short replies may be folded in as `question → answer`. */
  compacted: string;
  importance: number;
  /** Epoch ms of the source message. */
  timestamp?: number;
  /** Role of the source message. */
  role?: MessageRole;
  /** Content hashes of the fenced code spans this entry contains (see `CompactedState.spans`). */
  spanIds?: string[];
  /** Short replies folded into this entry (`question → answer`). */
  foldedMessageIds?: string[];
}

/**
 * A fenced code block kept byte-for-byte in a content-addressed store.
 * Compacted levels reference it by hash; frames that cannot afford it show
 * a `[code sha256:…]` reference that `CompactionEngine.getSpan` resolves.
 */
export interface CodeSpan {
  /** sha256 hex of `text`. */
  hash: string;
  /** The exact span, fences included. */
  text: string;
  /** Message the span was first seen in. */
  sourceMessageId: string;
  /** Pinned spans get their own frame section, budgeted before L3–L1. */
  pinned?: boolean;
}

/** Why an item left its level. */
export type ArchiveReason = 'superseded' | 'summarized' | 'retracted';

/**
 * Items removed from a live level are archived, never deleted: a
 * correction can be reverted, and a summarized L1 entry stays retrievable.
 * `by` is the tombstone id (superseded), the L2 summary id (summarized) or
 * the retraction label (retracted).
 */
export type ArchivedItem = (
  | { kind: 'message'; reason: ArchiveReason; by: string; message: ConversationMessage }
  | { kind: 'l1'; reason: ArchiveReason; by: string; entry: CompactedEntry }
  | { kind: 'summary'; reason: ArchiveReason; by: string; summary: TopicSummary }
  | { kind: 'entity'; reason: ArchiveReason; by: string; entity: Entity }
  | { kind: 'edge'; reason: ArchiveReason; by: string; edge: Edge }
  | { kind: 'invariant'; reason: ArchiveReason; by: string; invariant: Invariant }
) & {
  /**
   * Superseded items: other tombstones that supersede the item too (it was
   * already archived when they were applied). Reverting `by` re-archives
   * it under the first of them still present instead of restoring it.
   */
  alsoBy?: string[];
};

// ---------------------------------------------------------------------------
// Compacted state (the full picture across all levels)
// ---------------------------------------------------------------------------

export interface CompactedState {
  /** L0: Raw recent messages. */
  l0_messages: ConversationMessage[];
  /** L1: Compacted recent history entries. */
  l1_compacted: CompactedEntry[];
  /** L2: Topic-clustered summaries. */
  l2_summaries: TopicSummary[];
  /** L3: Entity-relationship graph. */
  l3_graph: KnowledgeGraph;
  /** L4: Core invariants. */
  l4_invariants: Invariant[];
  /** Tombstones across all levels. */
  tombstones: Tombstone[];
  /** Total token estimate for the compacted state. */
  totalTokenEstimate: number;
  /** Superseded, summarized and retracted items (see `ArchivedItem`). */
  archive?: ArchivedItem[];
  /** Content-addressed code spans, keyed by sha256 hex. */
  spans?: Record<string, CodeSpan>;
}

// ---------------------------------------------------------------------------
// Context frame (token-budgeted slice for the next LLM call)
// ---------------------------------------------------------------------------

/**
 * What a frame section holds. Each kind has one fixed marker, and text
 * from messages, ledger fields, engrams or tools is escaped so it can
 * never produce another kind's marker (see `escapeUntrusted`).
 */
export type ContextSectionKind =
  /** Synced truth-ledger entries (`[TB]`, `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`). */
  | 'truth'
  /** Tombstones (`[correction]`). */
  | 'correction'
  /** L4 invariants (`[invariant]`). */
  | 'invariant'
  /** Active-engram recalls (`[memory]`). */
  | 'memory'
  /** Pinned code spans (`[code sha256:…]`). */
  | 'code'
  /** L3 entities and edges (`[entity]`, `[edge]`). */
  | 'graph'
  /** L2 topic summaries (`[summary]`). */
  | 'summary'
  /** L1 compacted history (verbatim message text). */
  | 'history'
  /** L0 raw recent messages (`role: text`). */
  | 'recent';

/** One budgeted unit of a section, with its provenance. */
export interface ContextItem {
  /** The item exactly as rendered in the section content (escaped). */
  text: string;
  /** Ids it derives from: message ids, ledger entry ids, tombstone ids, engram ids, span hashes. */
  sources: string[];
}

export interface ContextFrame {
  /** Token budget this frame was built for. */
  tokenBudget: number;
  /**
   * Tokens used: `estimateTokens(renderContextFrame(frame))`. Never more
   * than `tokenBudget`.
   */
  tokenUsage: number;
  /** Sections in emission order: truth, corrections, L4, memories, code, L3, L2, L1, L0. */
  sections: ContextSection[];
  /** Items left out for budget, per section kind (kinds with none omitted are absent). */
  omitted: Partial<Record<ContextSectionKind, number>>;
}

export interface ContextSection {
  kind: ContextSectionKind;
  level: CompactionLevel;
  /** Rendered items (plus the truth heading), one per line group, joined by newlines. */
  content: string;
  /** `estimateTokens(content)`. */
  tokenEstimate: number;
  /** The items in `content`, in order, with provenance. */
  items: ContextItem[];
  /** Candidate items that did not fit the budget. */
  omitted: number;
}

// ---------------------------------------------------------------------------
// Compactor interface (tiered: regex, local LM, host LLM)
// ---------------------------------------------------------------------------

export type CompactorTier = 'regex' | 'local' | 'host';

export interface Compactor {
  readonly tier: CompactorTier;

  /** Compact a sequence of messages into a lower level. */
  compact(
    messages: ConversationMessage[],
    targetLevel: CompactionLevel,
    currentState?: CompactedState,
  ): Promise<CompactedState>;

  /** Re-compact existing state (e.g., L1 → L2 merge). */
  recompact(
    state: CompactedState,
    targetLevel: CompactionLevel,
  ): Promise<CompactedState>;
}

// ---------------------------------------------------------------------------
// Compaction configuration
// ---------------------------------------------------------------------------

export interface CompactionConfig {
  /** Which tier to prefer. Falls back automatically. */
  preferredTier: CompactorTier;
  /** For Tier 1: local model configuration. */
  localModel?: {
    backend: 'llama.cpp' | 'mlx' | 'ollama' | 'transformers.js';
    modelPath: string;
    quantization?: '4bit' | '8bit' | 'f16';
  };
  /** For Tier 2: host LLM configuration. */
  hostLLM?: {
    provider: 'anthropic' | 'openai' | 'custom';
    model: string;
    toolName?: string;
  };
  /** Automatically fall back to lower tiers on failure. */
  autoFallback: boolean;
  /** Number of recent messages to keep verbatim in L0. */
  memtableSize: number;
  /** Token budget for context frames. */
  contextBudget: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  preferredTier: 'regex',
  autoFallback: true,
  memtableSize: 10,
  contextBudget: 8000,
};

// ---------------------------------------------------------------------------
// Active engrams (agential memory)
// ---------------------------------------------------------------------------

/**
 * Declarative activation policy for an ActiveEngram.
 *
 * Evaluated by the host (ActiveEngramStore), never by itself — activation
 * policies cannot write to their own importanceScore. That constraint must
 * live in the schema, not in the agent's good intentions.
 */
export interface ActivationPolicy {
  /**
   * Surface this engram when the current context contains any of these
   * topic strings (case-insensitive substring match).
   * An empty array means "always eligible".
   */
  surfaceWhenTopics: string[];
  /**
   * Stop surfacing after this many retrievals. Undefined = no limit.
   * Enables engrams that fade after use.
   */
  maxRetrievals?: number;
  /**
   * Hard expiry timestamp (ms since epoch). Undefined = immortal.
   */
  expiresAt?: number;
  /**
   * When set, this engram corrects the named engram: the named engram no
   * longer surfaces anywhere, and this engram's interpretation takes its
   * slot whenever either of them would have surfaced. This is the
   * correction mechanism — a correction is just an ActiveEngram whose policy
   * shadows another. Only takes effect between engrams of the same
   * `origin`, and only while this engram has not expired.
   */
  shadowsEngramId?: string;
}

/**
 * An agential memory entry: content + interpreter + activation policy.
 *
 * On recall the store calls interpret(context) before injection, giving the
 * engram one turn to restate itself in light of the current task. The raw
 * payload is never injected directly — salience over fidelity.
 */
export interface ActiveEngram {
  id: string;
  /** The compressed content — the engram proper. */
  payload: string;
  /**
   * Interpreter template. Use {{payload}} and {{context}} as placeholders.
   * At the regex tier this is resolved with simple string substitution.
   * At the host/local tier the host can call an LM with this as a prompt.
   *
   * Example: "Given that we are now {{context}}, the earlier note
   * '{{payload}}' means: "
   */
  interpreterTemplate: string;
  /** Declarative rules for when/how to surface this engram. */
  activationPolicy: ActivationPolicy;
  /**
   * Host-controlled importance score (0.0–1.0).
   * Read-only from the perspective of the activation policy — only the host
   * (AgentMemory / ActiveEngramStore) may set this.
   */
  importanceScore: number;
  /** Creation timestamp (ms). */
  createdAt: number;
  /** How many times this engram has been retrieved (incremented by store). */
  retrievalCount: number;
  /** ID of the engram this was derived from, if any (for provenance chains). */
  derivedFrom?: string;
  /**
   * Agent (store) that created this engram. Stamped by the store; a
   * correction (`shadowsEngramId`) only applies within one origin. Absent
   * on engrams serialized before 1.0, which take the merging peer's id
   * (`mergeFrom(state, { from })`) or, on restore, the store's own origin.
   */
  origin?: string;
}

/** The output of an interpret() call — contextualized form ready for injection. */
export interface ActiveEngramResult {
  engramId: string;
  /** The interpreted (contextualized) text to inject into the context frame. */
  interpreted: string;
  /** The raw payload, retained for debugging / diff. */
  payload: string;
  importanceScore: number;
  /** True when this result shadows another engram's output. */
  shadows?: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message: string;
  }>;
  /** Recall score from round-trip testing (0.0 to 1.0), if computed. */
  recallScore?: number;
}

// ---------------------------------------------------------------------------
// Agent profile (for per-agent semantic mapping)
// ---------------------------------------------------------------------------

export interface AgentProfile {
  agentId: string;
  /** Entity types this agent cares about. */
  entityTypes: EntityType[];
  /** Custom importance signal weights (see `ImportanceDetector`). */
  importanceWeights: SignalWeights;
  /** Regex patterns that boost importance. */
  boostPatterns: RegExp[];
  /** Regex patterns that demote importance. */
  demotePatterns: RegExp[];
}

// ---------------------------------------------------------------------------
// Source ingestion (document → compaction pipeline)
// ---------------------------------------------------------------------------

/** A raw source document to be ingested into the knowledge base. */
export interface Source {
  /** Unique identifier for this source. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** The raw text content of the source. */
  content: string;
  /** MIME-like content type hint. */
  contentType?: 'text/plain' | 'text/markdown' | 'text/html';
  /** When the source was created or published. */
  createdAt?: number;
  /** Origin URL or file path, if applicable. */
  uri?: string;
  /** Arbitrary metadata attached by the caller. */
  metadata?: Record<string, unknown>;
}

/** Configuration for the source ingester. */
export interface IngestionConfig {
  /** Maximum number of tokens per chunk (default: 800). */
  chunkSize: number;
  /** Number of tokens of overlap between adjacent chunks (default: 100). */
  chunkOverlap: number;
  /** Whether to preserve markdown structure when splitting (default: true). */
  respectMarkdownBoundaries: boolean;
}

export const DEFAULT_INGESTION_CONFIG: IngestionConfig = {
  chunkSize: 800,
  chunkOverlap: 100,
  respectMarkdownBoundaries: true,
};

/** Record of a source ingestion event for the wiki log. */
export interface IngestionEvent {
  /** Timestamp of the ingestion. */
  timestamp: number;
  /** Source that was ingested. */
  sourceId: string;
  sourceTitle: string;
  /** Number of chunks produced. */
  chunkCount: number;
  /** L3 entities this ingestion added to the engine (not ones already known). */
  entitiesDiscovered: string[];
  /** Content version (first 12 hex of the sha256 of the source content). */
  version: string;
  /** Chunks of the previous version of this source that were retracted. */
  retractedChunks: number;
  /** True when this exact version was already ingested; nothing was added. */
  skipped?: boolean;
}

// ---------------------------------------------------------------------------
// Wiki rendering (compacted state → markdown pages)
// ---------------------------------------------------------------------------

/** A single rendered wiki page. */
export interface WikiPage {
  /** File path relative to wiki root (e.g., "entities/react.md"). */
  path: string;
  /** The rendered markdown content. */
  content: string;
  /** Page title. */
  title: string;
  /** Category for index grouping. */
  category: 'entity' | 'topic' | 'invariant' | 'index' | 'log';
}

/** Configuration for the wiki renderer. */
export interface WikiRenderConfig {
  /** Title of the wiki (default: "Knowledge Base"). */
  wikiTitle: string;
  /** Whether to include backlinks on entity pages (default: true). */
  includeBacklinks: boolean;
  /** Whether to generate the log page (default: true). */
  generateLog: boolean;
}

export const DEFAULT_WIKI_RENDER_CONFIG: WikiRenderConfig = {
  wikiTitle: 'Knowledge Base',
  includeBacklinks: true,
  generateLog: true,
};
