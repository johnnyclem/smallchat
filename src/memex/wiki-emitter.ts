/**
 * Wiki Emitter — generates markdown wiki pages from compiled knowledge.
 *
 * Takes the merged IR (claims, entities, relationships) and produces
 * WikiPage objects organized by entity and topic. Also generates
 * the index page and ingestion log entries.
 */

import type {
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelationship,
  KnowledgeSchema,
  WikiPage,
  WikiIndex,
} from './types.js';
import { slugify } from './claim-extractor.js';

// ---------------------------------------------------------------------------
// Page generation
// ---------------------------------------------------------------------------

/**
 * Generate wiki pages from claims, entities, and relationships.
 */
export function emitWikiPages(
  claims: ExtractedClaim[],
  entities: ExtractedEntity[],
  relationships: ExtractedRelationship[],
  schema: KnowledgeSchema,
): Map<string, WikiPage> {
  const pages = new Map<string, WikiPage>();
  const now = new Date().toISOString();
  const maxClaims = schema.compiler?.maxClaimsPerPage ?? 50;

  // Build lookup maps
  const claimsByEntity = buildClaimsByEntity(claims);
  const relsByEntity = buildRelsByEntity(relationships);
  const entityById = new Map(entities.map((e) => [e.id, e]));

  // --- Entity pages ---
  for (const entity of entities) {
    const entityClaims = claimsByEntity.get(entity.id) ?? [];
    if (entityClaims.length === 0) continue;

    const displayClaims = entityClaims.slice(0, maxClaims);
    const entityRels = relsByEntity.get(entity.id) ?? [];
    const relatedEntityIds = new Set<string>();
    for (const rel of entityRels) {
      relatedEntityIds.add(rel.from === entity.id ? rel.to : rel.from);
    }

    const slug = entity.id;
    const content = renderEntityPage(entity, displayClaims, entityRels, entityById, schema);
    const sourceIds = [...new Set(displayClaims.map((c) => c.sourceId))];
    const outboundLinks = Array.from(relatedEntityIds);

    pages.set(slug, {
      slug,
      title: entity.name,
      content,
      pageType: 'entity',
      claimIds: displayClaims.map((c) => c.id),
      entityIds: [entity.id, ...outboundLinks],
      inboundLinks: [], // filled in link pass
      outboundLinks,
      sourceIds,
      lastUpdated: now,
      tokenCount: estimateTokens(content),
    });
  }

  // --- Topic pages (group unclaimed by section) ---
  const orphanClaims = claims.filter(
    (c) => c.entities.length === 0 || !entities.some((e) => c.entities.includes(e.name)),
  );
  const bySection = groupBySection(orphanClaims);

  for (const [section, sectionClaims] of bySection) {
    const slug = slugify(section);
    if (pages.has(slug)) continue; // avoid collision with entity pages

    const displayClaims = sectionClaims.slice(0, maxClaims);
    const content = renderTopicPage(section, displayClaims);
    const sourceIds = [...new Set(displayClaims.map((c) => c.sourceId))];

    pages.set(slug, {
      slug,
      title: section,
      content,
      pageType: 'topic',
      claimIds: displayClaims.map((c) => c.id),
      entityIds: [],
      inboundLinks: [],
      outboundLinks: [],
      sourceIds,
      lastUpdated: now,
      tokenCount: estimateTokens(content),
    });
  }

  // --- Populate inbound links ---
  for (const [slug, page] of pages) {
    for (const targetSlug of page.outboundLinks) {
      const target = pages.get(targetSlug);
      if (target && !target.inboundLinks.includes(slug)) {
        target.inboundLinks.push(slug);
      }
    }
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Index generation
// ---------------------------------------------------------------------------

/**
 * Generate the wiki index — a category-organized catalog of all pages.
 */
export function emitWikiIndex(
  pages: Map<string, WikiPage>,
  entities: ExtractedEntity[],
  totalClaimCount: number,
): WikiIndex {
  const categories: Record<string, string[]> = {};

  // Group entity pages by entity type
  for (const entity of entities) {
    const slug = entity.id;
    if (!pages.has(slug)) continue;

    const category = entity.type;
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(slug);
  }

  // Add topic pages under "topics"
  for (const [slug, page] of pages) {
    if (page.pageType === 'topic') {
      if (!categories['topics']) {
        categories['topics'] = [];
      }
      categories['topics'].push(slug);
    }
  }

  // Sort within each category
  for (const slugs of Object.values(categories)) {
    slugs.sort();
  }

  return {
    categories,
    pageCount: pages.size,
    claimCount: totalClaimCount,
    lastRebuilt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function renderEntityPage(
  entity: ExtractedEntity,
  claims: ExtractedClaim[],
  relationships: ExtractedRelationship[],
  entityById: Map<string, ExtractedEntity>,
  _schema: KnowledgeSchema,
): string {
  const lines: string[] = [];

  lines.push(`# ${entity.name}`);
  lines.push('');
  lines.push(`**Type:** ${entity.type}`);

  if (entity.properties && Object.keys(entity.properties).length > 0) {
    lines.push('');
    for (const [key, value] of Object.entries(entity.properties)) {
      lines.push(`**${key}:** ${value}`);
    }
  }

  lines.push('');
  lines.push(`*${claims.length} claim${claims.length !== 1 ? 's' : ''} from ${entity.sourceIds.length} source${entity.sourceIds.length !== 1 ? 's' : ''}*`);
  lines.push('');

  // Group claims by section
  const bySection = groupBySection(claims);

  for (const [section, sectionClaims] of bySection) {
    if (section !== '(intro)' && section !== '(document)') {
      lines.push(`## ${section}`);
      lines.push('');
    }

    for (const claim of sectionClaims) {
      lines.push(`- ${claim.text}`);
    }
    lines.push('');
  }

  // Relationships
  if (relationships.length > 0) {
    lines.push('## Relationships');
    lines.push('');

    for (const rel of relationships) {
      const otherId = rel.from === entity.id ? rel.to : rel.from;
      const other = entityById.get(otherId);
      const otherName = other?.name ?? otherId;
      const direction = rel.from === entity.id ? '→' : '←';

      lines.push(`- ${direction} **${rel.relation}** [[${otherName}]]`);
    }
    lines.push('');
  }

  // Sources
  const uniqueSources = [...new Set(claims.map((c) => c.sourceId))];
  lines.push('## Sources');
  lines.push('');
  for (const sid of uniqueSources) {
    lines.push(`- ${sid}`);
  }

  return lines.join('\n');
}

function renderTopicPage(
  title: string,
  claims: ExtractedClaim[],
): string {
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`*${claims.length} claim${claims.length !== 1 ? 's' : ''}*`);
  lines.push('');

  for (const claim of claims) {
    lines.push(`- ${claim.text}`);
  }
  lines.push('');

  const uniqueSources = [...new Set(claims.map((c) => c.sourceId))];
  lines.push('## Sources');
  lines.push('');
  for (const sid of uniqueSources) {
    lines.push(`- ${sid}`);
  }

  return lines.join('\n');
}

/**
 * Render the index page as markdown.
 */
export function renderIndexMarkdown(
  index: WikiIndex,
  pages: Map<string, WikiPage>,
): string {
  const lines: string[] = [];

  lines.push('# Knowledge Base Index');
  lines.push('');
  lines.push(`*${index.pageCount} pages, ${index.claimCount} claims*`);
  lines.push(`*Last rebuilt: ${index.lastRebuilt}*`);
  lines.push('');

  for (const [category, slugs] of Object.entries(index.categories)) {
    lines.push(`## ${capitalize(category)}`);
    lines.push('');

    for (const slug of slugs) {
      const page = pages.get(slug);
      if (page) {
        lines.push(`- [[${page.title}]] — ${page.claimIds.length} claims`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Render the ingestion log as markdown.
 */
export function renderLogMarkdown(
  log: Array<{ timestamp: string; action: string; sourceId: string; summary: string }>,
): string {
  const lines: string[] = [];

  lines.push('# Ingestion Log');
  lines.push('');

  for (const entry of log) {
    lines.push(`- **${entry.timestamp}** [${entry.action}] ${entry.sourceId}: ${entry.summary}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildClaimsByEntity(claims: ExtractedClaim[]): Map<string, ExtractedClaim[]> {
  const map = new Map<string, ExtractedClaim[]>();
  for (const claim of claims) {
    for (const entityName of claim.entities) {
      const id = slugify(entityName);
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(claim);
    }
  }
  return map;
}

function buildRelsByEntity(rels: ExtractedRelationship[]): Map<string, ExtractedRelationship[]> {
  const map = new Map<string, ExtractedRelationship[]>();
  for (const rel of rels) {
    if (!map.has(rel.from)) map.set(rel.from, []);
    if (!map.has(rel.to)) map.set(rel.to, []);
    map.get(rel.from)!.push(rel);
    map.get(rel.to)!.push(rel);
  }
  return map;
}

function groupBySection(claims: ExtractedClaim[]): Map<string, ExtractedClaim[]> {
  const map = new Map<string, ExtractedClaim[]>();
  for (const claim of claims) {
    const section = claim.section ?? '(document)';
    if (!map.has(section)) map.set(section, []);
    map.get(section)!.push(claim);
  }
  return map;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}
