/**
 * Feature: @smallchat/core/importance re-exports @shorthand/core/importance
 *
 * src/importance/index.ts was once a full duplicate implementation that
 * drifted from @shorthand/core/importance. It is a thin, deprecated
 * re-export (`export *`) of the canonical package. The logic is tested by
 * @shorthand/core's own suite (shorthand/ mirrors it; `npm test
 * --workspace=shorthand`); this file checks that the subpath's public
 * surface still resolves and works end-to-end.
 */

import { describe, it, expect } from 'vitest';
import {
  ImportanceDetector,
  EntityGraph,
  computeStateDelta,
  extractEntities,
  extractRelations,
  TrajectoryTracker,
  RunningStats,
  cosineSimilarity,
  cosineDistance,
  ReferenceGraph,
  DEFAULT_IMPORTANCE_CONFIG,
} from './index.js';

describe('Feature: importance barrel re-exports @shorthand/core/importance', () => {
  it('Given the re-exported symbols, When checked, Then every expected export resolves to a real value', () => {
    expect(ImportanceDetector).toBeTypeOf('function');
    expect(EntityGraph).toBeTypeOf('function');
    expect(computeStateDelta).toBeTypeOf('function');
    expect(extractEntities).toBeTypeOf('function');
    expect(extractRelations).toBeTypeOf('function');
    expect(TrajectoryTracker).toBeTypeOf('function');
    expect(RunningStats).toBeTypeOf('function');
    expect(cosineSimilarity).toBeTypeOf('function');
    expect(cosineDistance).toBeTypeOf('function');
    expect(ReferenceGraph).toBeTypeOf('function');
    expect(DEFAULT_IMPORTANCE_CONFIG).toBeTypeOf('object');
  });

  it('Given a real ImportanceDetector, When scoring a trivial message, Then it produces a well-formed ImportanceScore end-to-end through the re-export', () => {
    const detector = new ImportanceDetector();
    const score = detector.addMessage({
      id: 'm1',
      role: 'user',
      content: 'hello world',
      timestamp: Date.now(),
    });

    expect(score.messageId).toBe('m1');
    expect(typeof score.importance).toBe('number');
    expect(['state_delta', 'reference_frequency', 'trajectory_discontinuity']).toContain(score.dominantSignal);
  });
});
