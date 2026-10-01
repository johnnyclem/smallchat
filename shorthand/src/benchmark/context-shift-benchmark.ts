/**
 * ContextShiftBenchmark — runs the held-out task suite that compares
 * interpret(shiftedContext) against a raw-payload-dump baseline.
 *
 * For each fixture, the benchmark builds a minimal ActiveEngramStore
 * containing one engram (the fixture's payload + interpreterTemplate). It
 * then runs two arms:
 *
 *   raw         — inject `payload` verbatim
 *   interpreted — inject the interpreted form against `readContext`
 *
 * For each arm, the benchmark calls a pluggable `answerer` to produce the
 * downstream task answer, and a pluggable `Judge` to score it. Aggregate
 * statistics (win rate, mean lift, Wilson 95% CI) exclude any fixture marked
 * `expectRawWins` — the calibration baseline, which must tie.
 *
 * `report.gate` says whether the run could support the claim at all (see
 * `evaluateGate`). The offline configuration (regex tier, echo answerer)
 * never passes it: it is a wiring smoke test. Interpretation failures are
 * recorded, never hidden; pass the interpreter itself, not a `withFallback`
 * wrapper, or a fallback inside it is scored as the primary tier.
 */
import { ActiveEngramStore } from '../crdt/active-engram-store.js';
import { estimateTokens } from '../utils.js';
import {
  silentLogger,
  type Interpreter,
  type InterpretOptions,
  type InterpreterLogger,
} from '../interpreter/types.js';
import type { Judge } from './judges.js';
import type {
  ArmResult,
  BenchmarkAggregate,
  BenchmarkFixture,
  BenchmarkGate,
  BenchmarkReport,
  FixtureResult,
} from './types.js';

const TIE_EPS = 0.02;

/**
 * Decided (won or lost) non-calibration fixtures a run needs before the gate
 * can pass. The starter set is far smaller, so it can never pass on its own.
 */
export const DEFAULT_MIN_DECIDED = 30;

export interface AnswererArgs {
  question: string;
  injected: string;
  readContext: string;
}

export type Answerer = (args: AnswererArgs) => Promise<string>;

/**
 * Default offline answerer: echoes the injected text. The judge then scores
 * whether the injected text surfaces the expected-answer terms — isolating
 * the variable we care about (raw payload vs interpreted payload) without a
 * model-quality confound.
 */
export const echoAnswerer: Answerer = async ({ injected }) => injected;

export interface ContextShiftBenchmarkOptions {
  interpreter: Interpreter;
  judge: Judge;
  answerer?: Answerer;
  logger?: InterpreterLogger;
  /** Injectable for deterministic snapshots. */
  clock?: () => number;
  /** Injectable for deterministic snapshots. */
  runIdFactory?: () => string;
  /** Gate thresholds (see `evaluateGate`). */
  gate?: GateOptions;
}

export interface GateOptions {
  /** Minimum decided non-calibration fixtures. Default `DEFAULT_MIN_DECIDED` (30). */
  minDecided?: number;
}

export interface RunOptions {
  interpretOpts?: Partial<InterpretOptions>;
}

export class ContextShiftBenchmark {
  private readonly interpreter: Interpreter;
  private readonly judge: Judge;
  private readonly answerer: Answerer;
  private readonly logger: InterpreterLogger;
  private readonly clock: () => number;
  private readonly runIdFactory: () => string;
  private readonly gateOptions: GateOptions;

  constructor(opts: ContextShiftBenchmarkOptions) {
    this.interpreter = opts.interpreter;
    this.judge = opts.judge;
    this.answerer = opts.answerer ?? echoAnswerer;
    this.logger = opts.logger ?? silentLogger;
    this.clock = opts.clock ?? (() => Date.now());
    this.runIdFactory =
      opts.runIdFactory ?? (() => `run-${Date.now().toString(36)}`);
    this.gateOptions = opts.gate ?? {};
  }

  async run(
    fixtures: BenchmarkFixture[],
    opts: RunOptions = {},
  ): Promise<BenchmarkReport> {
    const startedAt = this.clock();
    const results: FixtureResult[] = [];

    for (const fixture of fixtures) {
      const result = await this.runOne(fixture, opts);
      results.push(result);
    }

    const finishedAt = this.clock();
    const report: Omit<BenchmarkReport, 'gate'> = {
      runId: this.runIdFactory(),
      startedAt,
      finishedAt,
      judge: this.judge.name,
      interpreterTier: this.interpreter.tier,
      answerer: this.answerer === echoAnswerer ? 'echo' : 'custom',
      results,
      aggregate: aggregate_(results),
    };
    return { ...report, gate: evaluateGate(report, this.gateOptions) };
  }

  private async runOne(
    fixture: BenchmarkFixture,
    opts: RunOptions,
  ): Promise<FixtureResult> {
    const store = new ActiveEngramStore({
      interpreter: this.interpreter,
      logger: this.logger,
    });
    const id = store.add(fixture.payload, {
      interpreterTemplate: fixture.interpreterTemplate,
      activationPolicy: { surfaceWhenTopics: [] },
    });

    const raw = await this.runArm('raw', fixture, fixture.payload);

    let interpInjected = fixture.payload;
    let interpretError: string | undefined;
    try {
      const r = await store.interpretAsync(
        id,
        fixture.readContext,
        opts.interpretOpts,
      );
      if (r) interpInjected = r.interpreted;
    } catch (err) {
      interpretError = err instanceof Error ? err.message : String(err);
      this.logger.warn('interpret_failed_in_benchmark', {
        fixtureId: fixture.id,
        message: interpretError,
      });
      // Inject the payload, as a host would at the edge, but record the
      // failure: the arm no longer measures interpretation, and the gate
      // fails on it.
    }
    const interp = await this.runArm('interpreted', fixture, interpInjected);

    return {
      fixture,
      raw,
      interp,
      delta: interp.score - raw.score,
      ...(interpretError !== undefined ? { interpretError } : {}),
    };
  }

  private async runArm(
    arm: ArmResult['arm'],
    fixture: BenchmarkFixture,
    injected: string,
  ): Promise<ArmResult> {
    const answer = await this.answerer({
      question: fixture.task.question,
      injected,
      readContext: fixture.readContext,
    });
    const score = await this.judge.score({
      answer,
      expectedAnswer: fixture.task.expectedAnswer,
      rubric: fixture.task.rubric,
      readContext: fixture.readContext,
    });
    return {
      arm,
      injected,
      answer,
      score,
      tokensIn: estimateTokens(injected) + estimateTokens(fixture.task.question),
      tokensOut: estimateTokens(answer),
    };
  }
}

function aggregate_(results: FixtureResult[]): BenchmarkAggregate {
  const scored = results.filter((r) => !r.fixture.expectRawWins);
  const calibrationFailures = results
    .filter((r) => r.fixture.expectRawWins && Math.abs(r.delta) > TIE_EPS)
    .map((r) => r.fixture.id);
  const interpretFailures = results.filter((r) => r.interpretError !== undefined).length;
  let wins = 0;
  let ties = 0;
  let losses = 0;
  let liftSum = 0;
  let tokensRaw = 0;
  let tokensInterp = 0;

  for (const r of scored) {
    if (r.delta > TIE_EPS) wins++;
    else if (r.delta < -TIE_EPS) losses++;
    else ties++;
    liftSum += r.delta;
  }

  for (const r of results) {
    tokensRaw += r.raw.tokensIn + r.raw.tokensOut;
    tokensInterp += r.interp.tokensIn + r.interp.tokensOut;
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : 0;
  const meanLift = scored.length > 0 ? liftSum / scored.length : 0;
  const wilson = wilson95(wins, decided);

  return {
    winRate,
    meanLift,
    wins,
    ties,
    losses,
    wilson95: wilson,
    tokensRaw,
    tokensInterp,
    calibrationFailures,
    interpretFailures,
  };
}

/**
 * The gate: every condition a run must meet before its numbers can count as
 * evidence that interpretation beats raw injection. Passing says the run
 * could have shown it, and did on these fixtures; it does not generalize past
 * them, and the judge's and answerer's biases still apply.
 *
 * - a tier that interprets (the regex tier substitutes the template only);
 * - a downstream answerer (the echo answerer scores the injected text itself);
 * - no failed interpretations (their arms injected the raw payload);
 * - every calibration fixture ties (losing it drops a fact the question
 *   needs; winning it means the judge rewards restatement over fidelity);
 * - at least `minDecided` decided non-calibration fixtures;
 * - a Wilson 95% lower bound on wins / (wins + losses) above 0.5.
 */
export function evaluateGate(
  report: Omit<BenchmarkReport, 'gate'>,
  opts: GateOptions = {},
): BenchmarkGate {
  const minDecided = opts.minDecided ?? DEFAULT_MIN_DECIDED;
  const a = report.aggregate;
  const reasons: string[] = [];
  if (report.interpreterTier === 'regex') {
    reasons.push(
      'regex tier: it substitutes the template and nothing else, so the run cannot show that interpretation helps (wiring smoke test)',
    );
  }
  if (report.answerer === 'echo') {
    reasons.push('echo answerer: it scores the injected text itself, not a downstream answer');
  }
  if (a.interpretFailures > 0) {
    reasons.push(
      `${a.interpretFailures} interpretation${a.interpretFailures === 1 ? '' : 's'} failed; those arms injected the raw payload`,
    );
  }
  if (a.calibrationFailures.length > 0) {
    reasons.push(`calibration fixtures did not tie: ${a.calibrationFailures.join(', ')}`);
  }
  const decided = a.wins + a.losses;
  if (decided < minDecided) {
    reasons.push(`${decided} decided fixtures (fewer than ${minDecided}): too few to support a claim`);
  }
  if (!(a.wilson95[0] > 0.5)) {
    reasons.push(`Wilson 95% lower bound ${a.wilson95[0].toFixed(3)} is not above 0.5`);
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * Wilson score interval for a binomial proportion at 95% confidence.
 * Returns [lower, upper]. n=0 returns [0, 1] (uninformed).
 */
export function wilson95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.959963984540054; // 95% two-sided
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [
    Math.max(0, (center - margin) / denom),
    Math.min(1, (center + margin) / denom),
  ];
}
