#!/usr/bin/env tsx
/**
 * CLI benchmark runner.
 *
 * Usage:
 *   npx tsx bench/run.ts
 *   npx tsx bench/run.ts --consistency
 *   npx tsx bench/run.ts --difficulty hard
 *   npx tsx bench/run.ts --explain weather_simple
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BenchTool, BenchCase, Difficulty } from './runners/types.js';
import { runBenchmark, formatResults, explainCase } from './runners/index.js';
import { KeywordBaseline } from './baselines/keyword.js';
import { EmbeddingBaseline } from './baselines/embedding.js';
import { LLMBaseline } from './baselines/llm.js';
import { SmallchatRunner } from './runners/smallchat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const doConsistency = args.includes('--consistency');
  const explainId = args.find((_, i) => args[i - 1] === '--explain');
  const difficultyArg = args.find((_, i) => args[i - 1] === '--difficulty') as Difficulty | undefined;

  // Load data
  const tools: BenchTool[] = JSON.parse(readFileSync(resolve(__dirname, 'tools.json'), 'utf-8'));
  const dataset: BenchCase[] = JSON.parse(readFileSync(resolve(__dirname, 'dataset.json'), 'utf-8'));

  console.log(`Loaded ${tools.length} tools, ${dataset.length} test cases`);

  // Explain mode
  if (explainId) {
    const benchCase = dataset.find(c => c.id === explainId);
    if (!benchCase) {
      console.error(`Case "${explainId}" not found`);
      process.exit(1);
    }

    console.log(`\nExplaining: "${benchCase.query}"\n`);

    const runners = [
      new KeywordBaseline(),
      new EmbeddingBaseline(),
      new LLMBaseline(0),
      new SmallchatRunner(),
    ];

    for (const runner of runners) {
      await runner.init(tools);
      const explained = await explainCase(runner, benchCase);
      console.log(`  ${runner.name}:`);
      console.log(`    selected: ${explained.selected}`);
      console.log(`    score:    ${explained.score.toFixed(3)}`);
      console.log(`    hit:      ${explained.hit}`);
      if (Object.keys(explained.components).length > 0) {
        console.log(`    components:`);
        for (const [k, v] of Object.entries(explained.components)) {
          console.log(`      ${k}: ${typeof v === 'number' ? v.toFixed(3) : v}`);
        }
      }
      console.log('');
    }

    return;
  }

  // Full benchmark
  const runners = [
    new KeywordBaseline(),
    new EmbeddingBaseline(),
    new LLMBaseline(0.1),
    new SmallchatRunner(),
  ];

  const metrics = await runBenchmark(tools, dataset, runners, {
    measureConsistency: doConsistency,
    consistencyRuns: 10,
    difficulties: difficultyArg ? [difficultyArg] : undefined,
  });

  console.log(formatResults(metrics));

  // Exit with non-zero if smallchat didn't beat keyword
  const keyword = metrics.find(m => m.method === 'keyword')!;
  const smallchat = metrics.find(m => m.method === 'smallchat')!;
  if (smallchat.acceptableHitRate < keyword.acceptableHitRate) {
    console.error('\n⚠ smallchat did not outperform keyword baseline!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
