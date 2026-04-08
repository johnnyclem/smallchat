/**
 * Knowledge Resolver — confidence-tiered query resolution against a knowledge base.
 *
 * Maps directly onto smallchat's dispatch model:
 *   EXACT  → Direct entity page match by name/slug
 *   HIGH   → Strong claim vector match, return page + highlight relevant claims
 *   MEDIUM → Moderate match, synthesize answer from multiple pages
 *   LOW    → Weak match, decompose into sub-queries
 *   NONE   → No match, suggest related pages (refinement)
 */

import type {
  KnowledgeBase,
  KnowledgeResult,
  KnowledgeConfidenceTier,
  WikiPage,
  ExtractedClaim,
} from './types.js';
import type { Embedder, VectorIndex, SelectorMatch } from '../core/types.js';
import { cosineSimilarity } from './knowledge-compiler.js';
import { slugify } from './claim-extractor.js';

// ---------------------------------------------------------------------------
// Tier thresholds
// ---------------------------------------------------------------------------

export interface KnowledgeTierThresholds {
  /** Minimum score for EXACT tier (default 0.95). */
  exact: number;
  /** Minimum score for HIGH tier (default 0.85). */
  high: number;
  /** Minimum score for MEDIUM tier (default 0.70). */
  medium: number;
  /** Minimum score for LOW tier (default 0.50). */
  low: number;
}

export const DEFAULT_KNOWLEDGE_THRESHOLDS: KnowledgeTierThresholds = {
  exact: 0.95,
  high: 0.85,
  medium: 0.70,
  low: 0.50,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolverOptions {
  /** Number of top claim matches to return. */
  topK?: number;
  /** Tier thresholds override. */
  thresholds?: Partial<KnowledgeTierThresholds>;
  /** Maximum related pages for LOW/NONE tiers. */
  maxRelatedPages?: number;
}

/**
 * Resolve a natural language query against a knowledge base.
 *
 * Uses the same confidence-tiered dispatch pattern as the tool runtime:
 * embed the query, search the claim index, and determine the response
 * strategy based on match quality.
 */
export async function resolve(
  query: string,
  kb: KnowledgeBase,
  embedder: Embedder,
  vectorIndex: VectorIndex,
  options: ResolverOptions = {},
): Promise<KnowledgeResult> {
  const topK = options.topK ?? 10;
  const maxRelated = options.maxRelatedPages ?? 5;
  const thresholds: KnowledgeTierThresholds = {
    ...DEFAULT_KNOWLEDGE_THRESHOLDS,
    ...options.thresholds,
  };

  // -----------------------------------------------------------------------
  // Fast path: exact entity/page match by name or slug
  // -----------------------------------------------------------------------
  const exactPage = findExactPage(query, kb);
  if (exactPage) {
    return {
      query,
      tier: 'EXACT',
      page: exactPage,
      matchedClaims: getPageClaims(exactPage, kb).map((c) => ({ claim: c, score: 1.0 })),
      relatedPages: getRelatedPages(exactPage, kb, maxRelated),
    };
  }

  // -----------------------------------------------------------------------
  // Semantic search: embed query and search claim index
  // -----------------------------------------------------------------------
  const queryVector = await embedder.embed(query);
  const matches: SelectorMatch[] = await vectorIndex.search(queryVector, topK, 0);

  if (matches.length === 0) {
    return buildNoneResult(query, kb, maxRelated);
  }

  // Score matches and determine tier
  const scoredClaims = scoreClaims(matches, kb);
  const bestScore = scoredClaims.length > 0 ? scoredClaims[0].score : 0;
  const tier = computeTier(bestScore, thresholds);

  // -----------------------------------------------------------------------
  // Build result based on tier
  // -----------------------------------------------------------------------
  switch (tier) {
    case 'EXACT':
    case 'HIGH': {
      const primaryClaim = scoredClaims[0];
      const page = findPageByClaim(primaryClaim.claim, kb);
      return {
        query,
        tier,
        page,
        matchedClaims: scoredClaims,
        relatedPages: page ? getRelatedPages(page, kb, maxRelated) : [],
      };
    }

    case 'MEDIUM': {
      // Synthesize from multiple matching claims
      const pages = new Set<string>();
      for (const { claim } of scoredClaims) {
        const page = findPageByClaim(claim, kb);
        if (page) pages.add(page.slug);
      }

      const synthesis = synthesizeAnswer(query, scoredClaims, kb);
      const primaryPage = scoredClaims.length > 0
        ? findPageByClaim(scoredClaims[0].claim, kb)
        : null;

      return {
        query,
        tier: 'MEDIUM',
        page: primaryPage,
        matchedClaims: scoredClaims,
        relatedPages: Array.from(pages)
          .filter((slug) => slug !== primaryPage?.slug)
          .map((slug) => {
            const p = kb.pages.get(slug)!;
            return { page: p, relevance: 0.5 };
          })
          .slice(0, maxRelated),
        synthesis,
      };
    }

    case 'LOW': {
      // Decompose into sub-queries
      const subQueries = decomposeQuery(query, scoredClaims, kb);
      return {
        query,
        tier: 'LOW',
        page: null,
        matchedClaims: scoredClaims,
        relatedPages: findRelatedPages(scoredClaims, kb, maxRelated),
        subQueries,
      };
    }

    case 'NONE':
    default:
      return buildNoneResult(query, kb, maxRelated);
  }
}

// ---------------------------------------------------------------------------
// Tier computation
// ---------------------------------------------------------------------------

/**
 * Compute the confidence tier from the best match score.
 */
export function computeTier(
  score: number,
  thresholds: KnowledgeTierThresholds,
): KnowledgeConfidenceTier {
  if (score >= thresholds.exact) return 'EXACT';
  if (score >= thresholds.high) return 'HIGH';
  if (score >= thresholds.medium) return 'MEDIUM';
  if (score >= thresholds.low) return 'LOW';
  return 'NONE';
}

// ---------------------------------------------------------------------------
// Exact page matching
// ---------------------------------------------------------------------------

/**
 * Try to find a page by exact entity name or slug match.
 */
function findExactPage(query: string, kb: KnowledgeBase): WikiPage | null {
  const querySlug = slugify(query);
  const queryLower = query.toLowerCase().trim();

  // Check by slug
  if (kb.pages.has(querySlug)) {
    return kb.pages.get(querySlug)!;
  }

  // Check by page title
  for (const page of kb.pages.values()) {
    if (page.title.toLowerCase() === queryLower) {
      return page;
    }
  }

  // Check by entity name
  for (const entity of kb.entities.values()) {
    if (entity.name.toLowerCase() === queryLower) {
      const page = kb.pages.get(entity.id);
      if (page) return page;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Claim scoring and page resolution
// ---------------------------------------------------------------------------

function scoreClaims(
  matches: SelectorMatch[],
  kb: KnowledgeBase,
): Array<{ claim: ExtractedClaim; score: number }> {
  const results: Array<{ claim: ExtractedClaim; score: number }> = [];

  for (const match of matches) {
    const claim = kb.claims.get(match.id);
    if (!claim) continue;

    // Convert distance to similarity score (1 - distance for cosine)
    const score = 1 - match.distance;
    results.push({ claim, score });
  }

  return results.sort((a, b) => b.score - a.score);
}

function findPageByClaim(claim: ExtractedClaim, kb: KnowledgeBase): WikiPage | null {
  for (const page of kb.pages.values()) {
    if (page.claimIds.includes(claim.id)) {
      return page;
    }
  }
  return null;
}

function getPageClaims(page: WikiPage, kb: KnowledgeBase): ExtractedClaim[] {
  return page.claimIds
    .map((id) => kb.claims.get(id))
    .filter((c): c is ExtractedClaim => c != null);
}

// ---------------------------------------------------------------------------
// Related pages
// ---------------------------------------------------------------------------

function getRelatedPages(
  page: WikiPage,
  kb: KnowledgeBase,
  maxCount: number,
): Array<{ page: WikiPage; relevance: number }> {
  const related: Array<{ page: WikiPage; relevance: number }> = [];

  // Include outbound linked pages
  for (const slug of page.outboundLinks) {
    const linkedPage = kb.pages.get(slug);
    if (linkedPage) {
      related.push({ page: linkedPage, relevance: 0.8 });
    }
  }

  // Include inbound linked pages
  for (const slug of page.inboundLinks) {
    const linkedPage = kb.pages.get(slug);
    if (linkedPage && !related.some((r) => r.page.slug === slug)) {
      related.push({ page: linkedPage, relevance: 0.6 });
    }
  }

  return related
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxCount);
}

function findRelatedPages(
  scoredClaims: Array<{ claim: ExtractedClaim; score: number }>,
  kb: KnowledgeBase,
  maxCount: number,
): Array<{ page: WikiPage; relevance: number }> {
  const pageSlugs = new Map<string, number>();

  for (const { claim, score } of scoredClaims) {
    for (const page of kb.pages.values()) {
      if (page.claimIds.includes(claim.id)) {
        const current = pageSlugs.get(page.slug) ?? 0;
        pageSlugs.set(page.slug, Math.max(current, score));
      }
    }
  }

  return Array.from(pageSlugs.entries())
    .map(([slug, relevance]) => ({ page: kb.pages.get(slug)!, relevance }))
    .filter((r) => r.page != null)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxCount);
}

// ---------------------------------------------------------------------------
// Synthesis (MEDIUM tier)
// ---------------------------------------------------------------------------

/**
 * Synthesize a textual answer from matching claims.
 * Returns a concatenation of the top claims, grouped by source.
 */
function synthesizeAnswer(
  _query: string,
  scoredClaims: Array<{ claim: ExtractedClaim; score: number }>,
  _kb: KnowledgeBase,
): string {
  if (scoredClaims.length === 0) return '';

  // Group claims by source
  const bySource = new Map<string, ExtractedClaim[]>();
  for (const { claim } of scoredClaims.slice(0, 5)) {
    if (!bySource.has(claim.sourceId)) bySource.set(claim.sourceId, []);
    bySource.get(claim.sourceId)!.push(claim);
  }

  const parts: string[] = [];
  for (const [sourceId, claims] of bySource) {
    parts.push(`From ${sourceId}:`);
    for (const claim of claims) {
      parts.push(`  - ${claim.text}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Decomposition (LOW tier)
// ---------------------------------------------------------------------------

/**
 * Decompose a complex query into sub-queries based on entity mentions.
 */
function decomposeQuery(
  query: string,
  scoredClaims: Array<{ claim: ExtractedClaim; score: number }>,
  kb: KnowledgeBase,
): string[] {
  const subQueries: string[] = [];

  // Extract entity names from partially matching claims
  const mentionedEntities = new Set<string>();
  for (const { claim } of scoredClaims) {
    for (const entityName of claim.entities) {
      mentionedEntities.add(entityName);
    }
  }

  // Generate sub-queries for each mentioned entity
  for (const entityName of mentionedEntities) {
    subQueries.push(`What is ${entityName}?`);
  }

  // If no entities found, suggest broadening the query
  if (subQueries.length === 0) {
    const words = query.split(/\s+/).filter((w) => w.length > 3);
    for (const word of words.slice(0, 3)) {
      subQueries.push(word);
    }
  }

  return subQueries.slice(0, 5);
}

// ---------------------------------------------------------------------------
// NONE result
// ---------------------------------------------------------------------------

function buildNoneResult(
  query: string,
  kb: KnowledgeBase,
  maxRelated: number,
): KnowledgeResult {
  // Suggest pages with matching entity types or names
  const queryWords = new Set(query.toLowerCase().split(/\s+/));
  const candidates: Array<{ page: WikiPage; relevance: number }> = [];

  for (const page of kb.pages.values()) {
    const titleWords = new Set(page.title.toLowerCase().split(/\s+/));
    const overlap = [...queryWords].filter((w) => titleWords.has(w)).length;
    if (overlap > 0) {
      candidates.push({ page, relevance: overlap / queryWords.size });
    }
  }

  return {
    query,
    tier: 'NONE',
    page: null,
    matchedClaims: [],
    relatedPages: candidates
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, maxRelated),
  };
}

// Public alias for the resolve function (avoids collision with built-in)
export { resolve as resolveQuery };
