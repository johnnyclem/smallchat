/**
 * Feature: Dispatch Observer
 *
 * KVO-inspired observation layer that watches dispatch patterns,
 * detects corrections, tracks schema rejections, manages negative
 * examples, and adapts thresholds in real-time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DispatchObserver,
  type DispatchRecord,
  type CorrectionSignal,
} from './observer.js';
import { DEFAULT_THRESHOLDS } from '../core/confidence.js';

function makeRecord(
  overrides: Partial<DispatchRecord> = {},
): DispatchRecord {
  return {
    intent: 'test intent',
    tool: 'toolA',
    confidence: 0.8,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Feature: Dispatch Observer', () => {
  let observer: DispatchObserver;

  beforeEach(() => {
    observer = new DispatchObserver();
  });

  // -------------------------------------------------------------------------
  // Correction detection
  // -------------------------------------------------------------------------

  describe('Scenario: Correction detection', () => {
    it('Given two dispatches to different tools within the window, When recordDispatch is called, Then a correction signal is returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'open file', timestamp: now }));
      const correction = observer.recordDispatch(
        makeRecord({ tool: 'toolB', intent: 'open file', timestamp: now + 5000 }),
      );

      expect(correction).not.toBeNull();
      expect(correction!.wrongTool).toBe('toolA');
      expect(correction!.rightTool).toBe('toolB');
      expect(correction!.wrongIntent).toBe('open file');
      expect(correction!.rightIntent).toBe('open file');
    });

    it('Given two dispatches to the same tool, When recordDispatch is called, Then no correction is returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));
      const correction = observer.recordDispatch(
        makeRecord({ tool: 'toolA', timestamp: now + 1000 }),
      );

      expect(correction).toBeNull();
    });

    it('Given two dispatches outside the correction window, When recordDispatch is called, Then no correction is returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));
      const correction = observer.recordDispatch(
        makeRecord({ tool: 'toolB', timestamp: now + 31_000 }),
      );

      expect(correction).toBeNull();
    });

    it('Given a custom correction window, When dispatches are within that window, Then a correction is detected', () => {
      observer = new DispatchObserver({ correctionWindowMs: 5000 });
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));

      // Within 5s window
      const within = observer.recordDispatch(
        makeRecord({ tool: 'toolB', timestamp: now + 4000 }),
      );
      expect(within).not.toBeNull();
    });

    it('Given a custom correction window, When dispatches exceed that window, Then no correction is detected', () => {
      observer = new DispatchObserver({ correctionWindowMs: 5000 });
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));

      const outside = observer.recordDispatch(
        makeRecord({ tool: 'toolC', timestamp: now + 6000 }),
      );
      expect(outside).toBeNull();
    });

    it('Given the first dispatch ever, When recordDispatch is called, Then no correction is returned', () => {
      const correction = observer.recordDispatch(makeRecord());
      expect(correction).toBeNull();
    });

    it('Given a correction is detected, When getCorrections is called, Then the correction is in the list', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolB', timestamp: now + 100 }));

      const corrections = observer.getCorrections();
      expect(corrections).toHaveLength(1);
      expect(corrections[0].wrongTool).toBe('toolA');
      expect(corrections[0].rightTool).toBe('toolB');
    });
  });

  // -------------------------------------------------------------------------
  // Schema rejection tracking
  // -------------------------------------------------------------------------

  describe('Scenario: Schema rejection tracking', () => {
    it('Given a schema rejection, When recordSchemaRejection is called, Then the rejection is stored', () => {
      observer.recordSchemaRejection('toolX', 'do thing', 'missing field: name');

      const rejections = observer.getRejections();
      expect(rejections).toHaveLength(1);
      expect(rejections[0].tool).toBe('toolX');
      expect(rejections[0].intent).toBe('do thing');
      expect(rejections[0].error).toBe('missing field: name');
      expect(rejections[0].timestamp).toBeGreaterThan(0);
    });

    it('Given multiple schema rejections, When getRejections is called, Then all are returned', () => {
      observer.recordSchemaRejection('toolX', 'intent1', 'error1');
      observer.recordSchemaRejection('toolY', 'intent2', 'error2');
      observer.recordSchemaRejection('toolX', 'intent3', 'error3');

      expect(observer.getRejections()).toHaveLength(3);
    });

    it('Given a schema rejection, When isNegativeExample is called, Then the intent+tool is a negative example', () => {
      observer.recordSchemaRejection('toolX', 'do thing', 'validation error');

      expect(observer.isNegativeExample('do thing', 'toolX')).toBe(true);
      expect(observer.isNegativeExample('do thing', 'toolY')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Negative example tracking
  // -------------------------------------------------------------------------

  describe('Scenario: Negative example tracking', () => {
    it('Given a correction, When getNegativeExamples is called, Then the wrong dispatch is stored as a negative example', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'greet user', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolB', intent: 'greet user', timestamp: now + 100 }));

      const examples = observer.getNegativeExamples();
      expect(examples).toHaveLength(1);
      expect(examples[0].intent).toBe('greet user');
      expect(examples[0].wrongTool).toBe('toolA');
      expect(examples[0].correctTool).toBe('toolB');
    });

    it('Given a schema rejection, When getNegativeExamples is called, Then the rejection is stored as a negative example', () => {
      observer.recordSchemaRejection('toolZ', 'send email', 'bad schema');

      const examples = observer.getNegativeExamples();
      expect(examples).toHaveLength(1);
      expect(examples[0].intent).toBe('send email');
      expect(examples[0].wrongTool).toBe('toolZ');
      expect(examples[0].correctTool).toBeUndefined();
    });

    it('Given a negative example exists, When isNegativeExample is called with the same intent and tool, Then it returns true', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'greet', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolB', intent: 'greet', timestamp: now + 100 }));

      expect(observer.isNegativeExample('greet', 'toolA')).toBe(true);
    });

    it('Given a negative example exists, When isNegativeExample is called with a different intent, Then it returns false', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'greet', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolB', intent: 'greet', timestamp: now + 100 }));

      expect(observer.isNegativeExample('farewell', 'toolA')).toBe(false);
    });

    it('Given no negative examples, When isNegativeExample is called, Then it returns false', () => {
      expect(observer.isNegativeExample('anything', 'anyTool')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Adaptive thresholds
  // -------------------------------------------------------------------------

  describe('Scenario: Adaptive thresholds', () => {
    it('Given no corrections for a tool, When getAdaptedThresholds is called, Then default thresholds are returned', () => {
      const thresholds = observer.getAdaptedThresholds('unknownTool');

      expect(thresholds.exact).toBe(DEFAULT_THRESHOLDS.exact);
      expect(thresholds.high).toBe(DEFAULT_THRESHOLDS.high);
      expect(thresholds.medium).toBe(DEFAULT_THRESHOLDS.medium);
      expect(thresholds.low).toBe(DEFAULT_THRESHOLDS.low);
    });

    it('Given corrections below the threshold, When getAdaptedThresholds is called, Then thresholds are not bumped', () => {
      // Default correctionThreshold is 3, so 2 corrections should not bump
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'a', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'goodTool', intent: 'a', timestamp: now + 100 }));

      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'b', timestamp: now + 200 }));
      observer.recordDispatch(makeRecord({ tool: 'goodTool', intent: 'b', timestamp: now + 300 }));

      // Only 2 corrections for badTool, threshold is 3
      const thresholds = observer.getAdaptedThresholds('badTool');
      expect(thresholds.medium).toBe(DEFAULT_THRESHOLDS.medium);
    });

    it('Given enough corrections, When getAdaptedThresholds is called, Then the medium threshold is bumped', () => {
      // Need 3 corrections (default correctionThreshold) to trigger a bump
      const now = Date.now();

      // Correction 1
      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'a', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'good1', intent: 'a', timestamp: now + 100 }));

      // Correction 2
      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'b', timestamp: now + 200 }));
      observer.recordDispatch(makeRecord({ tool: 'good2', intent: 'b', timestamp: now + 300 }));

      // Correction 3 — this should trigger a threshold bump
      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'c', timestamp: now + 400 }));
      observer.recordDispatch(makeRecord({ tool: 'good3', intent: 'c', timestamp: now + 500 }));

      const thresholds = observer.getAdaptedThresholds('badTool');
      expect(thresholds.medium).toBeGreaterThan(DEFAULT_THRESHOLDS.medium);
      expect(thresholds.high).toBeGreaterThan(DEFAULT_THRESHOLDS.high);
      // exact and low should remain unchanged
      expect(thresholds.exact).toBe(DEFAULT_THRESHOLDS.exact);
      expect(thresholds.low).toBe(DEFAULT_THRESHOLDS.low);
    });

    it('Given a custom threshold bump amount, When enough corrections occur, Then the bump uses the custom amount', () => {
      observer = new DispatchObserver({
        correctionThreshold: 1,
        thresholdBumpAmount: 0.10,
      });
      const now = Date.now();

      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'x', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'goodTool', intent: 'x', timestamp: now + 100 }));

      const thresholds = observer.getAdaptedThresholds('badTool');
      expect(thresholds.medium).toBeCloseTo(DEFAULT_THRESHOLDS.medium + 0.10, 5);
    });

    it('Given the threshold would exceed 0.95, When a bump occurs, Then the threshold is capped at 0.95', () => {
      observer = new DispatchObserver({
        correctionThreshold: 1,
        thresholdBumpAmount: 0.50,
      });
      const now = Date.now();

      observer.recordDispatch(makeRecord({ tool: 'badTool', intent: 'x', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'goodTool', intent: 'x', timestamp: now + 100 }));

      const thresholds = observer.getAdaptedThresholds('badTool');
      expect(thresholds.medium).toBeLessThanOrEqual(0.95);
      expect(thresholds.high).toBeLessThanOrEqual(0.95);
    });

    it('Given schema rejections count toward the threshold, When enough rejections occur, Then the threshold is bumped', () => {
      observer = new DispatchObserver({ correctionThreshold: 3 });

      observer.recordSchemaRejection('badTool', 'intent1', 'err1');
      observer.recordSchemaRejection('badTool', 'intent2', 'err2');
      observer.recordSchemaRejection('badTool', 'intent3', 'err3');

      const thresholds = observer.getAdaptedThresholds('badTool');
      expect(thresholds.medium).toBeGreaterThan(DEFAULT_THRESHOLDS.medium);
    });

    it('Given adaptive thresholds exist, When getAdaptiveThresholds is called, Then all entries are returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'a', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolB', intent: 'a', timestamp: now + 100 }));

      const map = observer.getAdaptiveThresholds();
      expect(map.size).toBeGreaterThan(0);
      expect(map.has('toolA')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  describe('Scenario: Reset clears all state', () => {
    it('Given accumulated state, When reset is called, Then all state is cleared', () => {
      const now = Date.now();

      // Accumulate some state
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'greet', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolB', intent: 'greet', timestamp: now + 100 }));
      observer.recordSchemaRejection('toolC', 'send', 'bad input');

      // Verify state exists
      expect(observer.getCorrections().length).toBeGreaterThan(0);
      expect(observer.getRejections().length).toBeGreaterThan(0);
      expect(observer.getNegativeExamples().length).toBeGreaterThan(0);
      expect(observer.getAdaptiveThresholds().size).toBeGreaterThan(0);

      // Reset
      observer.reset();

      // Verify all cleared
      expect(observer.getCorrections()).toHaveLength(0);
      expect(observer.getRejections()).toHaveLength(0);
      expect(observer.getNegativeExamples()).toHaveLength(0);
      expect(observer.getAdaptiveThresholds().size).toBe(0);
      expect(observer.isNegativeExample('greet', 'toolA')).toBe(false);
    });

    it('Given reset was called, When a new dispatch is recorded, Then no correction is detected from pre-reset state', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));
      observer.reset();

      const correction = observer.recordDispatch(
        makeRecord({ tool: 'toolB', timestamp: now + 100 }),
      );
      expect(correction).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Max capacity limits
  // -------------------------------------------------------------------------

  describe('Scenario: Max capacity limits', () => {
    it('Given maxRecentDispatches is reached, When a new dispatch is added, Then the oldest dispatch is evicted', () => {
      observer = new DispatchObserver({ maxRecentDispatches: 3 });
      const now = Date.now();

      // Fill up to capacity
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'first', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'second', timestamp: now + 100 }));
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'third', timestamp: now + 200 }));
      // This should evict the first dispatch
      observer.recordDispatch(makeRecord({ tool: 'toolA', intent: 'fourth', timestamp: now + 300 }));

      // The oldest dispatch (intent: 'first') should have been evicted.
      // We can verify indirectly: dispatch toolB now. The previous dispatch is
      // toolA with intent 'fourth', so a correction from 'fourth' should be detected.
      const correction = observer.recordDispatch(
        makeRecord({ tool: 'toolB', intent: 'fourth', timestamp: now + 400 }),
      );
      expect(correction).not.toBeNull();
      expect(correction!.wrongIntent).toBe('fourth');
    });

    it('Given maxNegativeExamples is reached, When a new negative example is added, Then the oldest is evicted', () => {
      observer = new DispatchObserver({
        maxNegativeExamples: 3,
        correctionWindowMs: 100_000,
      });
      const now = Date.now();

      // Generate 4 corrections -> 4 negative examples, but max is 3
      for (let i = 0; i < 4; i++) {
        observer.recordDispatch(
          makeRecord({ tool: `wrong${i}`, intent: `intent${i}`, timestamp: now + i * 100 }),
        );
        observer.recordDispatch(
          makeRecord({ tool: `right${i}`, intent: `intent${i}`, timestamp: now + i * 100 + 50 }),
        );
      }

      const examples = observer.getNegativeExamples();
      expect(examples).toHaveLength(3);

      // The first negative example (wrong0/intent0) should have been evicted
      expect(observer.isNegativeExample('intent0', 'wrong0')).toBe(false);
      // The later ones should still exist
      expect(observer.isNegativeExample('intent3', 'wrong3')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Default options
  // -------------------------------------------------------------------------

  describe('Scenario: Default constructor options', () => {
    it('Given no options, When the observer is created, Then default values are used', () => {
      const obs = new DispatchObserver();
      // Verify defaults indirectly: correction window is 30s
      const now = Date.now();
      obs.recordDispatch(makeRecord({ tool: 'toolA', timestamp: now }));

      // 29s later — within 30s window
      const withinWindow = obs.recordDispatch(
        makeRecord({ tool: 'toolB', timestamp: now + 29_000 }),
      );
      expect(withinWindow).not.toBeNull();
    });
  });
});
