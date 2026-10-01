/**
 * CLI runner for the context-shift benchmark.
 *
 *   npm run benchmark              — offline: regex tier + KeywordJudge + echo
 *                                    answerer. A wiring smoke test: it cannot
 *                                    show that interpretation helps, and the
 *                                    gate always says so.
 *   npm run benchmark:live         — host tier + model answerer + LMJudge, all
 *                                    on SHORTHAND_BENCHMARK_MODEL (default
 *                                    DEFAULT_LIVE_MODEL), with no fallbacks.
 *
 * Flags: --out <file> writes the JSON report; --require-gate exits 1 unless
 * the gate passed. A live run also exits 1 when any interpretation failed.
 *
 * Live mode requires ANTHROPIC_API_KEY and a user-installed @anthropic-ai/sdk.
 * The SDK is dynamically imported; if it's not installed, the script exits
 * with a clear message rather than crashing.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ContextShiftBenchmark } from './context-shift-benchmark.js';
import { KeywordJudge } from './judges.js';
import { STARTER_FIXTURES } from './fixtures.js';
import { DEFAULT_LIVE_MODEL, LIVE_INTERPRET_OPTIONS, createLiveBenchmark } from './live.js';
import { RegexInterpreter } from '../interpreter/regex-interpreter.js';
import type { AnthropicLikeClient } from '../interpreter/host-interpreter.js';
import type { InterpreterLogger } from '../interpreter/types.js';
import type { BenchmarkReport } from './types.js';

interface CliArgs {
  live: boolean;
  requireGate: boolean;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { live: false, requireGate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--require-gate') args.requireGate = true;
    else if (a === '--out') args.out = argv[++i];
  }
  return args;
}

const stderrLogger: InterpreterLogger = {
  warn(event, meta) {
    console.error(`warn ${event} ${JSON.stringify(meta)}`);
  },
};

async function loadAnthropicClient(): Promise<AnthropicLikeClient> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  // Indirect string defeats static module resolution: @anthropic-ai/sdk is an
  // optional peer of this package, not a declared dependency.
  const moduleName = '@anthropic-ai/sdk';
  let mod: { default: new (opts: { apiKey: string }) => AnthropicLikeClient };
  try {
    mod = (await import(moduleName)) as unknown as typeof mod;
  } catch {
    throw new Error(
      '@anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk',
    );
  }
  return new mod.default({ apiKey });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let report: BenchmarkReport;
  let model: string | undefined;
  if (args.live) {
    const client = await loadAnthropicClient();
    model = process.env.SHORTHAND_BENCHMARK_MODEL || DEFAULT_LIVE_MODEL;
    report = await createLiveBenchmark({ client, model, logger: stderrLogger }).run(
      STARTER_FIXTURES,
      { interpretOpts: LIVE_INTERPRET_OPTIONS },
    );
  } else {
    report = await new ContextShiftBenchmark({
      interpreter: new RegexInterpreter(),
      judge: new KeywordJudge(),
    }).run(STARTER_FIXTURES);
  }

  printSummary(args.live ? 'live' : 'offline', model, report);

  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    const mode = args.live ? 'live' : 'offline';
    writeFileSync(args.out, JSON.stringify({ mode, model, ...report }, null, 2));
    console.log(`\nReport written to ${args.out}`);
  }

  if (args.live && report.aggregate.interpretFailures > 0) {
    console.error(
      `\nLive run invalid: ${report.aggregate.interpretFailures} interpretation(s) failed (see warnings above).`,
    );
    process.exitCode = 1;
  } else if (args.requireGate && !report.gate.passed) {
    process.exitCode = 1;
  }
}

function printSummary(
  mode: 'offline' | 'live',
  model: string | undefined,
  report: BenchmarkReport,
): void {
  const a = report.aggregate;
  const lines: string[] = [];
  lines.push(
    mode === 'offline'
      ? 'Context-Shift Benchmark — offline (wiring smoke test, not evidence for or against interpretation)'
      : 'Context-Shift Benchmark — live',
  );
  lines.push(`runId: ${report.runId}`);
  lines.push(
    `tier: ${report.interpreterTier}    judge: ${report.judge}    answerer: ${report.answerer}` +
      (model ? `    model: ${model}` : ''),
  );
  lines.push(`fixtures: ${report.results.length}`);
  lines.push('');
  lines.push('Per-fixture:');
  for (const r of report.results) {
    const flag =
      (r.fixture.expectRawWins ? ' [calibration]' : '') +
      (r.interpretError !== undefined ? ' [interpretation failed]' : '');
    lines.push(
      `  ${r.fixture.id.padEnd(28)} raw=${r.raw.score.toFixed(3)}  ` +
        `interp=${r.interp.score.toFixed(3)}  Δ=${signed(r.delta)}${flag}`,
    );
  }
  lines.push('');
  lines.push(
    `Aggregate (excluding calibration): wins=${a.wins}  ties=${a.ties}  losses=${a.losses}`,
  );
  lines.push(
    `  winRate=${a.winRate.toFixed(3)}  meanLift=${signed(a.meanLift)}  ` +
      `Wilson95=[${a.wilson95[0].toFixed(3)}, ${a.wilson95[1].toFixed(3)}]`,
  );
  lines.push(`  tokens raw=${a.tokensRaw}  interp=${a.tokensInterp}`);
  lines.push('');
  lines.push(`Gate: ${report.gate.passed ? 'passed' : 'not met'}`);
  for (const reason of report.gate.reasons) lines.push(`  - ${reason}`);
  console.log(lines.join('\n'));
}

function signed(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(3);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
