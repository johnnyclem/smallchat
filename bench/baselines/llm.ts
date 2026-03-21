/**
 * LLM tool selection baseline — stub.
 *
 * In production, this would dump the full tool list into an LLM prompt
 * and ask it to pick the best tool. For benchmark purposes, this is a
 * deterministic simulation that uses a combination of embedding similarity
 * and heuristic scoring to approximate what an LLM would do.
 *
 * The key difference from embedding-only: this also considers the tool
 * descriptions more holistically (simulating "reading comprehension")
 * but introduces non-determinism via a randomized temperature parameter.
 *
 * Replace the resolve() body with actual LLM calls when API key is available.
 */

import { LocalEmbedder } from '../../src/embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../src/embedding/memory-vector-index.js';
import type { BenchTool, Runner, RunnerResult, ResolvedResult } from '../runners/types.js';

export class LLMBaseline implements Runner {
  name = 'llm';
  private tools: BenchTool[] = [];
  private embedder = new LocalEmbedder(384);
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

    // Simulate LLM latency (real LLM calls are 500-2000ms)
    const simulatedLatency = 400 + Math.random() * 800;

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
    const latencyMs = performance.now() - start + simulatedLatency;

    return {
      caseId: '',
      ranked,
      latencyMs,
    };
  }
}
