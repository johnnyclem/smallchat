import { describe, it, expect, beforeEach } from 'vitest';
import { ImportanceDetector } from './importance-detector.js';
import type { ConversationMessage } from './types.js';

function msg(id: string, content: string, embedding?: number[]): ConversationMessage {
  return {
    id,
    content,
    embedding: embedding ? new Float32Array(embedding) : undefined,
    timestamp: Date.now(),
    role: 'user',
  };
}

describe('ImportanceDetector', () => {
  let detector: ImportanceDetector;

  beforeEach(() => {
    detector = new ImportanceDetector();
  });

  it('scores pleasantries as low importance', () => {
    const score = detector.addMessage(msg('m1', 'Hello, how are you?'));
    expect(score.importance).toBeLessThan(0.3);
  });

  it('scores state-changing messages as higher importance', () => {
    const s1 = detector.addMessage(msg('m1', 'Hello'));
    const s2 = detector.addMessage(msg('m2', 'Use `Redis` for the cache layer and `PostgreSQL` for the database'));
    expect(s2.importance).toBeGreaterThan(s1.importance);
  });

  it('scores contradictions/corrections as high importance', () => {
    detector.addMessage(msg('m1', 'Use `RSA` for encryption'));
    const s2 = detector.addMessage(msg('m2', 'Actually, swap `RSA` for `Ed25519`'));
    expect(s2.stateDelta).toBeGreaterThan(0);
    expect(s2.importance).toBeGreaterThan(0);
  });

  it('detects trajectory discontinuities with embeddings', () => {
    // Build a trajectory in one direction
    detector.addMessage(msg('m1', 'Discussing databases', [1, 0, 0]));
    detector.addMessage(msg('m2', 'More about databases', [0.98, 0.1, 0]));
    detector.addMessage(msg('m3', 'Database indexing', [0.96, 0.15, 0]));
    detector.addMessage(msg('m4', 'Query optimization', [0.94, 0.2, 0]));
    detector.addMessage(msg('m5', 'Still databases', [0.92, 0.22, 0]));

    // Sharp topic change
    const score = detector.addMessage(msg('m6', 'Now about authentication and security', [0, 0, 1]));
    expect(score.trajectoryDiscontinuity).toBeGreaterThan(0);
  });

  it('returns all scores sorted by importance', () => {
    detector.addMessage(msg('m1', 'Hello'));
    detector.addMessage(msg('m2', 'Use `Redis` for caching'));
    detector.addMessage(msg('m3', 'Thanks!'));
    detector.addMessage(msg('m4', 'Actually, swap `Redis` for `Memcached` in production'));

    const scores = detector.getAllScores();
    expect(scores.length).toBe(4);
    // Should be sorted descending
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1].importance).toBeGreaterThanOrEqual(scores[i].importance);
    }
  });

  it('filters by importance threshold', () => {
    detector.addMessage(msg('m1', 'Hello'));
    detector.addMessage(msg('m2', 'Use `Redis` for the cache layer'));

    const important = detector.getImportantMessages(0.1);
    // At least the state-changing message should be above threshold
    expect(important.length).toBeGreaterThanOrEqual(1);
  });

  it('recomputes scores retrospectively', () => {
    detector.addMessage(msg('m1', 'Use `Redis` for caching'), );
    detector.addMessage(msg('m2', 'Configure the server'));
    detector.addMessage(msg('m3', 'Back to `Redis` — set maxmemory'));

    const recomputed = detector.recomputeScores();
    expect(recomputed.size).toBe(3);
  });

  it('identifies dominant signal correctly', () => {
    // A message with only state delta (no embedding, no references)
    const score = detector.addMessage(msg('m1', 'Use `PostgreSQL` with `Redis` and `Nginx`'));
    expect(score.dominantSignal).toBe('state_delta');
  });

  it('exposes underlying components for inspection', () => {
    detector.addMessage(msg('m1', 'Use `Redis`'));

    expect(detector.getEntityGraph().size).toBeGreaterThan(0);
    expect(detector.getTrajectoryTracker()).toBeDefined();
    expect(detector.getReferenceGraph()).toBeDefined();
  });

  it('respects custom weights', () => {
    const heavy = new ImportanceDetector({
      weights: { stateDelta: 1.0, referenceFrequency: 0, trajectoryDiscontinuity: 0 },
    });
    const score = heavy.addMessage(msg('m1', 'Use `Redis` for caching'));
    // With only stateDelta weighted, importance should equal normalized state delta
    expect(score.dominantSignal).toBe('state_delta');
  });

  it('resets all state', () => {
    detector.addMessage(msg('m1', 'Use `Redis`'));
    detector.addMessage(msg('m2', 'Configure `Nginx`'));
    detector.reset();

    expect(detector.getAllScores().length).toBe(0);
    expect(detector.getEntityGraph().size).toBe(0);
  });
});
