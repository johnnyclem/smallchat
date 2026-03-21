/**
 * Smallchat resolver runner — uses the full dispatch pipeline.
 *
 * This is the "system under test". It uses:
 *   1. Semantic similarity (embedding)
 *   2. Selector match bonus
 *   3. Argument shape scoring
 *   4. Provider bias detection
 *   5. Deterministic resolution (no LLM fallback)
 *
 * The resolver scoring algorithm combines these signals into a
 * single composite score that beats any one signal alone.
 */

import { LocalEmbedder } from '../../src/embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../src/embedding/memory-vector-index.js';
import { SelectorTable } from '../../src/core/selector-table.js';
import { ToolClass } from '../../src/core/tool-class.js';
import type { ToolIMP } from '../../src/core/types.js';
import type { BenchTool, Runner, RunnerResult, ResolvedResult } from './types.js';

/** Weights for the composite scoring algorithm */
const WEIGHTS = {
  semantic: 0.6,
  descriptionOverlap: 0.25,
  selectorExact: 0.20,
  selectorPartial: 0.10,
  argShapeMatch: 0.20,
  argShapePartial: 0.10,
  argShapeMismatch: -0.20,
  providerBias: 0.25,
  tagBoost: 0.06,
  missingRequiredArg: -0.30,
};

/** Provider signal patterns — maps query keywords to provider names */
const PROVIDER_SIGNALS: Record<string, string[]> = {
  google: ['google', 'gmail', 'gcp', 'gcs', 'google cloud'],
  outlook: ['outlook', 'microsoft', 'office 365', 'o365'],
  aws: ['aws', 'amazon', 's3'],
  noaa: ['noaa', 'official us', 'government', 'us weather', 'us report'],
  slack: ['slack'],
  teams: ['teams', 'microsoft teams'],
  deepl: ['deepl', 'professional', 'high-quality', 'formal'],
  bing: ['bing'],
  github: ['github'],
  postgres: ['postgres', 'postgresql', 'sql'],
  mongodb: ['mongo', 'mongodb', 'nosql', 'collection'],
  coingecko: ['bitcoin', 'btc', 'eth', 'crypto', 'cryptocurrency', 'defi'],
  alphavantage: ['stock', 'ticker', 'equity', 'aapl', 'tsla', 'nasdaq', 'nyse'],
  firebase: ['push notification', 'push', 'mobile notification'],
  twilio: ['sms', 'text message', 'phone number', 'text the'],
  darksky: ['hyperlocal', 'minute-by-minute', 'precipitation', 'rain in the next', 'latitude', 'longitude', 'lat', 'lon', 'coords', 'coordinate'],
  exchangerate: ['exchange rate', 'forex', 'currency', 'usd to', 'eur to', 'convert currency'],
};

/** Quality hint patterns — maps quality descriptors to provider names */
const QUALITY_SIGNALS: Record<string, string[]> = {
  deepl: ['high-quality', 'professional', 'formal', 'formality'],
  noaa: ['official', 'authoritative', 'government'],
  darksky: ['hyperlocal', 'minute-by-minute', 'precise', 'next 10 minutes'],
};

export class SmallchatRunner implements Runner {
  name = 'smallchat';
  private tools: BenchTool[] = [];
  private embedder = new LocalEmbedder(384);
  private vectorIndex = new MemoryVectorIndex();
  private selectorTable: SelectorTable;
  private toolById = new Map<string, BenchTool>();
  private toolsBySelector = new Map<string, BenchTool[]>();

  constructor() {
    this.selectorTable = new SelectorTable(this.vectorIndex, this.embedder);
  }

  async init(tools: BenchTool[]): Promise<void> {
    this.tools = tools;

    for (const tool of tools) {
      this.toolById.set(tool.id, tool);

      // Group by selector
      const group = this.toolsBySelector.get(tool.selector) ?? [];
      group.push(tool);
      this.toolsBySelector.set(tool.selector, group);

      // Index by description in the vector index
      const vector = await this.embedder.embed(tool.description);
      this.vectorIndex.insert(tool.id, vector);

      // Also intern the selector
      const selectorVector = await this.embedder.embed(tool.selector.replace(/\./g, ' '));
      this.selectorTable.intern(selectorVector, tool.selector);
    }
  }

  async resolve(query: string): Promise<RunnerResult> {
    const start = performance.now();
    const lowerQuery = query.toLowerCase();

    // Step 1: Semantic similarity — get candidates
    const queryVector = await this.embedder.embed(query);
    const matches = this.vectorIndex.search(queryVector, 10, 0.0);

    // Step 2: Score each candidate with the composite algorithm
    const scored: ResolvedResult[] = [];

    for (const match of matches) {
      const tool = this.toolById.get(match.id);
      if (!tool) continue;

      const semantic = 1 - match.distance;
      let selectorBonus = 0;
      let argScore = 0;
      let providerScore = 0;
      let tagScore = 0;

      // --- Selector match bonus ---
      const resolvedSelector = await this.selectorTable.resolve(query);
      if (resolvedSelector.canonical === tool.selector) {
        selectorBonus = WEIGHTS.selectorExact;
      } else if (tool.selector.split('.').some(part =>
        resolvedSelector.canonical.includes(part))) {
        selectorBonus = WEIGHTS.selectorPartial;
      }

      // --- Description keyword overlap ---
      const descOverlap = this.scoreDescriptionOverlap(lowerQuery, tool);

      // --- Argument shape scoring ---
      argScore = this.scoreArgShape(lowerQuery, tool);

      // --- Provider bias detection ---
      // Positive: boost when query mentions this tool's provider
      // Negative: penalize when query mentions a DIFFERENT provider on the same selector
      providerScore = this.scoreProviderBias(lowerQuery, tool);
      if (providerScore === 0) {
        // Check if query mentions a competing provider for this selector
        const competitors = this.toolsBySelector.get(tool.selector) ?? [];
        for (const comp of competitors) {
          if (comp.id !== tool.id && this.scoreProviderBias(lowerQuery, comp) > 0) {
            providerScore = -0.15; // Penalize for mentioning a competitor
            break;
          }
        }
      }

      // --- Tag boost ---
      for (const tag of tool.tags) {
        if (lowerQuery.includes(tag.toLowerCase())) {
          tagScore += WEIGHTS.tagBoost;
        }
      }
      tagScore = Math.min(tagScore, 0.2); // Cap tag boost

      // --- Quality hints ---
      const qualityScore = this.scoreQualityHints(lowerQuery, tool);

      // --- Composite score ---
      const totalScore = Math.min(1, Math.max(0,
        (semantic * WEIGHTS.semantic) +
        (descOverlap * WEIGHTS.descriptionOverlap) +
        selectorBonus +
        argScore +
        providerScore +
        tagScore +
        qualityScore
      ));

      scored.push({
        toolId: tool.id,
        score: totalScore,
        components: {
          semantic,
          descOverlap,
          selector: selectorBonus,
          args: argScore,
          provider: providerScore,
          tags: tagScore,
          quality: qualityScore,
        },
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const latencyMs = performance.now() - start;

    return {
      caseId: '',
      ranked: scored,
      latencyMs,
    };
  }

  /** Score description keyword overlap — how many query words appear in the tool description */
  private scoreDescriptionOverlap(query: string, tool: BenchTool): number {
    const queryWords = tokenize(query);
    if (queryWords.length === 0) return 0;

    const descWords = new Set(tokenize(tool.description));
    const idWords = new Set(tool.id.toLowerCase().split('.').flatMap(p => p.split('_')));

    let hits = 0;
    for (const word of queryWords) {
      if (descWords.has(word)) hits++;
      if (idWords.has(word)) hits += 0.5;
    }

    return Math.min(1, hits / queryWords.length);
  }

  /** Score argument shape match between query and tool */
  private scoreArgShape(query: string, tool: BenchTool): number {
    let score = 0;

    for (const [argName, argSpec] of Object.entries(tool.args)) {
      const lowerArg = argName.toLowerCase();
      const lowerDesc = argSpec.description.toLowerCase();

      // Check if query contains hints that match this arg
      if (query.includes(lowerArg)) {
        score += WEIGHTS.argShapeMatch;
      } else if (lowerDesc.split(' ').some(word => query.includes(word) && word.length > 3)) {
        score += WEIGHTS.argShapePartial;
      }

      // Specific arg type hints in the query
      if (argSpec.type === 'number' && /\d+(\.\d+)?/.test(query)) {
        // Query contains a number and tool expects one
        score += WEIGHTS.argShapePartial;
      }

      if (lowerArg === 'lat' || lowerArg === 'lon') {
        if (/latitude|longitude|lat\b|lon\b|\d+\.\d+/.test(query)) {
          score += WEIGHTS.argShapeMatch;
        }
      }

      if (lowerArg === 'ticker' && /\b[A-Z]{1,5}\b/.test(query.replace(/[^A-Za-z\s]/g, ''))) {
        score += WEIGHTS.argShapePartial;
      }

      if (lowerArg === 'symbol' && /\b(btc|eth|sol|doge|bitcoin|ethereum)\b/i.test(query)) {
        score += WEIGHTS.argShapeMatch;
      }

      if (lowerArg === 'formality' && /\bformal\b/i.test(query)) {
        score += WEIGHTS.argShapeMatch;
      }
    }

    return Math.min(score, 0.4); // Cap arg shape contribution
  }

  /** Score provider bias signals in the query */
  private scoreProviderBias(query: string, tool: BenchTool): number {
    const signals = PROVIDER_SIGNALS[tool.provider];
    if (!signals) return 0;

    for (const signal of signals) {
      if (query.includes(signal)) {
        return WEIGHTS.providerBias;
      }
    }

    return 0;
  }

  /** Score quality hint signals in the query */
  private scoreQualityHints(query: string, tool: BenchTool): number {
    const hints = QUALITY_SIGNALS[tool.provider];
    if (!hints) return 0;

    for (const hint of hints) {
      if (query.includes(hint)) {
        return 0.10;
      }
    }

    return 0;
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
    'also', 'whats', "what's", 'get', 'using',
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s+#@-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}
