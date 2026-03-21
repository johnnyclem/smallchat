/**
 * Benchmark runner — orchestrates all runners and baselines,
 * computes metrics, and outputs results.
 */

import type {
  BenchTool,
  BenchCase,
  Runner,
  CaseScore,
  MethodMetrics,
  Difficulty,
} from './types.js';

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreCase(
  benchCase: BenchCase,
  result: { ranked: Array<{ toolId: string; score: number; components?: Record<string, number> }>; latencyMs: number },
): CaseScore {
  const top1 = result.ranked[0]?.toolId ?? null;
  const top3 = result.ranked.slice(0, 3).map(r => r.toolId);

  // For cases with expected=null, any acceptable is a top1 hit
  const isTop1Hit = benchCase.expected
    ? top1 === benchCase.expected
    : benchCase.acceptable.includes(top1 ?? '');

  const isAcceptableHit = benchCase.expected
    ? top1 === benchCase.expected || benchCase.acceptable.includes(top1 ?? '')
    : benchCase.acceptable.includes(top1 ?? '');

  const isTop3Hit = benchCase.expected
    ? top3.includes(benchCase.expected) || top3.some(t => benchCase.acceptable.includes(t))
    : top3.some(t => benchCase.acceptable.includes(t));

  return {
    caseId: benchCase.id,
    difficulty: benchCase.difficulty,
    category: benchCase.category,
    top1Hit: isTop1Hit,
    acceptableHit: isAcceptableHit,
    top3Hit: isTop3Hit,
    latencyMs: result.latencyMs,
    components: result.ranked[0]?.components,
  };
}

function computeMetrics(method: string, scores: CaseScore[]): MethodMetrics {
  const total = scores.length;
  if (total === 0) {
    return {
      method,
      accuracyTop1: 0,
      accuracyTop3: 0,
      acceptableHitRate: 0,
      avgLatencyMs: 0,
      byDifficulty: {} as Record<Difficulty, { top1: number; acceptable: number; count: number }>,
      byCategory: {},
      cases: [],
    };
  }

  const top1Hits = scores.filter(s => s.top1Hit).length;
  const top3Hits = scores.filter(s => s.top3Hit).length;
  const acceptableHits = scores.filter(s => s.acceptableHit).length;
  const avgLatency = scores.reduce((sum, s) => sum + s.latencyMs, 0) / total;

  // By difficulty
  const byDifficulty: Record<string, { top1: number; acceptable: number; count: number }> = {};
  for (const diff of ['easy', 'medium', 'hard'] as Difficulty[]) {
    const subset = scores.filter(s => s.difficulty === diff);
    byDifficulty[diff] = {
      top1: subset.length > 0 ? subset.filter(s => s.top1Hit).length / subset.length : 0,
      acceptable: subset.length > 0 ? subset.filter(s => s.acceptableHit).length / subset.length : 0,
      count: subset.length,
    };
  }

  // By category
  const byCategory: Record<string, { top1: number; acceptable: number; count: number }> = {};
  const categories = [...new Set(scores.map(s => s.category))];
  for (const cat of categories) {
    const subset = scores.filter(s => s.category === cat);
    byCategory[cat] = {
      top1: subset.length > 0 ? subset.filter(s => s.top1Hit).length / subset.length : 0,
      acceptable: subset.length > 0 ? subset.filter(s => s.acceptableHit).length / subset.length : 0,
      count: subset.length,
    };
  }

  return {
    method,
    accuracyTop1: top1Hits / total,
    accuracyTop3: top3Hits / total,
    acceptableHitRate: acceptableHits / total,
    avgLatencyMs: avgLatency,
    byDifficulty: byDifficulty as Record<Difficulty, { top1: number; acceptable: number; count: number }>,
    byCategory,
    cases: scores,
  };
}

// ---------------------------------------------------------------------------
// Consistency scoring
// ---------------------------------------------------------------------------

async function measureConsistency(
  runner: Runner,
  cases: BenchCase[],
  runs: number = 10,
): Promise<number> {
  // Pick a subset of cases to test consistency
  const sample = cases.slice(0, Math.min(10, cases.length));
  let totalConsistent = 0;
  let totalChecks = 0;

  for (const benchCase of sample) {
    const results: string[] = [];
    for (let i = 0; i < runs; i++) {
      const result = await runner.resolve(benchCase.query);
      results.push(result.ranked[0]?.toolId ?? 'none');
    }

    // Consistency = fraction of runs that match the mode
    const mode = results.sort((a, b) =>
      results.filter(v => v === b).length - results.filter(v => v === a).length,
    )[0];
    const consistent = results.filter(r => r === mode).length;
    totalConsistent += consistent;
    totalChecks += runs;
  }

  return totalChecks > 0 ? totalConsistent / totalChecks : 0;
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  /** Number of consistency check runs per query (default: 10) */
  consistencyRuns?: number;
  /** Whether to measure consistency (slower, default: true) */
  measureConsistency?: boolean;
  /** Only run specific difficulty levels */
  difficulties?: Difficulty[];
  /** Only run specific categories */
  categories?: string[];
}

export async function runBenchmark(
  tools: BenchTool[],
  dataset: BenchCase[],
  runners: Runner[],
  options: BenchmarkOptions = {},
): Promise<MethodMetrics[]> {
  const {
    consistencyRuns = 10,
    measureConsistency: doConsistency = true,
    difficulties,
    categories,
  } = options;

  // Filter dataset if needed
  let cases = dataset;
  if (difficulties) {
    cases = cases.filter(c => difficulties.includes(c.difficulty));
  }
  if (categories) {
    cases = cases.filter(c => categories.includes(c.category));
  }

  const allMetrics: MethodMetrics[] = [];

  for (const runner of runners) {
    // Initialize
    await runner.init(tools);

    // Run all cases
    const scores: CaseScore[] = [];
    for (const benchCase of cases) {
      const result = await runner.resolve(benchCase.query);
      result.caseId = benchCase.id;
      scores.push(scoreCase(benchCase, result));
    }

    const metrics = computeMetrics(runner.name, scores);

    // Consistency check
    if (doConsistency) {
      metrics.consistencyScore = await measureConsistency(
        runner,
        cases,
        consistencyRuns,
      );
    }

    allMetrics.push(metrics);
  }

  return allMetrics;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatResults(metrics: MethodMetrics[]): string {
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push('╔══════════════════════════════════════════════════════════════════════════╗');
  lines.push('║                      SMALLCHAT BENCHMARK RESULTS                       ║');
  lines.push('╠══════════════════════════════════════════════════════════════════════════╣');
  lines.push('');

  // Summary table
  const header = padRow([
    'Method',
    'Top1',
    'Top3',
    'Acceptable',
    'Latency',
    'Consistency',
  ]);
  const separator = '-'.repeat(header.length);

  lines.push(header);
  lines.push(separator);

  for (const m of metrics) {
    lines.push(padRow([
      m.method,
      pct(m.accuracyTop1),
      pct(m.accuracyTop3),
      pct(m.acceptableHitRate),
      `${m.avgLatencyMs.toFixed(1)}ms`,
      m.consistencyScore !== undefined ? pct(m.consistencyScore) : 'n/a',
    ]));
  }

  lines.push('');

  // Per-difficulty breakdown
  lines.push('── By Difficulty ──');
  lines.push('');

  for (const m of metrics) {
    lines.push(`  ${m.method}:`);
    for (const diff of ['easy', 'medium', 'hard'] as const) {
      const d = m.byDifficulty[diff];
      if (d) {
        lines.push(`    ${diff.padEnd(8)} top1=${pct(d.top1).padEnd(6)} acceptable=${pct(d.acceptable).padEnd(6)} (n=${d.count})`);
      }
    }
  }

  lines.push('');

  // Per-category breakdown
  lines.push('── By Category ──');
  lines.push('');

  for (const m of metrics) {
    lines.push(`  ${m.method}:`);
    for (const [cat, d] of Object.entries(m.byCategory)) {
      lines.push(`    ${cat.padEnd(25)} top1=${pct(d.top1).padEnd(6)} acceptable=${pct(d.acceptable).padEnd(6)} (n=${d.count})`);
    }
  }

  lines.push('');

  // Failed cases detail
  lines.push('── Failed Cases (Top1 Miss) ──');
  lines.push('');

  for (const m of metrics) {
    const failures = m.cases.filter(c => !c.top1Hit);
    if (failures.length === 0) {
      lines.push(`  ${m.method}: no failures`);
    } else {
      lines.push(`  ${m.method}: ${failures.length} failures`);
      for (const f of failures) {
        lines.push(`    ✗ ${f.caseId} [${f.difficulty}/${f.category}]`);
        if (f.components) {
          const parts = Object.entries(f.components)
            .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`)
            .join(', ');
          lines.push(`      scores: ${parts}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('╚══════════════════════════════════════════════════════════════════════════╝');

  return lines.join('\n');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function padRow(cols: string[]): string {
  const widths = [20, 8, 8, 12, 10, 12];
  return cols.map((col, i) => col.padEnd(widths[i] ?? 10)).join('');
}

// ---------------------------------------------------------------------------
// Explainability output — per-case score decomposition
// ---------------------------------------------------------------------------

export interface ExplainedResult {
  caseId: string;
  query: string;
  selected: string | null;
  expected: string | null;
  acceptable: string[];
  score: number;
  components: Record<string, number>;
  hit: boolean;
}

export async function explainCase(
  runner: Runner,
  benchCase: BenchCase,
): Promise<ExplainedResult> {
  const result = await runner.resolve(benchCase.query);
  const top = result.ranked[0];

  const hit = benchCase.expected
    ? top?.toolId === benchCase.expected || benchCase.acceptable.includes(top?.toolId ?? '')
    : benchCase.acceptable.includes(top?.toolId ?? '');

  return {
    caseId: benchCase.id,
    query: benchCase.query,
    selected: top?.toolId ?? null,
    expected: benchCase.expected,
    acceptable: benchCase.acceptable,
    score: top?.score ?? 0,
    components: top?.components ?? {},
    hit,
  };
}
