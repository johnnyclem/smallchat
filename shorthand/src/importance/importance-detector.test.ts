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

// ---------------------------------------------------------------------------
// Behaviours carried over from short-hand's former single-file detector
// (same scenarios, canonical addMessage/recomputeScores API)
// ---------------------------------------------------------------------------

describe('ImportanceDetector — carried scenarios', () => {
  const at = (id: string, content: string): ConversationMessage => ({
    id,
    role: 'user',
    content,
    timestamp: Date.now(),
  });

  it('scores noise messages low', () => {
    const detector = new ImportanceDetector();
    expect(detector.addMessage(at('1', 'Sounds good, thanks!')).importance).toBeLessThan(0.3);
  });

  it('scores corrections on the state-delta signal', () => {
    const detector = new ImportanceDetector();
    detector.addMessage(at('1', "Let's use PostgreSQL for the database."));
    const score = detector.addMessage(at('2', 'Actually, switch to SQLite instead.'));
    expect(score.stateDelta).toBeGreaterThan(0.3);
    expect(score.importance).toBeGreaterThan(0.2);
  });

  it('retrospective recomputation raises the reference signal of a re-mentioned message', () => {
    const detector = new ImportanceDetector();
    detector.addMessage(at('1', 'We chose "React" for the frontend framework.'));
    detector.addMessage(at('2', 'The color scheme should be blue.'));
    detector.addMessage(at('3', 'Going back to "React", we need server-side rendering.'));

    const before = detector.getScore('1')!.referenceFrequency;
    const after = detector.recomputeScores().get('1')!.referenceFrequency;
    expect(after).toBeGreaterThan(before);
  });

  it('accepts ISO 8601 timestamps', () => {
    const detector = new ImportanceDetector();
    const score = detector.addMessage({ id: 'iso', role: 'tool', content: 'Created `users` table', timestamp: '2026-01-01T00:00:00Z' });
    expect(score.messageId).toBe('iso');
  });
});

describe('ImportanceDetector cost (SH-29)', () => {
  // Bound: scoring is linear in the number of messages — 16000 chained
  // references take under 8x the time of 4000 (measured ~4-5x; the
  // per-message sort of every reference score made it ~14x and growing).
  it('scores a long chain of references in near-linear time', () => {
    const run = (n: number) => {
      const d = new ImportanceDetector();
      const start = performance.now();
      for (let i = 0; i < n; i++) {
        d.addMessage({ id: `m${i}`, role: 'user', content: `Then \`ent${i}\` follows \`ent${i - 1}\`.`, timestamp: i });
      }
      d.recomputeScores();
      return performance.now() - start;
    };
    run(500); // warm up
    // Best of two runs each, to keep GC pauses out of the ratio
    const small = Math.min(run(4_000), run(4_000));
    const large = Math.min(run(16_000), run(16_000));
    expect(large).toBeLessThan(Math.max(small * 8, 250));
  });
});
