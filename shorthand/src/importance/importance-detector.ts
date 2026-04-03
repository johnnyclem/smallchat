/**
 * ImportanceDetector — combines three domain-agnostic signals to score
 * the importance of each conversation message without domain hints.
 *
 * Signal 1: State delta (entity-relationship graph mutations)
 * Signal 2: Reference frequency (retrospective citation analysis)
 * Signal 3: Trajectory discontinuity (embedding-space change-point detection)
 *
 * The key insight from information theory (Shannon, 1948): the information
 * content of a message is inversely proportional to its probability.
 * "Hello" carries almost zero information. "Swap RSA for Ed25519" carries
 * enormous information. You don't need to know what domain you're in to
 * know what matters — you need to measure what changed.
 */

import type {
  ConversationMessage,
  ImportanceScore,
  ImportanceDetectorConfig,
  SignalWeights,
} from './types.js';
import { DEFAULT_IMPORTANCE_CONFIG } from './types.js';
import { EntityGraph, computeStateDelta, extractEntities } from './state-delta.js';
import { TrajectoryTracker } from './trajectory-discontinuity.js';
import { ReferenceGraph } from './reference-frequency.js';

// ---------------------------------------------------------------------------
// ImportanceDetector
// ---------------------------------------------------------------------------

/**
 * ImportanceDetector — the main entry point for domain-agnostic importance scoring.
 *
 * Usage:
 *   const detector = new ImportanceDetector();
 *   for (const message of conversation) {
 *     const score = detector.addMessage(message);
 *     if (score.importance > 0.7) { ... keep this message ... }
 *   }
 *
 * All three signals are computed incrementally (online) as messages arrive.
 * Signal 2 (reference frequency) is also recomputable retrospectively.
 */
export class ImportanceDetector {
  private readonly config: ImportanceDetectorConfig;
  private readonly entityGraph: EntityGraph;
  private readonly trajectoryTracker: TrajectoryTracker;
  private readonly referenceGraph: ReferenceGraph;

  private scores: Map<string, ImportanceScore> = new Map();
  private stateDeltaMagnitudes: number[] = [];
  private maxStateDelta = 0;
  private maxReferenceScore = 0;

  constructor(config?: Partial<ImportanceDetectorConfig>) {
    this.config = {
      ...DEFAULT_IMPORTANCE_CONFIG,
      ...config,
      weights: {
        ...DEFAULT_IMPORTANCE_CONFIG.weights,
        ...config?.weights,
      },
    };

    this.entityGraph = new EntityGraph();
    this.trajectoryTracker = new TrajectoryTracker({
      discontinuityThreshold: this.config.discontinuityThreshold,
      minCosineDistance: this.config.minCosineDistance,
    });
    this.referenceGraph = new ReferenceGraph({
      semanticThreshold: this.config.semanticReferenceThreshold,
      decayFactor: this.config.referenceDecay,
    });
  }

  /**
   * Process a new message and return its importance score.
   *
   * This is the main API. Call it for each message in order.
   * All three signals are computed incrementally.
   */
  addMessage(message: ConversationMessage): ImportanceScore {
    // --- Signal 1: State delta ---
    const delta = computeStateDelta(message, this.entityGraph);
    this.stateDeltaMagnitudes.push(delta.magnitude);
    if (delta.magnitude > this.maxStateDelta) {
      this.maxStateDelta = delta.magnitude;
    }

    // --- Signal 3: Trajectory discontinuity ---
    const trajectoryPoint = this.trajectoryTracker.addMessage(message);

    // --- Signal 2: Reference frequency ---
    const entities = extractEntities(message.content, message.id);
    const entityNames = entities.map(e => e.name);
    this.referenceGraph.addMessage(message, this.entityGraph, entityNames);

    // --- Combine signals ---
    const score = this.computeImportance(message.id, delta.magnitude, trajectoryPoint);
    this.scores.set(message.id, score);

    return score;
  }

  /**
   * Recompute all importance scores retrospectively.
   *
   * Useful after all messages have been added — Signal 2 (reference frequency)
   * can only be fully accurate in retrospect, since future messages may
   * reference past ones.
   */
  recomputeScores(): Map<string, ImportanceScore> {
    // Update max reference score
    const allRefScores = this.referenceGraph.getAllScores();
    this.maxReferenceScore = allRefScores.length > 0
      ? allRefScores[0].weightedScore
      : 0;

    // Recompute each message's combined score
    const trajectoryPoints = this.trajectoryTracker.getPoints();
    const trajectoryMap = new Map(trajectoryPoints.map(p => [p.messageId, p]));

    for (const [messageId, existing] of this.scores) {
      const refScore = this.referenceGraph.getScore(messageId);
      const trajectoryPoint = trajectoryMap.get(messageId);

      const normalizedRef = this.maxReferenceScore > 0 && refScore
        ? refScore.weightedScore / this.maxReferenceScore
        : 0;

      const normalizedDelta = this.maxStateDelta > 0
        ? existing.stateDelta * this.maxStateDelta // un-normalize then re-normalize
        : 0;

      const trajectorySignal = trajectoryPoint
        ? Math.max(0, trajectoryPoint.zScore) / 3 // normalize z-score to ~[0, 1]
        : 0;

      const { importance, dominantSignal } = this.combine(
        normalizedDelta > 0 ? normalizedDelta / this.maxStateDelta : 0,
        normalizedRef,
        trajectorySignal,
      );

      this.scores.set(messageId, {
        ...existing,
        referenceFrequency: normalizedRef,
        importance,
        dominantSignal,
      });
    }

    return new Map(this.scores);
  }

  /**
   * Get the importance score for a specific message.
   */
  getScore(messageId: string): ImportanceScore | undefined {
    return this.scores.get(messageId);
  }

  /**
   * Get all scores sorted by importance (highest first).
   */
  getAllScores(): ImportanceScore[] {
    return Array.from(this.scores.values())
      .sort((a, b) => b.importance - a.importance);
  }

  /**
   * Get messages above a given importance threshold.
   */
  getImportantMessages(threshold: number = 0.5): ImportanceScore[] {
    return this.getAllScores().filter(s => s.importance >= threshold);
  }

  /**
   * Get the signal weights (useful for diagnostics).
   */
  getWeights(): Readonly<SignalWeights> {
    return this.config.weights;
  }

  /** Access the underlying entity graph (for inspection/debugging). */
  getEntityGraph(): EntityGraph {
    return this.entityGraph;
  }

  /** Access the underlying trajectory tracker. */
  getTrajectoryTracker(): TrajectoryTracker {
    return this.trajectoryTracker;
  }

  /** Access the underlying reference graph. */
  getReferenceGraph(): ReferenceGraph {
    return this.referenceGraph;
  }

  /** Reset all state. */
  reset(): void {
    this.entityGraph.clear();
    this.trajectoryTracker.reset();
    this.referenceGraph.reset();
    this.scores.clear();
    this.stateDeltaMagnitudes = [];
    this.maxStateDelta = 0;
    this.maxReferenceScore = 0;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private computeImportance(
    messageId: string,
    deltaMagnitude: number,
    trajectoryPoint: { zScore: number; cosineDistance: number; isDiscontinuity: boolean } | null,
  ): ImportanceScore {
    // Normalize state delta to [0, 1] using running max
    const normalizedDelta = this.maxStateDelta > 0
      ? deltaMagnitude / this.maxStateDelta
      : (deltaMagnitude > 0 ? 1 : 0);

    // Reference frequency — use current score (will be updated in recompute)
    const refScore = this.referenceGraph.getScore(messageId);
    const allRefScores = this.referenceGraph.getAllScores();
    const currentMaxRef = allRefScores.length > 0 ? allRefScores[0].weightedScore : 0;
    const normalizedRef = currentMaxRef > 0 && refScore
      ? refScore.weightedScore / currentMaxRef
      : 0;

    // Trajectory discontinuity — normalize z-score to [0, 1] range
    // z-scores above 3 are extreme outliers, so cap there
    const trajectorySignal = trajectoryPoint
      ? Math.min(1, Math.max(0, trajectoryPoint.zScore) / 3)
      : 0;

    const { importance, dominantSignal } = this.combine(
      normalizedDelta,
      normalizedRef,
      trajectorySignal,
    );

    return {
      messageId,
      stateDelta: normalizedDelta,
      referenceFrequency: normalizedRef,
      trajectoryDiscontinuity: trajectorySignal,
      importance,
      dominantSignal,
    };
  }

  private combine(
    stateDelta: number,
    referenceFrequency: number,
    trajectoryDiscontinuity: number,
  ): { importance: number; dominantSignal: ImportanceScore['dominantSignal'] } {
    const w = this.config.weights;

    const importance = Math.min(1, Math.max(0,
      stateDelta * w.stateDelta +
      referenceFrequency * w.referenceFrequency +
      trajectoryDiscontinuity * w.trajectoryDiscontinuity,
    ));

    // Determine dominant signal
    const signals: Array<{ value: number; name: ImportanceScore['dominantSignal'] }> = [
      { value: stateDelta * w.stateDelta, name: 'state_delta' },
      { value: referenceFrequency * w.referenceFrequency, name: 'reference_frequency' },
      { value: trajectoryDiscontinuity * w.trajectoryDiscontinuity, name: 'trajectory_discontinuity' },
    ];

    const dominant = signals.reduce((a, b) => a.value >= b.value ? a : b);

    return { importance, dominantSignal: dominant.name };
  }
}
