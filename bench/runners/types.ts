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
  /** Individual case scores */
  cases: CaseScore[];
}
