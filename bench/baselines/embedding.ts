/**
 * Embedding-only baseline — nearest neighbor via cosine similarity.
 *
 * Uses the same LocalEmbedder as smallchat but ONLY does vector
 * similarity search with no selector matching, overload resolution,
 * arg-shape scoring, or provider bias.
 */

import { LocalEmbedder } from '../../src/embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../src/embedding/memory-vector-index.js';
import type { BenchTool, Runner, RunnerResult, ResolvedResult } from '../runners/types.js';

export class EmbeddingBaseline implements Runner {
  name = 'embedding-only';
  private tools: BenchTool[] = [];
  private embedder = new LocalEmbedder(384);
  private index = new MemoryVectorIndex();
  private toolById = new Map<string, BenchTool>();

  async init(tools: BenchTool[]): Promise<void> {
    this.tools = tools;

    for (const tool of tools) {
      this.toolById.set(tool.id, tool);
      // Embed the tool description as its vector
      const vector = await this.embedder.embed(tool.description);
      this.index.insert(tool.id, vector);
    }
  }

  async resolve(query: string): Promise<RunnerResult> {
    const start = performance.now();

    const queryVector = await this.embedder.embed(query);
    // Search with a low threshold to get all reasonable matches
    const matches = this.index.search(queryVector, 10, 0.0);

    const ranked: ResolvedResult[] = matches.map(m => ({
      toolId: m.id,
      score: 1 - m.distance,
      components: {
        semantic: 1 - m.distance,
      },
    }));

    const latencyMs = performance.now() - start;

    return {
      caseId: '',
      ranked,
      latencyMs,
    };
  }
}
