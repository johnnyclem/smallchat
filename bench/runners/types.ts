/**
 * Benchmark types — shared across runners and baselines.
 */

// ---------------------------------------------------------------------------
// Tool catalog (tools.json)
// ---------------------------------------------------------------------------

export interface BenchToolArg {
  type: string;
  required: boolean;
  description: string;
}

export interface BenchTool {
  id: string;
  selector: string;
  description: string;
  provider: string;
  args: Record<string, BenchToolArg>;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Dataset (dataset.json)
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

export type Category =
  | 'basic_routing'
  | 'provider_bias'
  | 'semantic_ambiguity'
  | 'arg_shape'
  | 'domain_ambiguity'
  | 'quality_hints'
  | 'selector_disambiguation'
  | 'underspecified';

export interface BenchCase {
  id: string;
  query: string;
  /** Expected best tool ID — null means any acceptable is fine */
  expected: string | null;
  /** Tool IDs that are also valid answers */
  acceptable: string[];
  difficulty: Difficulty;
  category: Category;
}

// ---------------------------------------------------------------------------
// Runner interface — each baseline and smallchat implements this
// ---------------------------------------------------------------------------

export interface ResolvedResult {
  toolId: string;
  score: number;
  /** Breakdown of how the score was computed */
  components?: Record<string, number>;
}

export interface RunnerResult {
  caseId: string;
  /** Ranked list of candidates, best first */
  ranked: ResolvedResult[];
  latencyMs: number;
  /**
   * What the runner would do on its own, for runners that decide (the
   * smallchat runtime): 'resolved' runs `chosen`; the other outcomes run
   * nothing. Ranking-only baselines leave it unset.
   */
  outcome?: 'resolved' | 'needs-disambiguation' | 'unresolved' | 'throttled';
  /** The tool the runner would run (outcome 'resolved') */
  chosen?: string;
  /** Confidence tier of the chosen or best candidate */
  tier?: string;
  /** proofDigest of the runtime's resolution proof */
  proofDigest?: string;
}

export interface Runner {
  name: string;
  /** One-time setup (load tools, build indices, etc.) */
  init(tools: BenchTool[]): Promise<void>;
  /** Resolve a single query */
  resolve(query: string): Promise<RunnerResult>;
}

// ---------------------------------------------------------------------------
// Scoring / metrics
// ---------------------------------------------------------------------------

export interface CaseScore {
  caseId: string;
  difficulty: Difficulty;
  category: Category;
  /** Did top-1 match expected? */
  top1Hit: boolean;
  /** Did top-1 match expected OR acceptable? */
  acceptableHit: boolean;
  /** Did any of top-3 match expected or acceptable? */
  top3Hit: boolean;
  latencyMs: number;
  /** Score breakdown from the runner */
  components?: Record<string, number>;
  /** The runner's decision (deciding runners only) */
  outcome?: RunnerResult['outcome'];
  /** outcome 'resolved' and the chosen tool is expected or acceptable */
  resolvedCorrect?: boolean;
}

/** How often a deciding runner resolved, deferred or gave up. */
export interface OutcomeCounts {
  resolved: number;
  /** Resolved to the expected tool or an acceptable one */
  resolvedCorrect: number;
  /** Resolved to some other tool — it would have run the wrong tool */
  resolvedWrong: number;
  needsDisambiguation: number;
  unresolved: number;
  throttled: number;
}

export interface MethodMetrics {
  method: string;
  accuracyTop1: number;
  accuracyTop3: number;
  acceptableHitRate: number;
  avgLatencyMs: number;
  /** Per-difficulty accuracy */
  byDifficulty: Record<Difficulty, { top1: number; acceptable: number; count: number }>;
  /** Per-category accuracy */
  byCategory: Record<string, { top1: number; acceptable: number; count: number }>;
  /** Deterministic consistency score (run same query N times, measure stability) */
  consistencyScore?: number;
  /** Deciding runners only: outcome counts over the cases */
  outcomes?: OutcomeCounts;
  /** Deciding runners only: resolved to a correct tool / cases */
  resolvedCorrectRate?: number;
  /** Deciding runners only: resolved to a wrong tool / cases */
  resolvedWrongRate?: number;
  /** Deciding runners only: needs-disambiguation / cases */
  needsDisambiguationRate?: number;
  /** Deciding runners only: unresolved / cases */
  unresolvedRate?: number;
  /** Individual case scores */
  cases: CaseScore[];
}
