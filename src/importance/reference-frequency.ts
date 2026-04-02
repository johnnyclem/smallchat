/**
 * Signal 2: Downstream Reference Frequency — retrospective citation analysis.
 *
 * PageRank applied to conversation turns. If message 12 gets referenced
 * (explicitly or implicitly) by messages 15, 23, and 41, it's important.
 * If message 13 is never referenced again, it's not.
 *
 * This is computed retrospectively during compaction passes — you can't
 * know a message's reference count until later messages arrive.
 *
 * Three reference detection methods:
 *   1. Explicit — "as I said in message 12", "going back to...", pronouns resolving to prior entities
 *   2. Semantic — high cosine similarity to a prior message (re-engaging a topic)
 *   3. Entity reuse — mentioning entities first introduced in a prior message
 *
 * Classical analog: citation analysis / Google's PageRank.
 */

import type {
  ConversationMessage,
  MessageReference,
  ReferenceScore,
} from './types.js';
import type { EntityGraph } from './state-delta.js';
import { cosineSimilarity } from './trajectory-discontinuity.js';

// ---------------------------------------------------------------------------
// Explicit reference patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate explicit backward references in conversation.
 * These are domain-agnostic — they detect conversational structure, not content.
 */
const EXPLICIT_REF_PATTERNS: RegExp[] = [
  /\b(?:as (?:I|we|you) (?:said|mentioned|noted|discussed))\b/i,
  /\b(?:going back to|returning to|revisiting)\b/i,
  /\b(?:earlier|previously|before|above)\b/i,
  /\b(?:remember (?:when|that|how))\b/i,
  /\b(?:like (?:I|we|you) said)\b/i,
  /\b(?:to clarify|to reiterate|to recap)\b/i,
  /\b(?:regarding|about) (?:the|that|this) (?:earlier|previous)\b/i,
  /\b(?:as per|per our|from our)\b/i,
];

// ---------------------------------------------------------------------------
// Reference graph
// ---------------------------------------------------------------------------

export interface ReferenceGraphOptions {
  /** Cosine similarity threshold for semantic references. Default: 0.75. */
  semanticThreshold?: number;
  /** Decay factor per message distance (older refs weighted less). Default: 0.9. */
  decayFactor?: number;
  /** Maximum lookback window for semantic comparison. Default: 50. */
  maxLookback?: number;
}

/**
 * ReferenceGraph — builds and maintains a citation graph over conversation messages.
 *
 * Call `addMessage()` for each new message. It computes backward references
 * to prior messages and updates cumulative reference scores.
 */
export class ReferenceGraph {
  private messages: ConversationMessage[] = [];
  private references: MessageReference[] = [];
  private scores: Map<string, ReferenceScore> = new Map();
  private entityIntroductions: Map<string, string> = new Map(); // entity → messageId

  private readonly semanticThreshold: number;
  private readonly decayFactor: number;
  private readonly maxLookback: number;

  constructor(options?: ReferenceGraphOptions) {
    this.semanticThreshold = options?.semanticThreshold ?? 0.75;
    this.decayFactor = options?.decayFactor ?? 0.9;
    this.maxLookback = options?.maxLookback ?? 50;
  }

  /**
   * Add a new message and compute its backward references.
   *
   * @param message - The new message to add
   * @param entityGraph - Optional entity graph for entity-reuse detection
   * @param messageEntities - Entity names extracted from this message
   * @returns References discovered from this message to prior messages
   */
  addMessage(
    message: ConversationMessage,
    entityGraph?: EntityGraph,
    messageEntities?: string[],
  ): MessageReference[] {
    const newRefs: MessageReference[] = [];
    const messageIndex = this.messages.length;

    // 1. Detect explicit references
    const hasExplicitRef = EXPLICIT_REF_PATTERNS.some(p => p.test(message.content));
    if (hasExplicitRef && this.messages.length > 0) {
      // Explicit references most likely point to the most topically similar
      // prior message. Find the best semantic match in the recent window.
      const bestMatch = this.findBestSemanticMatch(message, 0.3); // lower threshold for explicit refs
      if (bestMatch) {
        const ref: MessageReference = {
          sourceId: message.id,
          targetId: bestMatch.id,
          type: 'explicit',
          strength: 1.0,
        };
        newRefs.push(ref);
      }
    }

    // 2. Detect semantic references (high similarity to prior messages)
    if (message.embedding) {
      const lookbackStart = Math.max(0, messageIndex - this.maxLookback);
      for (let i = lookbackStart; i < messageIndex; i++) {
        const prior = this.messages[i];
        if (!prior.embedding) continue;

        // Skip the immediately previous message — adjacency isn't a "reference"
        if (i === messageIndex - 1) continue;

        const similarity = cosineSimilarity(message.embedding, prior.embedding);
        if (similarity >= this.semanticThreshold) {
          // Apply distance decay
          const distance = messageIndex - i;
          const decayedStrength = similarity * Math.pow(this.decayFactor, distance);

          const ref: MessageReference = {
            sourceId: message.id,
            targetId: prior.id,
            type: 'semantic',
            strength: decayedStrength,
          };
          newRefs.push(ref);
        }
      }
    }

    // 3. Detect entity-reuse references
    if (messageEntities && messageEntities.length > 0) {
      // Track which prior messages introduced entities that this message reuses
      const referencedMessages = new Map<string, number>();

      for (const entity of messageEntities) {
        const key = entity.toLowerCase();
        const introducedBy = this.entityIntroductions.get(key);
        if (introducedBy && introducedBy !== message.id) {
          referencedMessages.set(
            introducedBy,
            (referencedMessages.get(introducedBy) ?? 0) + 1,
          );
        } else if (!introducedBy) {
          // First occurrence of this entity — record introduction
          this.entityIntroductions.set(key, message.id);
        }
      }

      for (const [targetId, entityCount] of referencedMessages) {
        // Already have a reference to this message? Skip to avoid double-counting
        if (newRefs.some(r => r.targetId === targetId)) continue;

        const strength = Math.min(1.0, entityCount * 0.3);
        const ref: MessageReference = {
          sourceId: message.id,
          targetId,
          type: 'entity_reuse',
          strength,
        };
        newRefs.push(ref);
      }
    }

    // Store message and references
    this.messages.push(message);
    this.references.push(...newRefs);

    // Update scores for referenced messages
    for (const ref of newRefs) {
      this.updateScore(ref);
    }

    return newRefs;
  }

  /**
   * Get the reference score for a specific message.
   */
  getScore(messageId: string): ReferenceScore | undefined {
    return this.scores.get(messageId);
  }

  /**
   * Get all scores, sorted by weighted score descending.
   */
  getAllScores(): ReferenceScore[] {
    return Array.from(this.scores.values())
      .sort((a, b) => b.weightedScore - a.weightedScore);
  }

  /**
   * Recompute all scores from scratch (useful after bulk message ingestion).
   */
  recompute(): void {
    this.scores.clear();
    for (const ref of this.references) {
      this.updateScore(ref);
    }
  }

  /** Get all references. */
  getReferences(): ReadonlyArray<MessageReference> {
    return this.references;
  }

  /** Reset all state. */
  reset(): void {
    this.messages = [];
    this.references = [];
    this.scores.clear();
    this.entityIntroductions.clear();
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private updateScore(ref: MessageReference): void {
    let score = this.scores.get(ref.targetId);
    if (!score) {
      score = {
        messageId: ref.targetId,
        inboundCount: 0,
        weightedScore: 0,
        referencedBy: [],
      };
      this.scores.set(ref.targetId, score);
    }

    score.inboundCount++;
    score.weightedScore += ref.strength;
    if (!score.referencedBy.includes(ref.sourceId)) {
      score.referencedBy.push(ref.sourceId);
    }
  }

  private findBestSemanticMatch(
    message: ConversationMessage,
    threshold: number,
  ): ConversationMessage | null {
    if (!message.embedding) return null;

    let bestSimilarity = threshold;
    let bestMessage: ConversationMessage | null = null;

    const lookbackStart = Math.max(0, this.messages.length - this.maxLookback);
    for (let i = lookbackStart; i < this.messages.length; i++) {
      const prior = this.messages[i];
      if (!prior.embedding) continue;

      const similarity = cosineSimilarity(message.embedding, prior.embedding);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestMessage = prior;
      }
    }

    return bestMessage;
  }
}
