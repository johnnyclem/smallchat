/**
 * Embedding-only baseline — nearest neighbor via cosine similarity.
 *
 * Nearest tool description by cosine similarity, and nothing else: no
 * tiers, policy, verification or refusal. Pass the embedder the smallchat
 * runner uses (the harness passes ONNX) to compare like with like; the
 * default is the hash placeholder embedder.
 */

import type { Embedder } from '../../src/core/types.js';
import { HashEmbedder } from '../../src/embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../../src/embedding/memory-vector-index.js';
import type { BenchTool, Runner, RunnerResult, ResolvedResult } from '../runners/types.js';

export class EmbeddingBaseline implements Runner {
  name = 'embedding-only';
  private tools: BenchTool[] = [];
  private embedder: Embedder;
  private index = new MemoryVectorIndex();
  private toolById = new Map<string, BenchTool>();

  constructor(embedder: Embedder = new HashEmbedder(384)) {
    this.embedder = embedder;
  }

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
