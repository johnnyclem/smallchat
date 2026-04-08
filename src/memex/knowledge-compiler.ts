/**
 * Knowledge Compiler — the main Memex compilation pipeline.
 *
 * Orchestrates: Read → Extract → Embed → Link → Emit
 *
 * Analogous to the ToolCompiler's Parse → Embed → Link pipeline,
 * but for knowledge sources instead of tool manifests.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type {
  KnowledgeBase,
  KnowledgeSchema,
  KnowledgeSource,
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelationship,
  ClaimSelector,
  Contradiction,
  IngestionLogEntry,
  IngestResult,
  MemexCompileResult,
  MemexConfig,
  WikiPage,
} from './types.js';
import type { Embedder, VectorIndex, SelectorMatch } from '../core/types.js';
import { discoverSources, readSources, readSource } from './source-reader.js';
import {
  extractKnowledgeBatch,
  extractKnowledge,
  mergeKnowledgeIRs,
  slugify,
} from './claim-extractor.js';
import {
  emitWikiPages,
  emitWikiIndex,
  renderIndexMarkdown,
  renderLogMarkdown,
} from './wiki-emitter.js';

// ---------------------------------------------------------------------------
// Artifact version
// ---------------------------------------------------------------------------

const ARTIFACT_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Main compilation pipeline
// ---------------------------------------------------------------------------

export interface CompileOptions {
  /** Knowledge schema governing this compilation. */
  schema: KnowledgeSchema;
  /** Embedder instance (ONNX or local). */
  embedder: Embedder;
  /** Vector index instance (memory or sqlite). */
  vectorIndex: VectorIndex;
  /** Additional source paths beyond schema.sources. */
  additionalSources?: string[];
  /** Project directory (default: cwd). */
  projectDir?: string;
  /** Dry run — compile but don't write artifact. */
  dryRun?: boolean;
  /** Output path override. */
  outputPath?: string;
}

/**
 * Compile knowledge sources into a KnowledgeBase artifact.
 *
 * Pipeline:
 *   1. READ   — discover and read source files
 *   2. EXTRACT — extract claims, entities, relationships
 *   3. EMBED  — vector-embed all claims for semantic access
 *   4. LINK   — cross-reference, detect contradictions, deduplicate
 *   5. EMIT   — generate wiki pages and index
 */
export async function compile(options: CompileOptions): Promise<MemexCompileResult> {
  const {
    schema,
    embedder,
    vectorIndex,
    additionalSources = [],
    projectDir = process.cwd(),
    dryRun = false,
    outputPath,
  } = options;

  const warnings: string[] = [];
  const now = new Date().toISOString();

  // -----------------------------------------------------------------------
  // Phase 1: READ
  // -----------------------------------------------------------------------
  const sources = discoverSources(schema, additionalSources, projectDir);
  if (sources.length === 0) {
    return {
      knowledgeBase: createEmptyKnowledgeBase(schema, now),
      artifactPath: null,
      report: 'No sources found.',
      warnings: ['No source files found in the configured paths.'],
    };
  }

  const contents = readSources(sources);

  // -----------------------------------------------------------------------
  // Phase 2: EXTRACT
  // -----------------------------------------------------------------------
  const irs = extractKnowledgeBatch(contents, schema);
  const merged = mergeKnowledgeIRs(irs);

  // Apply minimum confidence filter
  const minConfidence = schema.compiler?.minConfidence ?? 0.5;
  const filteredClaims = merged.claims.filter((c) => c.confidence >= minConfidence);

  if (filteredClaims.length === 0) {
    warnings.push('No claims met the minimum confidence threshold.');
  }

  // -----------------------------------------------------------------------
  // Phase 3: EMBED
  // -----------------------------------------------------------------------
  const claimTexts = filteredClaims.map((c) => c.text);
  const embeddings = await embedder.embedBatch(claimTexts);

  const claimSelectors = new Map<string, ClaimSelector>();
  for (let i = 0; i < filteredClaims.length; i++) {
    const claim = filteredClaims[i];
    const vector = embeddings[i];

    claimSelectors.set(claim.id, {
      vector,
      canonical: claim.text,
      entityIds: claim.entities.map(slugify),
      claimId: claim.id,
    });

    // Insert into vector index for search
    vectorIndex.insert(claim.id, vector);
  }

  // -----------------------------------------------------------------------
  // Phase 4: LINK
  // -----------------------------------------------------------------------

  // 4a: Deduplicate claims (merge near-duplicates)
  const dedupThreshold = schema.compiler?.deduplicationThreshold ?? 0.92;
  const { deduplicated, mergedCount } = deduplicateClaims(
    filteredClaims,
    claimSelectors,
    dedupThreshold,
  );

  if (mergedCount > 0) {
    warnings.push(`Deduplicated ${mergedCount} near-duplicate claims.`);
  }

  // 4b: Detect contradictions
  const contradictionThreshold = schema.compiler?.contradictionThreshold ?? 0.85;
  const contradictions = detectContradictions(
    deduplicated,
    claimSelectors,
    contradictionThreshold,
  );

  if (contradictions.length > 0) {
    warnings.push(`Detected ${contradictions.length} potential contradiction(s).`);
  }

  // -----------------------------------------------------------------------
  // Phase 5: EMIT
  // -----------------------------------------------------------------------
  const pages = emitWikiPages(deduplicated, merged.entities, merged.relationships, schema);
  const index = emitWikiIndex(pages, merged.entities, deduplicated.length);

  const logEntry: IngestionLogEntry = {
    timestamp: now,
    action: 'recompile',
    sourceId: '__all__',
    summary: `Full compilation: ${sources.length} sources → ${deduplicated.length} claims → ${pages.size} pages`,
    pagesAffected: Array.from(pages.keys()),
    claimsAdded: deduplicated.length,
    claimsRemoved: 0,
  };

  // -----------------------------------------------------------------------
  // Build the knowledge base
  // -----------------------------------------------------------------------
  const sourceMap = new Map<string, KnowledgeSource>();
  for (const s of sources) {
    sourceMap.set(s.id, { ...s, lastIngested: now });
  }

  const claimMap = new Map<string, ExtractedClaim>();
  for (const c of deduplicated) {
    claimMap.set(c.id, c);
  }

  const entityMap = new Map<string, ExtractedEntity>();
  for (const e of merged.entities) {
    entityMap.set(e.id, e);
  }

  const knowledgeBase: KnowledgeBase = {
    schema,
    pages,
    claims: claimMap,
    entities: entityMap,
    relationships: merged.relationships,
    claimSelectors,
    index,
    log: [logEntry],
    sources: sourceMap,
    sourceCount: sources.length,
    claimCount: deduplicated.length,
    mergedClaimCount: mergedCount,
    entityCount: merged.entities.length,
    pageCount: pages.size,
    contradictions,
    compiledAt: now,
    version: ARTIFACT_VERSION,
  };

  // -----------------------------------------------------------------------
  // Write artifact
  // -----------------------------------------------------------------------
  let artifactPath: string | null = null;

  if (!dryRun) {
    const outPath = outputPath ?? schema.output?.path ?? 'knowledge.memex.json';
    artifactPath = resolve(projectDir, outPath);
    const serialized = serializeKnowledgeBase(knowledgeBase);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(serialized, null, 2) + '\n');

    // Optionally export as markdown
    if (schema.output?.markdownDir) {
      exportMarkdown(knowledgeBase, resolve(projectDir, schema.output.markdownDir));
    }
  }

  // -----------------------------------------------------------------------
  // Build report
  // -----------------------------------------------------------------------
  const report = generateReport(knowledgeBase, warnings);

  return { knowledgeBase, artifactPath, report, warnings };
}

// ---------------------------------------------------------------------------
// Incremental ingestion
// ---------------------------------------------------------------------------

/**
 * Incrementally ingest a single new or updated source into an existing
 * knowledge base.
 */
export async function ingest(
  kb: KnowledgeBase,
  source: KnowledgeSource,
  embedder: Embedder,
  vectorIndex: VectorIndex,
): Promise<IngestResult> {
  const now = new Date().toISOString();

  // Read and extract from the new source
  const content = readSource(source);
  const ir = extractKnowledge(content, kb.schema);

  // Filter by minimum confidence
  const minConfidence = kb.schema.compiler?.minConfidence ?? 0.5;
  const newClaims = ir.claims.filter((c) => c.confidence >= minConfidence);

  // Remove old claims from this source
  const oldClaimIds: string[] = [];
  for (const [id, claim] of kb.claims) {
    if (claim.sourceId === source.id) {
      oldClaimIds.push(id);
    }
  }
  for (const id of oldClaimIds) {
    kb.claims.delete(id);
    kb.claimSelectors.delete(id);
    vectorIndex.remove(id);
  }

  // Embed and add new claims
  const embeddings = await embedder.embedBatch(newClaims.map((c) => c.text));
  for (let i = 0; i < newClaims.length; i++) {
    const claim = newClaims[i];
    const vector = embeddings[i];

    kb.claims.set(claim.id, claim);
    kb.claimSelectors.set(claim.id, {
      vector,
      canonical: claim.text,
      entityIds: claim.entities.map(slugify),
      claimId: claim.id,
    });
    vectorIndex.insert(claim.id, vector);
  }

  // Update entities
  for (const entity of ir.entities) {
    const existing = kb.entities.get(entity.id);
    if (existing) {
      existing.claimCount += entity.claimCount;
      for (const sid of entity.sourceIds) {
        if (!existing.sourceIds.includes(sid)) {
          existing.sourceIds.push(sid);
        }
      }
    } else {
      kb.entities.set(entity.id, entity);
    }
  }

  // Re-emit affected pages
  const allClaims = Array.from(kb.claims.values());
  const allEntities = Array.from(kb.entities.values());
  const pages = emitWikiPages(allClaims, allEntities, kb.relationships, kb.schema);

  // Determine affected pages
  const affectedSlugs = new Set<string>();
  for (const claim of newClaims) {
    for (const entityName of claim.entities) {
      affectedSlugs.add(slugify(entityName));
    }
  }
  for (const id of oldClaimIds) {
    // Find pages that had old claims
    for (const [slug, page] of kb.pages) {
      if (page.claimIds.includes(id)) {
        affectedSlugs.add(slug);
      }
    }
  }

  // Update knowledge base pages
  kb.pages = pages;
  kb.index = emitWikiIndex(pages, allEntities, allClaims.length);

  // Detect new contradictions
  const contradictionThreshold = kb.schema.compiler?.contradictionThreshold ?? 0.85;
  const newContradictions = detectContradictions(
    newClaims,
    kb.claimSelectors,
    contradictionThreshold,
  );

  // Update source
  kb.sources.set(source.id, { ...source, lastIngested: now });
  kb.claimCount = kb.claims.size;
  kb.entityCount = kb.entities.size;
  kb.pageCount = kb.pages.size;
  kb.sourceCount = kb.sources.size;

  // Log entry
  const logEntry: IngestionLogEntry = {
    timestamp: now,
    action: oldClaimIds.length > 0 ? 'update' : 'ingest',
    sourceId: source.id,
    summary: `${oldClaimIds.length > 0 ? 'Updated' : 'Ingested'}: +${newClaims.length} claims, -${oldClaimIds.length} old claims`,
    pagesAffected: Array.from(affectedSlugs),
    claimsAdded: newClaims.length,
    claimsRemoved: oldClaimIds.length,
  };
  kb.log.push(logEntry);

  return {
    source,
    claimsAdded: newClaims.length,
    claimsUpdated: 0,
    claimsRemoved: oldClaimIds.length,
    pagesAffected: Array.from(affectedSlugs),
    newContradictions,
    logEntry,
  };
}

// ---------------------------------------------------------------------------
// Claim deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate claims by cosine similarity.
 * Claims above the threshold are merged (first one kept, others dropped).
 */
function deduplicateClaims(
  claims: ExtractedClaim[],
  selectors: Map<string, ClaimSelector>,
  threshold: number,
): { deduplicated: ExtractedClaim[]; mergedCount: number } {
  const removed = new Set<string>();

  for (let i = 0; i < claims.length; i++) {
    if (removed.has(claims[i].id)) continue;

    const selectorA = selectors.get(claims[i].id);
    if (!selectorA) continue;

    for (let j = i + 1; j < claims.length; j++) {
      if (removed.has(claims[j].id)) continue;

      const selectorB = selectors.get(claims[j].id);
      if (!selectorB) continue;

      const similarity = cosineSimilarity(selectorA.vector, selectorB.vector);
      if (similarity >= threshold) {
        // Keep the claim with higher confidence
        if (claims[i].confidence >= claims[j].confidence) {
          removed.add(claims[j].id);
        } else {
          removed.add(claims[i].id);
          break; // claim i is removed, move on
        }
      }
    }
  }

  return {
    deduplicated: claims.filter((c) => !removed.has(c.id)),
    mergedCount: removed.size,
  };
}

// ---------------------------------------------------------------------------
// Contradiction detection
// ---------------------------------------------------------------------------

/**
 * Detect contradictions: claims that are semantically similar but from
 * different sources (suggesting conflicting information).
 *
 * Heuristic: high similarity + different sources + presence of negation
 * or opposing patterns.
 */
function detectContradictions(
  claims: ExtractedClaim[],
  selectors: Map<string, ClaimSelector>,
  threshold: number,
): Contradiction[] {
  const contradictions: Contradiction[] = [];

  for (let i = 0; i < claims.length; i++) {
    const selectorA = selectors.get(claims[i].id);
    if (!selectorA) continue;

    for (let j = i + 1; j < claims.length; j++) {
      // Only flag contradictions between different sources
      if (claims[i].sourceId === claims[j].sourceId) continue;

      const selectorB = selectors.get(claims[j].id);
      if (!selectorB) continue;

      const similarity = cosineSimilarity(selectorA.vector, selectorB.vector);
      if (similarity < threshold) continue;

      // Check for negation patterns
      if (hasContradictionSignal(claims[i].text, claims[j].text)) {
        const sharedEntities = claims[i].entities.filter((e) =>
          claims[j].entities.includes(e),
        );

        contradictions.push({
          claimA: claims[i].id,
          claimB: claims[j].id,
          similarity,
          reason: `High similarity (${(similarity * 100).toFixed(1)}%) between claims from different sources with potential contradictory signals.`,
          severity: similarity > 0.95 ? 'critical' : similarity > 0.9 ? 'warning' : 'info',
          entityIds: sharedEntities.map(slugify),
        });
      }
    }
  }

  return contradictions;
}

/**
 * Check if two similar claim texts contain contradictory signals.
 */
function hasContradictionSignal(textA: string, textB: string): boolean {
  const negationWords = /\b(?:not|no|never|neither|nor|wasn't|weren't|isn't|aren't|doesn't|don't|didn't|cannot|can't|won't|wouldn't|shouldn't|couldn't)\b/i;
  const aHasNegation = negationWords.test(textA);
  const bHasNegation = negationWords.test(textB);

  // One has negation, other doesn't → likely contradiction
  if (aHasNegation !== bHasNegation) return true;

  // Check for opposing numbers/dates in similar claims
  const numbersA = textA.match(/\b\d+\b/g) ?? [];
  const numbersB = textB.match(/\b\d+\b/g) ?? [];
  if (numbersA.length > 0 && numbersB.length > 0) {
    // If claims mention different numbers → potential contradiction
    const setA = new Set(numbersA);
    const setB = new Set(numbersB);
    const overlap = [...setA].filter((n) => setB.has(n)).length;
    if (overlap === 0 && setA.size > 0 && setB.size > 0) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Serialize a KnowledgeBase to a JSON-compatible object. */
export function serializeKnowledgeBase(kb: KnowledgeBase): Record<string, unknown> {
  return {
    version: kb.version,
    compiledAt: kb.compiledAt,
    schema: {
      name: kb.schema.name,
      domain: kb.schema.domain,
      entityTypes: kb.schema.entityTypes,
    },
    stats: {
      sourceCount: kb.sourceCount,
      claimCount: kb.claimCount,
      mergedClaimCount: kb.mergedClaimCount,
      entityCount: kb.entityCount,
      pageCount: kb.pageCount,
      contradictionCount: kb.contradictions.length,
    },
    sources: Object.fromEntries(kb.sources),
    claims: Object.fromEntries(kb.claims),
    entities: Object.fromEntries(kb.entities),
    relationships: kb.relationships,
    claimSelectors: serializeClaimSelectors(kb.claimSelectors),
    pages: serializePages(kb.pages),
    index: kb.index,
    log: kb.log,
    contradictions: kb.contradictions,
  };
}

/** Deserialize a KnowledgeBase from a JSON object. */
export function deserializeKnowledgeBase(
  data: Record<string, unknown>,
): KnowledgeBase {
  const raw = data as any;

  const sources = new Map<string, KnowledgeSource>(Object.entries(raw.sources ?? {}));
  const claims = new Map<string, ExtractedClaim>(Object.entries(raw.claims ?? {}));
  const entities = new Map<string, ExtractedEntity>(Object.entries(raw.entities ?? {}));
  const pages = deserializePages(raw.pages ?? {});
  const claimSelectors = deserializeClaimSelectors(raw.claimSelectors ?? {});

  return {
    schema: {
      name: raw.schema?.name ?? 'unknown',
      domain: raw.schema?.domain ?? 'general',
      entityTypes: raw.schema?.entityTypes ?? [],
      sources: [],
    },
    pages,
    claims,
    entities,
    relationships: raw.relationships ?? [],
    claimSelectors,
    index: raw.index ?? { categories: {}, pageCount: 0, claimCount: 0, lastRebuilt: '' },
    log: raw.log ?? [],
    sources,
    sourceCount: raw.stats?.sourceCount ?? sources.size,
    claimCount: raw.stats?.claimCount ?? claims.size,
    mergedClaimCount: raw.stats?.mergedClaimCount ?? 0,
    entityCount: raw.stats?.entityCount ?? entities.size,
    pageCount: raw.stats?.pageCount ?? pages.size,
    contradictions: raw.contradictions ?? [],
    compiledAt: raw.compiledAt ?? '',
    version: raw.version ?? '0.0.0',
  };
}

function serializeClaimSelectors(
  selectors: Map<string, ClaimSelector>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [id, sel] of selectors) {
    result[id] = {
      canonical: sel.canonical,
      entityIds: sel.entityIds,
      claimId: sel.claimId,
      vector: Array.from(sel.vector),
    };
  }
  return result;
}

function deserializeClaimSelectors(
  data: Record<string, any>,
): Map<string, ClaimSelector> {
  const map = new Map<string, ClaimSelector>();
  for (const [id, raw] of Object.entries(data)) {
    map.set(id, {
      canonical: raw.canonical,
      entityIds: raw.entityIds,
      claimId: raw.claimId,
      vector: new Float32Array(raw.vector),
    });
  }
  return map;
}

function serializePages(pages: Map<string, WikiPage>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [slug, page] of pages) {
    result[slug] = page;
  }
  return result;
}

function deserializePages(data: Record<string, any>): Map<string, any> {
  return new Map(Object.entries(data));
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

function exportMarkdown(kb: KnowledgeBase, outDir: string): void {
  mkdirSync(outDir, { recursive: true });

  // Write each page
  for (const [slug, page] of kb.pages) {
    const filePath = resolve(outDir, `${slug}.md`);
    writeFileSync(filePath, page.content + '\n');
  }

  // Write index
  const indexContent = renderIndexMarkdown(kb.index, kb.pages);
  writeFileSync(resolve(outDir, 'index.md'), indexContent + '\n');

  // Write log
  const logContent = renderLogMarkdown(kb.log);
  writeFileSync(resolve(outDir, 'log.md'), logContent + '\n');
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function generateReport(kb: KnowledgeBase, warnings: string[]): string {
  const lines: string[] = [];

  lines.push('Memex Compilation Report');
  lines.push('═══════════════════════');
  lines.push('');
  lines.push(`  Domain:         ${kb.schema.domain}`);
  lines.push(`  Sources:        ${kb.sourceCount}`);
  lines.push(`  Claims:         ${kb.claimCount}`);
  lines.push(`  Deduplicated:   ${kb.mergedClaimCount}`);
  lines.push(`  Entities:       ${kb.entityCount}`);
  lines.push(`  Relationships:  ${kb.relationships.length}`);
  lines.push(`  Wiki Pages:     ${kb.pageCount}`);
  lines.push(`  Contradictions: ${kb.contradictions.length}`);
  lines.push('');

  if (kb.contradictions.length > 0) {
    lines.push('Contradictions:');
    for (const c of kb.contradictions.slice(0, 5)) {
      lines.push(`  ⚠ ${c.severity}: ${c.reason}`);
    }
    if (kb.contradictions.length > 5) {
      lines.push(`  ... and ${kb.contradictions.length - 5} more`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  // Top entities by claim count
  const topEntities = Array.from(kb.entities.values())
    .sort((a, b) => b.claimCount - a.claimCount)
    .slice(0, 10);

  if (topEntities.length > 0) {
    lines.push('Top Entities:');
    for (const e of topEntities) {
      lines.push(`  ${e.name} (${e.type}) — ${e.claimCount} claims`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Empty knowledge base factory
// ---------------------------------------------------------------------------

function createEmptyKnowledgeBase(schema: KnowledgeSchema, now: string): KnowledgeBase {
  return {
    schema,
    pages: new Map(),
    claims: new Map(),
    entities: new Map(),
    relationships: [],
    claimSelectors: new Map(),
    index: { categories: {}, pageCount: 0, claimCount: 0, lastRebuilt: now },
    log: [],
    sources: new Map(),
    sourceCount: 0,
    claimCount: 0,
    mergedClaimCount: 0,
    entityCount: 0,
    pageCount: 0,
    contradictions: [],
    compiledAt: now,
    version: ARTIFACT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/** Compute cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
