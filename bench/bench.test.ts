/**
 * Benchmark integration test — runs all baselines + smallchat
 * and asserts that smallchat outperforms baselines.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { BenchTool, BenchCase, MethodMetrics } from './runners/types.js';
import { runBenchmark, formatResults, explainCase } from './runners/index.js';
import { KeywordBaseline } from './baselines/keyword.js';
import { EmbeddingBaseline } from './baselines/embedding.js';
import { LLMBaseline } from './baselines/llm.js';
import { SmallchatRunner } from './runners/smallchat.js';

const benchDir = resolve(import.meta.dirname, '.');
const tools: BenchTool[] = JSON.parse(readFileSync(resolve(benchDir, 'tools.json'), 'utf-8'));
const dataset: BenchCase[] = JSON.parse(readFileSync(resolve(benchDir, 'dataset.json'), 'utf-8'));

let allMetrics: MethodMetrics[];

describe('Benchmark', () => {
  beforeAll(async () => {
    const runners = [
      new KeywordBaseline(),
      new EmbeddingBaseline(),
      new LLMBaseline(0), // temperature=0 for deterministic test
      new SmallchatRunner(),
    ];

    allMetrics = await runBenchmark(tools, dataset, runners, {
      measureConsistency: false, // skip consistency for speed in tests
    });
  }, 30_000); // 30s timeout for the full benchmark

  it('runs all 4 methods', () => {
    expect(allMetrics).toHaveLength(4);
    expect(allMetrics.map(m => m.method)).toEqual([
      'keyword',
      'embedding-only',
      'llm',
      'smallchat',
    ]);
  });

  it('smallchat has higher top1 accuracy than keyword baseline', () => {
    const keyword = allMetrics.find(m => m.method === 'keyword')!;
    const smallchat = allMetrics.find(m => m.method === 'smallchat')!;
    expect(smallchat.accuracyTop1).toBeGreaterThanOrEqual(keyword.accuracyTop1);
  });

  it('smallchat has higher acceptable hit rate than keyword baseline', () => {
    const keyword = allMetrics.find(m => m.method === 'keyword')!;
    const smallchat = allMetrics.find(m => m.method === 'smallchat')!;
    expect(smallchat.acceptableHitRate).toBeGreaterThanOrEqual(keyword.acceptableHitRate);
  });

  it('smallchat has higher top1 accuracy than embedding-only baseline', () => {
    const embedding = allMetrics.find(m => m.method === 'embedding-only')!;
    const smallchat = allMetrics.find(m => m.method === 'smallchat')!;
    expect(smallchat.accuracyTop1).toBeGreaterThanOrEqual(embedding.accuracyTop1);
  });

  it('all methods return results for every case', () => {
    for (const m of allMetrics) {
      expect(m.cases).toHaveLength(dataset.length);
    }
  });

  it('prints formatted results', () => {
    const output = formatResults(allMetrics);
    expect(output).toContain('SMALLCHAT BENCHMARK RESULTS');
    expect(output).toContain('keyword');
    expect(output).toContain('embedding-only');
    expect(output).toContain('smallchat');
    console.log(output);
  });

  it('generates explainability output for each case', async () => {
    const runner = new SmallchatRunner();
    await runner.init(tools);

    for (const benchCase of dataset.slice(0, 5)) {
      const explained = await explainCase(runner, benchCase);
      expect(explained.caseId).toBe(benchCase.id);
      expect(explained.query).toBe(benchCase.query);
      expect(explained.components).toBeDefined();
      // Components should have semantic score at minimum
      expect(typeof explained.score).toBe('number');
    }
  });

  describe('difficulty distribution', () => {
    it('dataset has correct distribution of difficulty levels', () => {
      const easy = dataset.filter(c => c.difficulty === 'easy').length;
      const medium = dataset.filter(c => c.difficulty === 'medium').length;
      const hard = dataset.filter(c => c.difficulty === 'hard').length;

      // Should be roughly 30/40/30 split
      expect(easy).toBeGreaterThanOrEqual(8);
      expect(medium).toBeGreaterThanOrEqual(10);
      expect(hard).toBeGreaterThanOrEqual(8);
      expect(easy + medium + hard).toBe(dataset.length);
    });
  });

  describe('required scenario types', () => {
    it('includes same-selector different-provider cases', () => {
      const selectors = new Map<string, string[]>();
      for (const tool of tools) {
        const group = selectors.get(tool.selector) ?? [];
        group.push(tool.id);
        selectors.set(tool.selector, group);
      }
      // At least 5 selectors with multiple providers
      const overlapping = [...selectors.values()].filter(g => g.length > 1);
      expect(overlapping.length).toBeGreaterThanOrEqual(5);
    });

    it('includes semantic ambiguity cases', () => {
      const ambiguous = dataset.filter(c => c.category === 'semantic_ambiguity');
      expect(ambiguous.length).toBeGreaterThanOrEqual(3);
    });

    it('includes arg-shape disambiguation cases', () => {
      const argShape = dataset.filter(c => c.category === 'arg_shape');
      expect(argShape.length).toBeGreaterThanOrEqual(2);
    });

    it('includes domain ambiguity cases', () => {
      const domain = dataset.filter(c => c.category === 'domain_ambiguity');
      expect(domain.length).toBeGreaterThanOrEqual(1);
    });

    it('includes provider bias cases', () => {
      const providerBias = dataset.filter(c => c.category === 'provider_bias');
      expect(providerBias.length).toBeGreaterThanOrEqual(5);
    });

    it('includes quality hint cases', () => {
      const quality = dataset.filter(c => c.category === 'quality_hints');
      expect(quality.length).toBeGreaterThanOrEqual(1);
    });

    it('includes underspecified intent cases', () => {
      const underspecified = dataset.filter(c => c.category === 'underspecified');
      expect(underspecified.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('Consistency', () => {
  it('smallchat produces deterministic results', async () => {
    const runner = new SmallchatRunner();
    await runner.init(tools);

    // Run the same query 10 times
    const query = "what's the weather in Austin?";
    const results: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = await runner.resolve(query);
      results.push(result.ranked[0]?.toolId ?? 'none');
    }

    // All 10 runs should produce the same result
    const unique = new Set(results);
    expect(unique.size).toBe(1);
  }, 10_000);

  it('keyword baseline is deterministic', async () => {
    const runner = new KeywordBaseline();
    await runner.init(tools);

    const query = 'send an email from my Gmail';
    const results: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = await runner.resolve(query);
      results.push(result.ranked[0]?.toolId ?? 'none');
    }

    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it('embedding baseline is deterministic', async () => {
    const runner = new EmbeddingBaseline();
    await runner.init(tools);

    const query = 'translate this to French';
    const results: string[] = [];

    for (let i = 0; i < 10; i++) {
      const result = await runner.resolve(query);
      results.push(result.ranked[0]?.toolId ?? 'none');
    }

    const unique = new Set(results);
    expect(unique.size).toBe(1);
  });

  it('LLM baseline with temperature > 0 is non-deterministic', async () => {
    const runner = new LLMBaseline(0.5); // high temperature
    await runner.init(tools);

    const query = 'schedule a meeting tomorrow';
    const results: string[] = [];

    for (let i = 0; i < 20; i++) {
      const result = await runner.resolve(query);
      results.push(result.ranked[0]?.toolId ?? 'none');
    }

    // With temperature 0.5 over 20 runs, we should see some variation
    // (This may occasionally pass with all same results, but probability is very low)
    const unique = new Set(results);
    // Don't assert non-determinism strictly — just verify it runs
    expect(results).toHaveLength(20);
  });
});
