/**
 * Strategy 3: Information-Theoretic Metrics
 *
 * Research-grade verification using rate-distortion theory. Computes
 * theoretical lower bounds on how much information must survive K rounds
 * of compaction, given the entropy of the original conversation.
 *
 * Key insight from rate-distortion theory: for a given "distortion" budget
 * (how much meaning loss you'll tolerate), there's a minimum number of bits
 * you must retain. If your compacted state is below that bound, you've lost
 * too much. If it's above, you're provably within tolerance.
 *
 * The obstacle: defining "distortion" for natural language conversations is
 * an open problem. We approximate using:
 *   - Token-level entropy (Shannon)
 *   - Entity/decision coverage as a proxy for "decision-relevant information"
 *   - Compression ratio bounds from rate-distortion theory
 *
 * This module provides the framework — plugging in better distortion metrics
 * as they're developed is the path to full Strategy 3.
 */

import type {
  CompactedState,
  ConversationHistory,
  EntityRetention,
  EntropyMetrics,
  InformationTheoreticResult,
  RateDistortionMetrics,
} from './types.js';
import { estimateTokens } from './compactor.js';

// ---------------------------------------------------------------------------
// Tokenization (simple whitespace + punctuation splitter)
// ---------------------------------------------------------------------------

/** Split text into tokens for entropy computation. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\n\r\t,.;:!?()[\]{}"'`]+/)
    .filter(t => t.length > 0);
}

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

/**
 * Compute Shannon entropy of a token distribution.
 *
 * H(X) = -Σ p(x) log₂ p(x)
 *
 * Where p(x) is the probability of token x in the text.
 */
export function shannonEntropy(tokens: string[]): number {
  if (tokens.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / tokens.length;
    if (p > 0) {
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Compute the total information content (entropy × token count).
 * This gives bits, not bits-per-token.
 */
export function totalInformationBits(tokens: string[]): number {
  return shannonEntropy(tokens) * tokens.length;
}

// ---------------------------------------------------------------------------
// Entropy metrics
// ---------------------------------------------------------------------------

/** Compute full entropy metrics for a text. */
export function computeEntropyMetrics(text: string): EntropyMetrics {
  const tokens = tokenize(text);
  const uniqueTokens = new Set(tokens);
  const entropy = shannonEntropy(tokens);

  // Estimate "decision-relevant bits" as entropy from non-stop-word tokens
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall',
    'should', 'may', 'might', 'must', 'can', 'could', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
    'during', 'before', 'after', 'above', 'below', 'between', 'and', 'but',
    'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
    'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'it', 'its',
    'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you',
    'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their',
    'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  ]);

  const contentTokens = tokens.filter(t => !stopWords.has(t));
  const decisionBits = totalInformationBits(contentTokens);

  return {
    shannonEntropy: entropy,
    vocabularySize: uniqueTokens.size,
    totalTokens: tokens.length,
    typeTokenRatio: tokens.length > 0 ? uniqueTokens.size / tokens.length : 0,
    decisionRelevantBits: decisionBits,
  };
}

// ---------------------------------------------------------------------------
// Rate-distortion analysis
// ---------------------------------------------------------------------------

/**
 * Compute rate-distortion metrics.
 *
 * From rate-distortion theory, the rate-distortion function R(D) gives
 * the minimum rate (bits) needed to describe a source at distortion ≤ D.
 *
 * For a Gaussian source with variance σ²:
 *   R(D) = ½ log₂(σ²/D)  for 0 < D < σ²
 *
 * We use this as an approximation by treating the token entropy as a proxy
 * for source variance. The distortion is measured as the fraction of
 * decision-relevant information lost.
 */
export function computeRateDistortion(
  originalEntropy: EntropyMetrics,
  compactedEntropy: EntropyMetrics,
): RateDistortionMetrics {
  const originalBits = originalEntropy.decisionRelevantBits;
  const retainedBits = compactedEntropy.decisionRelevantBits;

  const compressionRatio = originalBits > 0 ? retainedBits / originalBits : 1;

  // Distortion: fraction of decision-relevant bits lost
  const distortion = originalBits > 0
    ? Math.max(0, 1 - compressionRatio)
    : 0;

  // Theoretical minimum bits using Gaussian rate-distortion approximation
  // R(D) = ½ log₂(σ²/D) where σ² ≈ originalBits, D ≈ distortion * originalBits
  let theoreticalMinBits: number;
  if (distortion > 0 && distortion < 1) {
    const variance = originalBits;
    const D = distortion * originalBits;
    theoreticalMinBits = Math.max(0, 0.5 * Math.log2(variance / D));
  } else if (distortion === 0) {
    // Perfect reconstruction requires all original bits
    theoreticalMinBits = originalBits;
  } else {
    // Complete loss — minimum is 0
    theoreticalMinBits = 0;
  }

  const withinBounds = retainedBits >= theoreticalMinBits;
  const marginBits = retainedBits - theoreticalMinBits;

  return {
    retainedBits,
    originalBits,
    compressionRatio,
    distortion,
    theoreticalMinBits,
    withinBounds,
    marginBits,
  };
}

// ---------------------------------------------------------------------------
// Entity retention analysis
// ---------------------------------------------------------------------------

/** Measure per-entity information retention. */
export function measureEntityRetention(
  compactedState: CompactedState,
  original: ConversationHistory,
): EntityRetention[] {
  const results: EntityRetention[] = [];
  const summaryLower = compactedState.summary.toLowerCase();

  for (const entity of compactedState.entities) {
    const namePresent = summaryLower.includes(entity.name.toLowerCase());
    const valuePresent = summaryLower.includes(String(entity.value).toLowerCase());

    const retained = namePresent || valuePresent;

    // Check if corrections survived
    const correctionsIntact = entity.corrections.every(c => {
      const correctedValue = String(c.correctedValue).toLowerCase();
      return correctedValue.length <= 2 || summaryLower.includes(correctedValue);
    });

    // Coverage: fraction of source messages about this entity
    const entityMentionIds = new Set([entity.firstMention, entity.lastMention]);
    const sourceIds = new Set(compactedState.sourceMessageIds);
    const coveredMentions = [...entityMentionIds].filter(id => sourceIds.has(id));
    const coverageFraction = entityMentionIds.size > 0
      ? coveredMentions.length / entityMentionIds.size
      : 0;

    results.push({
      entityName: entity.name,
      retained,
      correctionsIntact,
      coverageFraction,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Full information-theoretic analysis
// ---------------------------------------------------------------------------

/** Run the complete information-theoretic analysis. */
export function analyzeInformationTheoretic(
  compactedState: CompactedState,
  original: ConversationHistory,
): InformationTheoreticResult {
  // Compute entropy for original conversation
  const originalText = original.messages.map(m => m.content).join('\n');
  const originalEntropy = computeEntropyMetrics(originalText);

  // Compute entropy for compacted state
  const compactedEntropy = computeEntropyMetrics(compactedState.summary);

  // Rate-distortion analysis
  const rateDistortion = computeRateDistortion(originalEntropy, compactedEntropy);

  // Entity retention
  const entityRetention = measureEntityRetention(compactedState, original);

  // Overall retention score: weighted combination
  const retainedEntityFraction = entityRetention.length > 0
    ? entityRetention.filter(e => e.retained).length / entityRetention.length
    : 1;
  const correctionFraction = entityRetention.length > 0
    ? entityRetention.filter(e => e.correctionsIntact).length / entityRetention.length
    : 1;

  const retentionScore = (
    0.3 * rateDistortion.compressionRatio +
    0.4 * retainedEntityFraction +
    0.3 * correctionFraction
  );

  return {
    compactedState,
    originalEntropy,
    compactedEntropy,
    rateDistortion,
    entityRetention,
    retentionScore: Math.min(1, retentionScore),
  };
}
