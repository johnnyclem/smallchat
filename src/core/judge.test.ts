/**
 * The vendor-neutral judge rules (core/judge.ts) where they are used on
 * their own, outside dispatch: acceptJudgeAnswer and replayJudgeVerdict
 * as other implementations reuse them, judgeSettings and judgeDescription.
 * Dispatch is covered by runtime/judge-dispatch.test.ts and
 * spec/judge/vectors.json.
 */

import { describe, it, expect } from 'vitest';
import { acceptJudgeAnswer, judgeDescription, judgeSettings, replayJudgeVerdict, DEFAULT_JUDGE_TIMEOUT_MS, JUDGE_DESCRIPTION_CHARS } from './judge.js';

const answered = (probability: number | null) => ({ status: 'answered', choice: 'a/b', probability, confidence: null });

describe('acceptJudgeAnswer fails closed', () => {
  it('declines at any probability when acceptThreshold is not a number in (0, 1]', () => {
    for (const threshold of [Number.NaN, undefined as unknown as number, null as unknown as number, '0.7' as unknown as number, 0, -1, 2]) {
      for (const probability of [0, 0.5, 1]) {
        expect(acceptJudgeAnswer(answered(probability), ['a/b'], threshold, 'm'), `${String(threshold)} @ ${probability}`)
          .toMatchObject({ verdict: 'declined', reason: 'below-threshold', toolId: null });
      }
    }
  });

  it('approves only at or above a valid threshold', () => {
    expect(acceptJudgeAnswer(answered(0.7), ['a/b'], 0.7, 'm')).toMatchObject({ verdict: 'approved', toolId: 'a/b' });
    expect(acceptJudgeAnswer(answered(0.6999), ['a/b'], 0.7, 'm')).toMatchObject({ verdict: 'declined', reason: 'below-threshold' });
  });
});

describe('replayJudgeVerdict invents nothing', () => {
  it('a recorded decline or unavailable without a reason records none', () => {
    expect(replayJudgeVerdict({ verdict: 'declined' }, ['a/b'], 'm').reason).toBeNull();
    expect(replayJudgeVerdict({ verdict: 'unavailable' }, ['a/b'], 'm').reason).toBeNull();
    expect(replayJudgeVerdict({ verdict: 'unavailable', reason: 'TIMEOUT' }, ['a/b'], 'm').reason).toBe('TIMEOUT');
    expect(replayJudgeVerdict({ verdict: 'declined', reason: 'below-threshold' }, ['a/b'], 'm').reason).toBe('below-threshold');
  });

  it('a recorded approval is not checked against a threshold again', () => {
    expect(replayJudgeVerdict({ verdict: 'approved', toolId: 'a/b', probability: 0.1 }, ['a/b'], 'm'))
      .toMatchObject({ verdict: 'approved', toolId: 'a/b', probability: 0.1 });
  });
});

describe('judgeSettings', () => {
  it('defaults and validates timeoutMs, the deadline the runtime holds every judge to', () => {
    expect(judgeSettings({}).timeoutMs).toBe(DEFAULT_JUDGE_TIMEOUT_MS);
    expect(judgeSettings({ timeoutMs: 250 }).timeoutMs).toBe(250);
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => judgeSettings({ timeoutMs }), String(timeoutMs)).toThrow(TypeError);
    }
  });
});

describe('judgeDescription', () => {
  it('never splits a surrogate pair at the cut', () => {
    const cut = judgeDescription(`${'x'.repeat(239)}\u{1F600}tail`);
    expect(cut).toBe('x'.repeat(239));
    expect(cut.length).toBe(JUDGE_DESCRIPTION_CHARS - 1);
    // A pair that ends at the cut is kept whole.
    expect(judgeDescription(`${'x'.repeat(238)}\u{1F600}tail`)).toBe(`${'x'.repeat(238)}\u{1F600}`);
    expect(judgeDescription('x'.repeat(300))).toHaveLength(JUDGE_DESCRIPTION_CHARS);
  });
});
