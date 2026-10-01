#!/usr/bin/env tsx
/**
 * CLI benchmark runner.
 *
 * Usage:
 *   npx tsx bench/run.ts
 *   npx tsx bench/run.ts --consistency
 *   npx tsx bench/run.ts --difficulty hard
 *   npx tsx bench/run.ts --explain weather_simple
 *   npx tsx bench/run.ts --json
 *
 * The smallchat runner is the real runtime (runners/smallchat.ts); the
 * embedding-only baseline uses the same ONNX embedder. Exits 1 when the
 * smallchat runtime falls below the floors in bench/floors.json (the same
 * check `npm test` runs).
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
import { createEmbedder } from '../src/artifact/embedder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const doConsistency = args.includes('--consistency');
  const explainId = args.find((_, i) => args[i - 1] === '--explain');
  const difficultyArg = args.find((_, i) => args[i - 1] === '--difficulty') as Difficulty | undefined;
  const asJson = args.includes('--json');
  const embedder = await createEmbedder();

  // Load data
  const tools: BenchTool[] = JSON.parse(readFileSync(resolve(__dirname, 'tools.json'), 'utf-8'));
  const dataset: BenchCase[] = JSON.parse(readFileSync(resolve(__dirname, 'dataset.json'), 'utf-8'));

  if (!asJson) console.log(`Loaded ${tools.length} tools, ${dataset.length} test cases`);

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
      new EmbeddingBaseline(embedder),
      new LLMBaseline(0),
      new SmallchatRunner({ embedder }),
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
    new EmbeddingBaseline(embedder),
    new LLMBaseline(0.1),
    new SmallchatRunner({ embedder }),
  ];

  const metrics = await runBenchmark(tools, dataset, runners, {
    measureConsistency: doConsistency,
    consistencyRuns: 10,
    difficulties: difficultyArg ? [difficultyArg] : undefined,
  });

  if (asJson) {
    console.log(JSON.stringify(metrics.map(({ cases: _cases, ...summary }) => summary), null, 2));
  } else {
    console.log(formatResults(metrics));
  }

  // Regression gate: the runtime must not fall below its recorded floors.
  const floors = JSON.parse(readFileSync(resolve(__dirname, 'floors.json'), 'utf-8')) as {
    smallchat: { accuracyTop1: number; accuracyTop3: number; maxResolvedWrongRate: number };
  };
  const smallchat = metrics.find(m => m.method === 'smallchat')!;
  const failures: string[] = [];
  if (smallchat.accuracyTop1 < floors.smallchat.accuracyTop1) failures.push(`top-1 ${smallchat.accuracyTop1.toFixed(3)} < ${floors.smallchat.accuracyTop1}`);
  if (smallchat.accuracyTop3 < floors.smallchat.accuracyTop3) failures.push(`top-3 ${smallchat.accuracyTop3.toFixed(3)} < ${floors.smallchat.accuracyTop3}`);
  if ((smallchat.resolvedWrongRate ?? 0) > floors.smallchat.maxResolvedWrongRate) failures.push(`wrong-tool rate ${smallchat.resolvedWrongRate!.toFixed(3)} > ${floors.smallchat.maxResolvedWrongRate}`);
  if (failures.length > 0 && !difficultyArg) {
    console.error(`\nsmallchat regressed below bench/floors.json: ${failures.join('; ')}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
