/**
 * Context-shift benchmark schemas.
 */
import type { InterpreterTier } from '../interpreter/types.js';

export type ShiftType =
  | 'tech-stack'
  | 'audience'
  | 'tone'
  | 'time-frame'
  | 'scope-expansion'
  | 'terminology'
  | 'baseline';

export interface BenchmarkFixture {
  id: string;
  shiftType: ShiftType;
  payload: string;
  interpreterTemplate: string;
  writeContext: string;
  readContext: string;
  task: {
    question: string;
    expectedAnswer?: string;
    rubric?: string;
  };
  /**
   * Calibration fixture: the question needs the payload verbatim (a
   * fingerprint, an id), so interpretation cannot help. The interpreted arm
   * must tie the raw arm: losing means the interpretation dropped the fact,
   * winning means the judge rewards restatement over fidelity. Excluded from
   * win-rate / mean-lift aggregation; a calibration fixture that does not tie
   * fails the gate.
   */
  expectRawWins?: boolean;
}

export interface ArmResult {
  arm: 'raw' | 'interpreted';
  injected: string;
  answer: string;
  score: number;
  tokensIn: number;
  tokensOut: number;
}

export interface FixtureResult {
  fixture: BenchmarkFixture;
  raw: ArmResult;
  interp: ArmResult;
  delta: number;
  /**
   * Set when interpretation threw. The interpreted arm then injected the raw
   * payload, so its score says nothing about interpretation.
   */
  interpretError?: string;
}

export interface BenchmarkAggregate {
  winRate: number;
  meanLift: number;
  wins: number;
  ties: number;
  losses: number;
  /** Wilson 95% CI on wins / (wins + losses). */
  wilson95: [number, number];
  /** Estimated tokens in + out over every fixture (both arms, calibration included). */
  tokensRaw: number;
  tokensInterp: number;
  /** Ids of calibration fixtures whose arms did not tie. */
  calibrationFailures: string[];
  /** Fixtures whose interpretation threw (see `FixtureResult.interpretError`). */
  interpretFailures: number;
}

/**
 * Whether a run could support "interpreting a memory for the current context
 * beats injecting it raw". It does not say the claim is true: it says the run
 * was not structurally unable to show it.
 */
export interface BenchmarkGate {
  passed: boolean;
  /** Every condition that was not met (empty when `passed`). */
  reasons: string[];
}

export interface BenchmarkReport {
  runId: string;
  startedAt: number;
  finishedAt: number;
  judge: 'keyword' | 'lm';
  interpreterTier: InterpreterTier;
  /** 'echo' when the injected text was scored directly (no downstream answer). */
  answerer: 'echo' | 'custom';
  results: FixtureResult[];
  aggregate: BenchmarkAggregate;
  gate: BenchmarkGate;
}
