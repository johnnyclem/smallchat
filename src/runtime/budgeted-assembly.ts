/**
 * Token-budgeted assembly of ranked tool descriptors.
 *
 * Inspired by loom-mcp's `loom_get_ranked_context`: instead of returning a
 * fixed top-K and letting the caller truncate, walk the ranked list and
 * include items until the next one would push past `tokenBudget`. The result
 * is a deterministic slice that fits.
 *
 * The assembler is decoupled from the candidate-producing path: smallchat's
 * existing `SelectorTable.resolve` + vector search produces the ranking; this
 * module just does budget-aware emission. That keeps it usable from the MCP
 * router (where we have a registered-tool list and a query string) and from
 * the runtime dispatch path (where we have already-ranked candidates).
 */

export interface ToolDescriptor {
  /** Stable identifier (e.g. "providerId.toolName"). */
  id: string;
  name: string;
  providerId: string;
  description: string;
  /** Tool input schema (kept opaque — only its serialized size matters here). */
  inputSchema: Record<string, unknown>;
  /** Optional ranking score (cosine similarity, BM25, etc.). Higher is better. */
  score?: number;
}

export interface BudgetedAssemblyResult {
  included: ToolDescriptor[];
  /** Items that did not fit, in original ranked order. */
  excluded: ToolDescriptor[];
  /** Estimated tokens consumed by `included`. */
  totalTokens: number;
  /** Original budget the caller requested. */
  tokenBudget: number;
  /** Why we stopped: budget hit, ranked list exhausted, or no candidates given. */
  exhausted: 'budget' | 'candidates' | 'empty';
}

/**
 * Cheap token estimator: 1 token ≈ 4 chars of English text. Counts the JSON
 * representation so input schemas and descriptions are both billed.
 *
 * For tighter accuracy a real BPE tokenizer can be passed via
 * `assembleWithinBudget`'s `estimate` parameter.
 */
export function estimateTokens(descriptor: ToolDescriptor): number {
  const serialized = JSON.stringify({
    id: descriptor.id,
    name: descriptor.name,
    providerId: descriptor.providerId,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  });
  return Math.ceil(serialized.length / 4);
}

/**
 * Assemble the longest prefix of `ranked` whose total estimated token count
 * does not exceed `tokenBudget`. Items are walked in the order given — if
 * the caller wants a different order, sort first.
 *
 * If a single item exceeds the budget, it is excluded; subsequent (smaller)
 * items can still be included. This is the loom-mcp behaviour and avoids the
 * pathological case where one giant tool starves out everything else.
 */
export function assembleWithinBudget(
  ranked: ToolDescriptor[],
  tokenBudget: number,
  estimate: (d: ToolDescriptor) => number = estimateTokens,
): BudgetedAssemblyResult {
  if (ranked.length === 0) {
    return {
      included: [],
      excluded: [],
      totalTokens: 0,
      tokenBudget,
      exhausted: 'empty',
    };
  }

  const included: ToolDescriptor[] = [];
  const excluded: ToolDescriptor[] = [];
  let totalTokens = 0;
  let budgetHit = false;

  for (const candidate of ranked) {
    const cost = estimate(candidate);
    if (totalTokens + cost <= tokenBudget) {
      included.push(candidate);
      totalTokens += cost;
    } else {
      excluded.push(candidate);
      budgetHit = true;
    }
  }

  return {
    included,
    excluded,
    totalTokens,
    tokenBudget,
    exhausted: budgetHit ? 'budget' : 'candidates',
  };
}

/**
 * BM25-flavoured text scorer. Used by the MCP router to rank registered tool
 * descriptors against a free-text query without having to plumb the
 * embedding pipeline through the server.
 *
 * This is intentionally simple — a real production path would feed the query
 * through smallchat's compiled `SelectorTable`. The scorer is sufficient for
 * the budgeted-assembly demo and keeps the router pure.
 */
export function scoreByQuery(
  descriptors: ToolDescriptor[],
  query: string,
): ToolDescriptor[] {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return descriptors.map((d) => ({ ...d, score: 0 }));
  }

  // Document frequency for IDF
  const docFreq = new Map<string, number>();
  const docTokens: string[][] = descriptors.map((d) => {
    const toks = tokenizeQuery(`${d.name} ${d.description}`);
    const seen = new Set<string>();
    for (const t of toks) {
      if (!seen.has(t)) {
        seen.add(t);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
    return toks;
  });

  const N = descriptors.length;
  const avgdl =
    docTokens.reduce((sum, toks) => sum + toks.length, 0) / Math.max(N, 1);
  const k1 = 1.2;
  const b = 0.75;

  const scored: ToolDescriptor[] = descriptors.map((d, i) => {
    const toks = docTokens[i];
    const dl = toks.length;
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const n = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const norm = f * (k1 + 1);
      const denom = f + k1 * (1 - b + b * (dl / Math.max(avgdl, 1)));
      score += idf * (norm / denom);
    }
    return { ...d, score };
  });

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored;
}

function tokenizeQuery(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
