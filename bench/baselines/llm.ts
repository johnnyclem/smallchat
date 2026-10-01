/**
 * Simulated LLM tool selection baseline — no model is called.
 *
 * A stand-in for "dump the tool list into an LLM prompt and let it pick":
 * hash-embedding similarity plus provider/tag mention boosts plus random
 * noise scaled by a temperature. Its numbers say nothing about any real
 * LLM; it is reported as 'simulated-llm'. Its latency is the measured
 * compute time of the simulation (no network call is made or simulated).
 *
 * Replace the resolve() body with actual LLM calls when an API key is
 * available, and rename the runner accordingly.
 */

import { HashEmbedder } from '../../src/embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../../src/embedding/memory-vector-index.js';
import type { BenchTool, Runner, RunnerResult, ResolvedResult } from '../runners/types.js';

export class LLMBaseline implements Runner {
  name = 'simulated-llm';
  private tools: BenchTool[] = [];
  private embedder = new HashEmbedder(384);
  private index = new MemoryVectorIndex();
  private toolById = new Map<string, BenchTool>();
  /** Simulated temperature — adds controlled noise to simulate LLM non-determinism */
  private temperature: number;

  constructor(temperature = 0.1) {
    this.temperature = temperature;
  }

  async init(tools: BenchTool[]): Promise<void> {
    this.tools = tools;

    for (const tool of tools) {
      this.toolById.set(tool.id, tool);
      // Embed description + tags for richer context (LLM "sees" everything)
      const text = `${tool.description} ${tool.tags.join(' ')} ${tool.provider}`;
      const vector = await this.embedder.embed(text);
      this.index.insert(tool.id, vector);
    }
  }

  async resolve(query: string): Promise<RunnerResult> {
    const start = performance.now();

    const queryVector = await this.embedder.embed(query);
    const matches = this.index.search(queryVector, 10, 0.0);

    const ranked: ResolvedResult[] = matches.map(m => {
      const baseSimilarity = 1 - m.distance;
      const tool = this.toolById.get(m.id);

      // Simulate LLM "reading comprehension" — boost for provider mention
      let providerBoost = 0;
      if (tool) {
        const lowerQuery = query.toLowerCase();
        if (lowerQuery.includes(tool.provider.toLowerCase())) {
          providerBoost = 0.15;
        }
        // Check for tag mentions
        for (const tag of tool.tags) {
          if (lowerQuery.includes(tag.toLowerCase())) {
            providerBoost += 0.05;
          }
        }
      }

      // Add temperature noise (simulates LLM non-determinism)
      const noise = (Math.random() - 0.5) * this.temperature;

      const score = Math.min(1, Math.max(0, baseSimilarity + providerBoost + noise));

      return {
        toolId: m.id,
        score,
        components: {
          semantic: baseSimilarity,
          provider_boost: providerBoost,
          noise,
        },
      };
    });

    ranked.sort((a, b) => b.score - a.score);
    const latencyMs = performance.now() - start;

    return {
      caseId: '',
      ranked,
      latencyMs,
    };
  }
}
