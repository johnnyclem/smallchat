/**
 * Keyword matching baseline — naive string match.
 *
 * Scores tools by counting keyword overlaps between the query
 * and each tool's description, tags, provider name, and ID.
 */

import type { BenchTool, Runner, RunnerResult, ResolvedResult } from '../runners/types.js';

export class KeywordBaseline implements Runner {
  name = 'keyword';
  private tools: BenchTool[] = [];

  async init(tools: BenchTool[]): Promise<void> {
    this.tools = tools;
  }

  async resolve(query: string): Promise<RunnerResult> {
    const start = performance.now();
    const queryTokens = tokenize(query);

    const scored: ResolvedResult[] = this.tools.map(tool => {
      const descTokens = tokenize(tool.description);
      const tagTokens = tool.tags.map(t => t.toLowerCase());
      const providerTokens = tokenize(tool.provider);
      const idTokens = tool.id.toLowerCase().split('.').flatMap(p => p.split('_'));

      // Count overlaps
      let descHits = 0;
      let tagHits = 0;
      let providerHits = 0;
      let idHits = 0;

      for (const qt of queryTokens) {
        if (descTokens.includes(qt)) descHits++;
        if (tagTokens.includes(qt)) tagHits++;
        if (providerTokens.includes(qt)) providerHits++;
        if (idTokens.includes(qt)) idHits++;
      }

      const score =
        (descHits * 0.3) +
        (tagHits * 0.3) +
        (providerHits * 0.25) +
        (idHits * 0.15);

      // Normalize by query length to get 0-1 range
      const normalized = queryTokens.length > 0 ? score / queryTokens.length : 0;

      return {
        toolId: tool.id,
        score: normalized,
        components: {
          description: descHits,
          tags: tagHits,
          provider: providerHits,
          id: idHits,
        },
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const latencyMs = performance.now() - start;

    return {
      caseId: '',
      ranked: scored.filter(s => s.score > 0),
      latencyMs,
    };
  }
}

/** Tokenize into lowercase words, stripping punctuation and stopwords */
function tokenize(text: string): string[] {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'about', 'like', 'through', 'after', 'over', 'between',
    'out', 'against', 'during', 'without', 'before', 'under', 'around',
    'among', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
    'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', 'what',
    'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'and',
    'but', 'or', 'nor', 'not', 'so', 'very', 'just', 'than', 'too',
    'also', 'whats', "what's",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s+#@-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}
