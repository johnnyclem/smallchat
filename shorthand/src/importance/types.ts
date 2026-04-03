/**
 * Importance Detection Types — domain-agnostic importance scoring
 * using information-theoretic signals.
 *
 * Three signals, inspired by Shannon's surprisal:
 *   1. State delta — entity-relationship graph mutations
 *   2. Reference frequency — retrospective citation analysis (PageRank-like)
 *   3. Trajectory discontinuity — embedding-space change-point detection
 */

// ---------------------------------------------------------------------------
// Core message representation — imported from shared types
// ---------------------------------------------------------------------------

import type { ConversationMessage } from '../types.js';
export type { ConversationMessage } from '../types.js';
export { normalizeTimestamp } from '../types.js';

// ---------------------------------------------------------------------------
// Signal 1: State delta — entity-relationship graph
// ---------------------------------------------------------------------------

/** A node in the running entity-relationship graph. */
export interface EntityNode {
  /** Canonical name (lowercased, trimmed). */
  name: string;
  /** Entity type, if detectable (e.g. "tool", "variable", "person", "concept"). */
  type: string;
  /** Message ID where this entity was first introduced. */
  introducedBy: string;
  /** Message ID where this entity was last modified. */
  lastModifiedBy: string;
  /** Arbitrary attributes extracted from context. */
  attributes: Map<string, string>;
}

/** A directed edge in the entity-relationship graph. */
export interface EntityRelation {
  /** Source entity name. */
  from: string;
  /** Target entity name. */
  to: string;
  /** Relationship label (e.g. "uses", "replaces", "depends_on", "contradicts"). */
  label: string;
  /** Message ID where this relation was established. */
  establishedBy: string;
}

/** Result of computing the state delta for a single message. */
export interface StateDelta {
  /** Entities added by this message. */
  nodesAdded: EntityNode[];
  /** Entities removed or invalidated by this message. */
  nodesRemoved: string[];
  /** Entities whose attributes changed. */
  nodesModified: Array<{ name: string; changedAttributes: string[] }>;
  /** Relations added. */
  edgesAdded: EntityRelation[];
  /** Relations removed or contradicted. */
  edgesRemoved: Array<{ from: string; to: string; label: string }>;
  /** Magnitude: total graph mutations. */
  magnitude: number;
}

// ---------------------------------------------------------------------------
// Signal 2: Reference frequency
// ---------------------------------------------------------------------------

/** Reference link from one message to another. */
export interface MessageReference {
  /** Message that makes the reference. */
  sourceId: string;
  /** Message being referenced. */
  targetId: string;
  /** How the reference was detected. */
  type: 'explicit' | 'semantic' | 'entity_reuse';
  /** Similarity or confidence of the reference link. */
  strength: number;
}

/** Aggregated reference score for a message. */
export interface ReferenceScore {
  /** Message ID. */
  messageId: string;
  /** Raw inbound reference count. */
  inboundCount: number;
  /** Weighted score (PageRank-style with decay). */
  weightedScore: number;
  /** Which messages reference this one. */
  referencedBy: string[];
}

// ---------------------------------------------------------------------------
// Signal 3: Trajectory discontinuity
// ---------------------------------------------------------------------------

/** Trajectory measurement between consecutive messages. */
export interface TrajectoryPoint {
  /** Message ID. */
  messageId: string;
  /** Cosine distance from previous message's embedding. */
  cosineDistance: number;
  /** Whether this point exceeds the discontinuity threshold. */
  isDiscontinuity: boolean;
  /** Z-score relative to the running mean/std of distances. */
  zScore: number;
}

// ---------------------------------------------------------------------------
// Combined importance score
// ---------------------------------------------------------------------------

/** Combined importance assessment for a single message. */
export interface ImportanceScore {
  /** Message ID. */
  messageId: string;
  /** Signal 1: state delta magnitude (0 = no change, higher = more mutations). */
  stateDelta: number;
  /** Signal 2: reference frequency score (0 = never referenced, higher = more cited). */
  referenceFrequency: number;
  /** Signal 3: trajectory discontinuity z-score (0 = on trajectory, higher = direction change). */
  trajectoryDiscontinuity: number;
  /** Final combined importance (0–1 normalized). */
  importance: number;
  /** Which signal dominated the final score. */
  dominantSignal: 'state_delta' | 'reference_frequency' | 'trajectory_discontinuity';
}

// ---------------------------------------------------------------------------
// Detector configuration
// ---------------------------------------------------------------------------

/** Configuration for the ImportanceDetector. */
export interface ImportanceDetectorConfig {
  /** Signal weights — how much each signal contributes to the final score. */
  weights: SignalWeights;
  /** Threshold for trajectory discontinuity (z-score). Default: 1.5. */
  discontinuityThreshold: number;
  /** Minimum cosine distance to even consider as a potential discontinuity. */
  minCosineDistance: number;
  /** Decay factor for reference frequency (older references count less). */
  referenceDecay: number;
  /** Minimum entity mentions to register as a node. Default: 1. */
  minEntityMentions: number;
  /** Cosine similarity threshold for semantic reference detection. */
  semanticReferenceThreshold: number;
}

/** Weights for combining the three signals. */
export interface SignalWeights {
  stateDelta: number;
  referenceFrequency: number;
  trajectoryDiscontinuity: number;
}

/** Default configuration — balanced weights, conservative thresholds. */
export const DEFAULT_IMPORTANCE_CONFIG: Readonly<ImportanceDetectorConfig> = Object.freeze({
  weights: Object.freeze({
    stateDelta: 0.4,
    referenceFrequency: 0.25,
    trajectoryDiscontinuity: 0.35,
  }),
  discontinuityThreshold: 1.5,
  minCosineDistance: 0.15,
  referenceDecay: 0.9,
  minEntityMentions: 1,
  semanticReferenceThreshold: 0.75,
});
