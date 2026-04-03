/**
 * Signal 3: Trajectory Discontinuity — embedding-space change-point detection.
 *
 * Tracks the semantic trajectory of a conversation as a path through
 * embedding space. Most messages move incrementally along the current
 * trajectory. Discontinuities — sharp direction changes — are importance
 * signals: topic shifts, corrections, new constraints.
 *
 * The math is cosine distance between consecutive embeddings, with
 * z-score thresholding for "significant change in direction."
 *
 * Classical analog: change-point detection in time series (PELT, BOCPD).
 * We use a simpler online approach: running mean/variance of cosine
 * distances with z-score-based anomaly detection.
 */

import type { ConversationMessage, TrajectoryPoint } from './types.js';

// ---------------------------------------------------------------------------
// Vector math utilities
// ---------------------------------------------------------------------------

/** Cosine similarity between two vectors. Returns value in [-1, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

/** Cosine distance: 1 - cosine_similarity. Returns value in [0, 2]. */
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  return 1 - cosineSimilarity(a, b);
}

// ---------------------------------------------------------------------------
// Running statistics (Welford's online algorithm)
// ---------------------------------------------------------------------------

/**
 * Online mean and variance tracker using Welford's algorithm.
 * Numerically stable for streaming data — no need to store all values.
 */
export class RunningStats {
  private count = 0;
  private mean = 0;
  private m2 = 0;

  /** Add a new observation. */
  push(value: number): void {
    this.count++;
    const delta = value - this.mean;
    this.mean += delta / this.count;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;
  }

  /** Current mean. */
  getMean(): number {
    return this.mean;
  }

  /** Current variance (population). */
  getVariance(): number {
    return this.count < 2 ? 0 : this.m2 / this.count;
  }

  /** Current standard deviation. */
  getStdDev(): number {
    return Math.sqrt(this.getVariance());
  }

  /** Number of observations. */
  getCount(): number {
    return this.count;
  }

  /** Compute z-score for a value given current stats. */
  zScore(value: number): number {
    const std = this.getStdDev();
    if (std === 0) return 0;
    return (value - this.mean) / std;
  }

  /** Reset all statistics. */
  reset(): void {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
  }
}

// ---------------------------------------------------------------------------
// Trajectory tracker
// ---------------------------------------------------------------------------

export interface TrajectoryTrackerOptions {
  /** Z-score threshold for discontinuity detection. Default: 1.5. */
  discontinuityThreshold?: number;
  /** Minimum cosine distance to even consider. Default: 0.15. */
  minCosineDistance?: number;
  /** Minimum observations before z-scores are meaningful. Default: 3. */
  minObservationsForZScore?: number;
}

/**
 * TrajectoryTracker — monitors the embedding-space path of a conversation.
 *
 * Feed it messages with embeddings; it returns trajectory points
 * indicating whether each message is a discontinuity (topic shift,
 * correction, new constraint) or a continuation of the current trajectory.
 */
export class TrajectoryTracker {
  private stats = new RunningStats();
  private previousEmbedding: Float32Array | null = null;
  private points: TrajectoryPoint[] = [];

  private readonly discontinuityThreshold: number;
  private readonly minCosineDistance: number;
  private readonly minObservationsForZScore: number;

  constructor(options?: TrajectoryTrackerOptions) {
    this.discontinuityThreshold = options?.discontinuityThreshold ?? 1.5;
    this.minCosineDistance = options?.minCosineDistance ?? 0.15;
    this.minObservationsForZScore = options?.minObservationsForZScore ?? 3;
  }

  /**
   * Process a new message and return its trajectory point.
   * Returns null if the message has no embedding.
   */
  addMessage(message: ConversationMessage): TrajectoryPoint | null {
    if (!message.embedding) return null;

    // First message — no trajectory to compare against
    if (!this.previousEmbedding) {
      this.previousEmbedding = message.embedding;
      const point: TrajectoryPoint = {
        messageId: message.id,
        cosineDistance: 0,
        isDiscontinuity: false,
        zScore: 0,
      };
      this.points.push(point);
      return point;
    }

    // Compute cosine distance from previous message
    const dist = cosineDistance(this.previousEmbedding, message.embedding);

    // Compute z-score
    const zScore = this.stats.getCount() >= this.minObservationsForZScore
      ? this.stats.zScore(dist)
      : 0;

    // Update running stats AFTER computing z-score (so current point
    // is compared against the history, not included in it)
    this.stats.push(dist);

    // Determine if this is a discontinuity
    const isDiscontinuity =
      dist >= this.minCosineDistance &&
      (zScore >= this.discontinuityThreshold ||
        // For early conversation (few samples), use absolute distance
        (this.stats.getCount() < this.minObservationsForZScore && dist >= 0.4));

    const point: TrajectoryPoint = {
      messageId: message.id,
      cosineDistance: dist,
      isDiscontinuity,
      zScore,
    };

    this.points.push(point);
    this.previousEmbedding = message.embedding;

    return point;
  }

  /** Get all trajectory points computed so far. */
  getPoints(): ReadonlyArray<TrajectoryPoint> {
    return this.points;
  }

  /** Get the running distance statistics. */
  getStats(): { mean: number; stdDev: number; count: number } {
    return {
      mean: this.stats.getMean(),
      stdDev: this.stats.getStdDev(),
      count: this.stats.getCount(),
    };
  }

  /** Reset the tracker. */
  reset(): void {
    this.stats.reset();
    this.previousEmbedding = null;
    this.points = [];
  }
}
