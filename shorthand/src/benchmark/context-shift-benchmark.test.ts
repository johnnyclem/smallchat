/**
 * Context-shift benchmark — offline wiring and the gate.
 *
 * The offline run (RegexInterpreter + KeywordJudge + echo answerer) is a
 * wiring smoke test: the regex tier substitutes the template and nothing
 * else, so it cannot show that interpretation helps. These tests pin that
 * the fixtures do not hand the answer to the interpreted arm (SH-18) and
 * that the gate only passes a run that could support the claim.
 */
import { describe, it, expect } from 'vitest';
import {
  ContextShiftBenchmark,
  evaluateGate,
  wilson95,
  type Answerer,
} from './context-shift-benchmark.js';
import { KeywordJudge } from './judges.js';
import { STARTER_FIXTURES } from './fixtures.js';
import { RegexInterpreter } from '../interpreter/regex-interpreter.js';
import type { Interpreter } from '../interpreter/types.js';
import type { BenchmarkFixture } from './types.js';

const TOKEN_RX = /[a-z0-9]+/g;
const tokens = (s: string) => new Set(s.toLowerCase().match(TOKEN_RX) ?? []);

/** A downstream answerer that is not the echo answerer (it answers with the injected text). */
const passThroughAnswerer: Answerer = async ({ injected }) => injected;

function fakeHost(interpret: Interpreter['interpret']): Interpreter {
  return { tier: 'host', interpret };
}

describe('ContextShiftBenchmark — offline regex+keyword', () => {
  it('runs all starter fixtures (6 non-baseline + 1 calibration)', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
      clock: () => 1_700_000_000_000,
      runIdFactory: () => 'fixed-run',
    });
    const report = await b.run(STARTER_FIXTURES);
    expect(report.results).toHaveLength(7);
    expect(report.results.filter((r) => r.fixture.expectRawWins)).toHaveLength(1);
    expect(report.runId).toBe('fixed-run');
    expect(report.judge).toBe('keyword');
    expect(report.interpreterTier).toBe('regex');
    expect(report.answerer).toBe('echo');
  });

  it('no fixture template carries answer terms the payload lacks (SH-18)', () => {
    // The template is written with the engram, before the read context
    // exists. A template that already states the expected answer measures
    // the fixture author, not the interpreter.
    for (const f of STARTER_FIXTURES) {
      const template = tokens(f.interpreterTemplate.replace(/\{\{\w+\}\}/g, ' '));
      const payload = tokens(f.payload);
      const leaked = [...tokens(f.task.expectedAnswer ?? '')].filter(
        (t) => template.has(t) && !payload.has(t),
      );
      expect(leaked, `fixture ${f.id}`).toEqual([]);
      expect(f.interpreterTemplate, `fixture ${f.id}`).not.toContain('{{context}}');
    }
  });

  it('a payload-blind interpreter wins nothing (SH-18)', async () => {
    // Returns the template's static text and ignores payload and context.
    const blind = fakeHost(async ({ template }) => template.replace(/\{\{\w+\}\}/g, '').trim());
    const report = await new ContextShiftBenchmark({
      interpreter: blind,
      judge: new KeywordJudge(),
      answerer: passThroughAnswerer,
    }).run(STARTER_FIXTURES);
    expect(report.aggregate.wins).toBe(0);
    expect(report.gate.passed).toBe(false);
  });

  it('the calibration fixture ties on the offline run', async () => {
    const report = await new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    }).run(STARTER_FIXTURES);
    const baseline = report.results.find((r) => r.fixture.expectRawWins);
    expect(baseline).toBeDefined();
    expect(baseline!.interp.score).toBe(baseline!.raw.score);
    expect(report.aggregate.calibrationFailures).toEqual([]);
  });

  it('token accounting > 0 and finite for both arms', async () => {
    const b = new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    });
    const report = await b.run(STARTER_FIXTURES);
    expect(report.aggregate.tokensRaw).toBeGreaterThan(0);
    expect(report.aggregate.tokensInterp).toBeGreaterThan(0);
    expect(Number.isFinite(report.aggregate.tokensRaw)).toBe(true);
    expect(Number.isFinite(report.aggregate.tokensInterp)).toBe(true);
  });

  it('the offline configuration never passes the gate: it is a wiring smoke test', async () => {
    const report = await new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    }).run(STARTER_FIXTURES);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.reasons.join('\n')).toMatch(/regex tier/);
    expect(report.gate.reasons.join('\n')).toMatch(/echo answerer/);
  });
});

describe('the gate', () => {
  const calibration = STARTER_FIXTURES.find((f) => f.expectRawWins)!;

  /** n synthetic non-calibration fixtures plus the calibration one. */
  function fixtures(n: number): BenchmarkFixture[] {
    const out: BenchmarkFixture[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        id: `synthetic-${i}`,
        shiftType: 'audience',
        payload: `note ${i}`,
        interpreterTemplate: 'Earlier note, still relevant: {{payload}}',
        writeContext: 'w',
        readContext: 'r',
        task: { question: 'q', expectedAnswer: `alpha${i} beta${i} gamma${i}` },
      });
    }
    return [...out, calibration];
  }

  /** Answers every synthetic fixture exactly and restates the calibration payload verbatim. */
  const oracle = fakeHost(async ({ payload }) => {
    const m = /^note (\d+)$/.exec(payload);
    return m ? `alpha${m[1]} beta${m[1]} gamma${m[1]}` : payload;
  });

  it('passes a run that could support the claim', async () => {
    const report = await new ContextShiftBenchmark({
      interpreter: oracle,
      judge: new KeywordJudge(),
      answerer: passThroughAnswerer,
    }).run(fixtures(30));
    expect(report.aggregate.wins).toBe(30);
    expect(report.gate).toEqual({ passed: true, reasons: [] });
  });

  it('fails when too few fixtures were decided, even if every one was won', async () => {
    const report = await new ContextShiftBenchmark({
      interpreter: oracle,
      judge: new KeywordJudge(),
      answerer: passThroughAnswerer,
    }).run(fixtures(6));
    expect(report.aggregate.wilson95[0]).toBeGreaterThan(0.5);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.reasons.join('\n')).toMatch(/6 decided fixtures/);
    expect(evaluateGate(report, { minDecided: 6 }).passed).toBe(true);
  });

  it('fails when the interpretation loses a calibration fixture (it dropped the fact)', async () => {
    const dropsFacts = fakeHost(async (input, opts) =>
      input.payload.startsWith('note ') ? oracle.interpret(input, opts) : 'the deploy key fingerprint',
    );
    const report = await new ContextShiftBenchmark({
      interpreter: dropsFacts,
      judge: new KeywordJudge(),
      answerer: passThroughAnswerer,
    }).run(fixtures(30));
    expect(report.aggregate.calibrationFailures).toEqual([calibration.id]);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.reasons.join('\n')).toMatch(/calibration/);
  });

  it('fails when the interpretation wins a calibration fixture (the judge rewards restatement)', async () => {
    const judge = {
      name: 'keyword' as const,
      score: async ({ answer }: { answer: string }) => (answer.startsWith('Restated') ? 1 : 0.5),
    };
    const restates = fakeHost(async ({ payload }) => `Restated: ${payload}`);
    const report = await new ContextShiftBenchmark({
      interpreter: restates,
      judge,
      answerer: passThroughAnswerer,
    }).run([calibration]);
    expect(report.aggregate.calibrationFailures).toEqual([calibration.id]);
  });

  it('records a failed interpretation instead of scoring the raw payload as interpreted', async () => {
    const down = fakeHost(async () => {
      throw new Error('503 overloaded');
    });
    const report = await new ContextShiftBenchmark({
      interpreter: down,
      judge: new KeywordJudge(),
      answerer: passThroughAnswerer,
    }).run(fixtures(30));
    expect(report.aggregate.interpretFailures).toBe(31);
    expect(report.results[0].interpretError).toMatch(/503 overloaded/);
    expect(report.gate.passed).toBe(false);
    expect(report.gate.reasons.join('\n')).toMatch(/31 interpretations failed/);
  });
});

describe('wilson95', () => {
  it('returns [0, 1] for n=0', () => {
    expect(wilson95(0, 0)).toEqual([0, 1]);
  });

  it('returns a tight CI for 5/5', () => {
    const [lo, hi] = wilson95(5, 5);
    expect(lo).toBeGreaterThan(0.5);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it('center near 0.5 for 5/10', () => {
    const [lo, hi] = wilson95(5, 10);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
});
