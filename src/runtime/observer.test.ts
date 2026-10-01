/**
 * Feature: Dispatch Observer
 *
 * Records dispatches and schema rejections, and holds the negative
 * examples dispatch consults. Negative examples come from explicit
 * feedback; implicit correction detection is opt-in (SC-INF-06).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DispatchObserver,
  type DispatchRecord,
} from './observer.js';

function makeRecord(
  overrides: Partial<DispatchRecord> = {},
): DispatchRecord {
  return {
    intent: 'test intent',
    tool: 'p/toolA',
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
  // Default: no implicit corrections
  // -------------------------------------------------------------------------

  describe('Scenario: Implicit corrections are off by default', () => {
    it('Given two dispatches to different tools within the window, When recordDispatch is called, Then nothing is inferred', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/search', intent: 'search issues', timestamp: now }));
      const correction = observer.recordDispatch(makeRecord({ tool: 'p/open', intent: 'open issue 42', timestamp: now + 100 }));

      expect(correction).toBeNull();
      expect(observer.getCorrections()).toHaveLength(0);
      expect(observer.getNegativeExamples()).toHaveLength(0);
      expect(observer.implicitCorrections).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Opt-in correction detection
  // -------------------------------------------------------------------------

  describe('Scenario: Correction detection (implicitCorrections: true)', () => {
    beforeEach(() => {
      observer = new DispatchObserver({ implicitCorrections: true });
    });

    it('Given two dispatches to different tools within the window, When recordDispatch is called, Then a correction signal is returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/toolA', intent: 'open file', timestamp: now }));
      const correction = observer.recordDispatch(
        makeRecord({ tool: 'p/toolB', intent: 'open file', timestamp: now + 5000 }),
      );

      expect(correction).not.toBeNull();
      expect(correction!.wrongTool).toBe('p/toolA');
      expect(correction!.rightTool).toBe('p/toolB');
      expect(observer.isNegativeExample('Open  File', 'p/toolA')).toBe(true);
      expect(observer.getNegativeExamples()[0].source).toBe('implicit-correction');
    });

    it('Given two dispatches to the same tool, When recordDispatch is called, Then no correction is returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/toolA', timestamp: now }));
      expect(observer.recordDispatch(makeRecord({ tool: 'p/toolA', timestamp: now + 1000 }))).toBeNull();
    });

    it('Given two dispatches outside the correction window, When recordDispatch is called, Then no correction is returned', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/toolA', timestamp: now }));
      expect(observer.recordDispatch(makeRecord({ tool: 'p/toolB', timestamp: now + 31_000 }))).toBeNull();
    });

    it('Given a custom correction window, When dispatches exceed it, Then no correction is detected', () => {
      observer = new DispatchObserver({ implicitCorrections: true, correctionWindowMs: 5000 });
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/toolA', timestamp: now }));
      expect(observer.recordDispatch(makeRecord({ tool: 'p/toolB', timestamp: now + 4000 }))).not.toBeNull();
      expect(observer.recordDispatch(makeRecord({ tool: 'p/toolC', timestamp: now + 10_000 }))).toBeNull();
    });

    it('Given dispatches from two principals, When they interleave, Then one never corrects the other', () => {
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/toolA', principal: 'alice', timestamp: now }));
      expect(observer.recordDispatch(makeRecord({ tool: 'p/toolB', principal: 'bob', timestamp: now + 10 }))).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Schema rejections are diagnostics only
  // -------------------------------------------------------------------------

  describe('Scenario: Schema rejection tracking', () => {
    it('Given a schema rejection, When recordSchemaRejection is called, Then the rejection is stored', () => {
      observer.recordSchemaRejection('p/toolX', 'do thing', 'missing field: name');

      const rejections = observer.getRejections();
      expect(rejections).toHaveLength(1);
      expect(rejections[0].tool).toBe('p/toolX');
      expect(rejections[0].intent).toBe('do thing');
      expect(rejections[0].error).toBe('missing field: name');
      expect(rejections[0].timestamp).toBeGreaterThan(0);
    });

    it('Given a schema rejection, When isNegativeExample is called, Then the tool is NOT blacklisted (the arguments were wrong)', () => {
      observer.recordSchemaRejection('p/toolX', 'do thing', 'validation error');
      expect(observer.isNegativeExample('do thing', 'p/toolX')).toBe(false);
      expect(observer.getNegativeExamples()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Explicit feedback
  // -------------------------------------------------------------------------

  describe('Scenario: Explicit feedback', () => {
    it('Given negative feedback, When isNegativeExample is called, Then the same intent text (normalized) and tool match', () => {
      observer.feedback({ intent: 'Greet the user', toolId: 'p/toolA', correct: false, expectedToolId: 'p/toolB' });

      expect(observer.isNegativeExample('greet  the user', 'p/toolA')).toBe(true);
      expect(observer.isNegativeExample('greet the user', 'p/toolB')).toBe(false);
      expect(observer.isNegativeExample('do not greet the user', 'p/toolA')).toBe(false);
      const [example] = observer.getNegativeExamples();
      expect(example).toMatchObject({ intent: 'greet the user', wrongTool: 'p/toolA', correctTool: 'p/toolB', source: 'feedback' });
    });

    it('Given positive feedback after negative, When isNegativeExample is called, Then the example is cleared', () => {
      observer.feedback({ intent: 'greet', toolId: 'p/toolA', correct: false });
      observer.feedback({ intent: 'greet', toolId: 'p/toolA', correct: true });
      expect(observer.isNegativeExample('greet', 'p/toolA')).toBe(false);
    });

    it('Given principal-scoped feedback, When another principal asks, Then it does not apply', () => {
      observer.feedback({ intent: 'greet', toolId: 'p/toolA', correct: false, principal: 'alice' });
      expect(observer.isNegativeExample('greet', 'p/toolA', 'alice')).toBe(true);
      expect(observer.isNegativeExample('greet', 'p/toolA', 'bob')).toBe(false);
      expect(observer.isNegativeExample('greet', 'p/toolA')).toBe(false);
    });

    it('Given repeated identical feedback, When getNegativeExamples is called, Then it is stored once', () => {
      observer.feedback({ intent: 'greet', toolId: 'p/toolA', correct: false });
      observer.feedback({ intent: 'greet', toolId: 'p/toolA', correct: false });
      expect(observer.getNegativeExamples()).toHaveLength(1);
    });

    it('Given no negative examples, When isNegativeExample is called, Then it returns false', () => {
      expect(observer.isNegativeExample('anything', 'p/anyTool')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Reset and capacity
  // -------------------------------------------------------------------------

  describe('Scenario: Reset clears all state', () => {
    it('Given accumulated state, When reset is called, Then all state is cleared', () => {
      observer = new DispatchObserver({ implicitCorrections: true });
      const now = Date.now();
      observer.recordDispatch(makeRecord({ tool: 'p/toolA', intent: 'greet', timestamp: now }));
      observer.recordDispatch(makeRecord({ tool: 'p/toolB', intent: 'greet', timestamp: now + 100 }));
      observer.recordSchemaRejection('p/toolC', 'send', 'bad input');
      observer.feedback({ intent: 'x', toolId: 'p/toolD', correct: false });

      observer.reset();

      expect(observer.getCorrections()).toHaveLength(0);
      expect(observer.getRejections()).toHaveLength(0);
      expect(observer.getNegativeExamples()).toHaveLength(0);
      expect(observer.isNegativeExample('greet', 'p/toolA')).toBe(false);
      expect(observer.recordDispatch(makeRecord({ tool: 'p/toolE', timestamp: now + 200 }))).toBeNull();
    });
  });

  describe('Scenario: Max capacity limits', () => {
    it('Given maxNegativeExamples is reached, When a new negative example is added, Then the oldest is evicted', () => {
      observer = new DispatchObserver({ maxNegativeExamples: 3 });
      for (let i = 0; i < 4; i++) {
        observer.feedback({ intent: `intent${i}`, toolId: `p/wrong${i}`, correct: false });
      }
      expect(observer.getNegativeExamples()).toHaveLength(3);
      expect(observer.isNegativeExample('intent0', 'p/wrong0')).toBe(false);
      expect(observer.isNegativeExample('intent3', 'p/wrong3')).toBe(true);
    });

    it('Given maxRecentDispatches is reached, When corrections are inferred, Then only the latest dispatch is compared', () => {
      observer = new DispatchObserver({ implicitCorrections: true, maxRecentDispatches: 3 });
      const now = Date.now();
      for (const [i, intent] of ['first', 'second', 'third', 'fourth'].entries()) {
        observer.recordDispatch(makeRecord({ tool: 'p/toolA', intent, timestamp: now + i * 100 }));
      }
      const correction = observer.recordDispatch(makeRecord({ tool: 'p/toolB', intent: 'fourth', timestamp: now + 400 }));
      expect(correction!.wrongIntent).toBe('fourth');
    });
  });
});
