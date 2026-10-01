/**
 * SC-INF-23 — the benchmark's 'smallchat' runner must measure the real
 * dispatch pipeline (ToolRuntime.resolve over a compiled artifact), not a
 * bespoke scorer, and report what the runtime would do on its own.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BenchTool, BenchCase } from './runners/types.js';
import { runBenchmark } from './runners/index.js';
import { SmallchatRunner, offeredTools } from './runners/smallchat.js';
import { ToolRuntime } from '../src/runtime/runtime.js';

const benchDir = resolve(import.meta.dirname, '.');
const tools: BenchTool[] = JSON.parse(readFileSync(resolve(benchDir, 'tools.json'), 'utf-8'));
const dataset: BenchCase[] = JSON.parse(readFileSync(resolve(benchDir, 'dataset.json'), 'utf-8'));

describe('smallchat bench runner (SC-INF-23)', () => {
  let runner: SmallchatRunner;

  beforeAll(async () => {
    runner = new SmallchatRunner();
    await runner.init(tools);
  }, 60_000);

  it('is a ToolRuntime loaded from a compiled artifact of the bench catalog', () => {
    expect(runner.runtime).toBeInstanceOf(ToolRuntime);
    expect(runner.runtime!.toolIds()).toHaveLength(tools.length);
  });

  it('ranks and decides exactly as runtime.resolve() does', async () => {
    for (const c of dataset.slice(0, 25)) {
      const result = await runner.resolve(c.query);
      const resolution = await runner.runtime!.resolve(c.query);
      expect(result.outcome).toBe(resolution.outcome);
      expect(result.chosen ?? null).toBe(resolution.chosen ? runner.benchIdOf(resolution.chosen) : null);
      expect(result.ranked.map(r => r.toolId)).toEqual(offeredTools(resolution).map(x => runner.benchIdOf(x.toolId)));
      expect(result.proofDigest).toBe(resolution.proof.proofDigest);
    }
  });

  it('answers each case the same whatever cases came before (order and history)', async () => {
    const forward = new Map<string, string | undefined>();
    for (const c of dataset) forward.set(c.id, (await runner.resolve(c.query)).proofDigest);

    const fresh = new SmallchatRunner();
    await fresh.init(tools);
    for (const c of [...dataset].reverse()) {
      expect((await fresh.resolve(c.query)).proofDigest).toBe(forward.get(c.id));
    }
  }, 60_000);

  it('reports top-1 accuracy and the outcome rates of the runtime', async () => {
    const [metrics] = await runBenchmark(tools, dataset, [runner], { measureConsistency: false });
    const outcomes = metrics.outcomes!;
    expect(outcomes).toBeDefined();
    const total = outcomes.resolved + outcomes.needsDisambiguation + outcomes.unresolved + outcomes.throttled;
    expect(total).toBe(dataset.length);
    expect(outcomes.resolvedCorrect + outcomes.resolvedWrong).toBe(outcomes.resolved);
    expect(metrics.needsDisambiguationRate).toBeCloseTo(outcomes.needsDisambiguation / dataset.length, 10);
    expect(metrics.accuracyTop1).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
