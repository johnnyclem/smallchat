import { describe, it, expect, beforeEach } from 'vitest';
import {
  cosineSimilarity,
  cosineDistance,
  RunningStats,
  TrajectoryTracker,
} from './trajectory-discontinuity.js';
import type { ConversationMessage } from './types.js';

// ---------------------------------------------------------------------------
// Helper: create a message with a known embedding
// ---------------------------------------------------------------------------

function msgWithEmbedding(id: string, embedding: number[]): ConversationMessage {
  return {
    id,
    content: `message ${id}`,
    embedding: new Float32Array(embedding),
    timestamp: Date.now(),
    role: 'user',
  };
}

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it('throws on dimension mismatch', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow('dimension mismatch');
  });
});

describe('cosineDistance', () => {
  it('returns 0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineDistance(v, v)).toBeCloseTo(0.0);
  });

  it('returns 1 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(1.0);
  });
});

describe('RunningStats', () => {
  let stats: RunningStats;

  beforeEach(() => {
    stats = new RunningStats();
  });

  it('computes mean correctly', () => {
    stats.push(2);
    stats.push(4);
    stats.push(6);
    expect(stats.getMean()).toBeCloseTo(4.0);
  });

  it('computes variance correctly', () => {
    // Values: 2, 4, 6 → mean=4, variance = ((2-4)² + (4-4)² + (6-4)²)/3 = 8/3
    stats.push(2);
    stats.push(4);
    stats.push(6);
    expect(stats.getVariance()).toBeCloseTo(8 / 3);
  });

  it('computes z-scores correctly', () => {
    stats.push(10);
    stats.push(10);
    stats.push(10);
    stats.push(10);
    // All same values → std=0 → z-score=0
    expect(stats.zScore(20)).toBe(0);
  });

  it('computes meaningful z-scores with variance', () => {
    // Build a distribution with mean ~0.3, some variance
    const values = [0.25, 0.30, 0.28, 0.32, 0.27, 0.31, 0.29, 0.33, 0.26, 0.30];
    for (const v of values) {
      stats.push(v);
    }
    // A value of 0.9 should have a high z-score (far from mean ~0.3)
    const z = stats.zScore(0.9);
    expect(z).toBeGreaterThan(1);
  });

  it('resets correctly', () => {
    stats.push(5);
    stats.reset();
    expect(stats.getCount()).toBe(0);
    expect(stats.getMean()).toBe(0);
  });
});

describe('TrajectoryTracker', () => {
  let tracker: TrajectoryTracker;

  beforeEach(() => {
    tracker = new TrajectoryTracker({
      discontinuityThreshold: 1.5,
      minCosineDistance: 0.15,
    });
  });

  it('returns a point for the first message', () => {
    const point = tracker.addMessage(msgWithEmbedding('m1', [1, 0, 0]));
    expect(point).not.toBeNull();
    expect(point!.cosineDistance).toBe(0);
    expect(point!.isDiscontinuity).toBe(false);
  });

  it('returns null for messages without embeddings', () => {
    const msg = { id: 'm1', content: 'hello', timestamp: Date.now(), role: 'user' as const };
    const point = tracker.addMessage(msg);
    expect(point).toBeNull();
  });

  it('detects continuations (similar consecutive messages)', () => {
    tracker.addMessage(msgWithEmbedding('m1', [1, 0, 0]));
    const point = tracker.addMessage(msgWithEmbedding('m2', [0.98, 0.1, 0]));
    expect(point).not.toBeNull();
    expect(point!.cosineDistance).toBeLessThan(0.15);
    expect(point!.isDiscontinuity).toBe(false);
  });

  it('detects discontinuities (sharp direction changes)', () => {
    // Build up a trajectory in one direction
    tracker.addMessage(msgWithEmbedding('m1', [1, 0, 0]));
    tracker.addMessage(msgWithEmbedding('m2', [0.99, 0.05, 0]));
    tracker.addMessage(msgWithEmbedding('m3', [0.98, 0.1, 0]));
    tracker.addMessage(msgWithEmbedding('m4', [0.97, 0.12, 0]));
    tracker.addMessage(msgWithEmbedding('m5', [0.96, 0.14, 0]));

    // Sharp direction change
    const point = tracker.addMessage(msgWithEmbedding('m6', [0, 0, 1]));
    expect(point).not.toBeNull();
    expect(point!.cosineDistance).toBeGreaterThan(0.5);
    expect(point!.isDiscontinuity).toBe(true);
  });

  it('tracks running statistics', () => {
    tracker.addMessage(msgWithEmbedding('m1', [1, 0, 0]));
    tracker.addMessage(msgWithEmbedding('m2', [0.9, 0.3, 0]));
    tracker.addMessage(msgWithEmbedding('m3', [0.8, 0.5, 0]));

    const stats = tracker.getStats();
    expect(stats.count).toBe(2); // 2 distances (between 3 messages)
    expect(stats.mean).toBeGreaterThan(0);
  });

  it('resets correctly', () => {
    tracker.addMessage(msgWithEmbedding('m1', [1, 0, 0]));
    tracker.addMessage(msgWithEmbedding('m2', [0, 1, 0]));
    tracker.reset();

    expect(tracker.getPoints().length).toBe(0);
    expect(tracker.getStats().count).toBe(0);
  });
});
