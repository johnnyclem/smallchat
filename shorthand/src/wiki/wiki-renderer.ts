/**
 * WikiRenderer — materializes CompactedState as a set of interlinked markdown pages.
 *
 * Takes the LSM-tree's compacted knowledge and renders it as a Karpathy-style
 * wiki: entity pages, topic pages, an index, and an append-only log.
 *
 * Every name and text comes from conversations, tool output or ingested
 * documents, so all of it is untrusted: it goes through the package's one
 * escaping renderer (`escapeMarkdown` in compaction/frame.ts), so it can't
 * become a link, an image, raw HTML, a heading or a frozen truth marker.
 * Page paths are Unicode-aware slugs; names that slug alike (`C++`, `C#`)
 * get a short hash suffix, so no page overwrites another, and every link
 * is relative to the page it is on.
 */

import type {
  CompactedState,
  Entity,
  Edge,
  IngestionEvent,
  TopicSummary,
  WikiPage,
  WikiRenderConfig,
} from '../types.js';
import { DEFAULT_WIKI_RENDER_CONFIG } from '../types.js';
import { escapeMarkdown, markdownCodeSpan } from '../compaction/frame.js';
import { sha256Hex } from '../utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Untrusted text on one line of a page. */
function md(text: unknown): string {
  return escapeMarkdown(String(text), { inline: true });
}

/** A name's slug: NFKC, lowercased, runs of anything but letters, marks and digits as `-`. */
function baseSlug(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Unique, stable file slugs for a set of keys. A key whose slug no other
 * key shares keeps it; slugs that collide (or are empty) all get a short
 * hash of their key, so the result never depends on the order keys came in.
 */
class SlugIndex {
  private slugs = new Map<string, string>();

  constructor(items: Array<{ key: string; label: string }>, fallback: string) {
    const owners = new Map<string, Set<string>>();
    const base = new Map<string, string>();
    for (const { key, label } of items) {
      const slug = baseSlug(label);
      base.set(key, slug);
      owners.set(slug, (owners.get(slug) ?? new Set()).add(key));
    }
    for (let length = 8; ; length += 8) {
      const taken = new Map<string, number>();
      for (const [key, slug] of base) {
        const unique = slug && owners.get(slug)!.size === 1;
        const out = unique ? slug : `${slug || fallback}-${sha256Hex(key).slice(0, length)}`;
        this.slugs.set(key, out);
        taken.set(out, (taken.get(out) ?? 0) + 1);
      }
      if ([...taken.values()].every((n) => n === 1) || length >= 64) break;
    }
  }

  get(key: string): string {
    return this.slugs.get(key) ?? baseSlug(key);
  }
}

/** A wiki-internal markdown link; `target` is a path this renderer built from slugs. */
function wikiLink(target: string, label: string): string {
  return `[${md(label)}](${target})`;
}

/** Group entities by their type. */
function groupByType(entities: Entity[]): Map<string, Entity[]> {
  const groups = new Map<string, Entity[]>();
  for (const entity of entities) {
    const group = groups.get(entity.type) ?? [];
    group.push(entity);
    groups.set(entity.type, group);
  }
  return groups;
}

/** Find all edges where this entity is the source or target. */
function findRelatedEdges(entityName: string, edges: Edge[]): Edge[] {
  return edges.filter((e) => e.source === entityName || e.target === entityName);
}

/** Find topic summaries that reference an entity. */
function findTopicsForEntity(entityName: string, summaries: TopicSummary[]): TopicSummary[] {
  return summaries.filter(
    (s) =>
      s.entityNames.includes(entityName) ||
      s.summary.toLowerCase().includes(entityName.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// WikiRenderer
// ---------------------------------------------------------------------------

export class WikiRenderer {
  private config: WikiRenderConfig;
  private entitySlugs = new SlugIndex([], 'entity');
  private topicSlugs = new SlugIndex([], 'topic');

  constructor(config: Partial<WikiRenderConfig> = {}) {
    this.config = { ...DEFAULT_WIKI_RENDER_CONFIG, ...config };
  }

  /**
   * Render a complete wiki from compacted state.
   * Returns all pages — caller decides how to persist (fs, memory, etc.).
   */
  render(state: CompactedState, events?: IngestionEvent[]): WikiPage[] {
    const pages: WikiPage[] = [];

    // Every entity name a page or link can mention, and every summary
    const names = new Set(state.l3_graph.entities.keys());
    for (const edge of state.l3_graph.edges) names.add(edge.source).add(edge.target);
    for (const summary of state.l2_summaries) for (const name of summary.entityNames) names.add(name);
    this.entitySlugs = new SlugIndex([...names].map((name) => ({ key: name, label: name })), 'entity');
    this.topicSlugs = new SlugIndex(state.l2_summaries.map((s) => ({ key: s.id, label: s.topic })), 'topic');

    // Entity pages from L3 graph
    for (const [, entity] of state.l3_graph.entities) {
      pages.push(this.renderEntityPage(entity, state));
    }

    // Topic pages from L2 summaries
    for (const summary of state.l2_summaries) {
      pages.push(this.renderTopicPage(summary, state));
    }

    // Index page
    pages.push(this.renderIndexPage(state, pages));

    // Log page
    if (this.config.generateLog && events && events.length > 0) {
      pages.push(this.renderLogPage(events));
    }

    return pages;
  }

  // -----------------------------------------------------------------------
  // Entity pages
  // -----------------------------------------------------------------------

  private renderEntityPage(entity: Entity, state: CompactedState): WikiPage {
    const slug = this.entitySlugs.get(entity.name);
    const lines: string[] = [];

    lines.push(`# ${md(entity.name)}`);
    lines.push('');
    lines.push(`**Type:** ${md(entity.type)}`);
    lines.push('');

    // Properties
    const propEntries = Object.entries(entity.properties);
    if (propEntries.length > 0) {
      lines.push('## Properties');
      lines.push('');
      for (const [key, value] of propEntries) {
        lines.push(`- **${md(key)}:** ${md(value)}`);
      }
      lines.push('');
    }

    // Relationships (from edges)
    if (this.config.includeBacklinks) {
      const related = findRelatedEdges(entity.name, state.l3_graph.edges);
      if (related.length > 0) {
        lines.push('## Relationships');
        lines.push('');
        for (const edge of related) {
          const isSource = edge.source === entity.name;
          const otherName = isSource ? edge.target : edge.source;
          const direction = isSource ? '→' : '←';
          const linkedName = wikiLink(`${this.entitySlugs.get(otherName)}.md`, otherName);
          lines.push(`- ${direction} **${md(edge.relation)}** ${linkedName}`);
          if (edge.properties.reason) {
            lines.push(`  - _${md(edge.properties.reason)}_`);
          }
        }
        lines.push('');
      }

      // Backlinks from topic summaries
      const topics = findTopicsForEntity(entity.name, state.l2_summaries);
      if (topics.length > 0) {
        lines.push('## Referenced In');
        lines.push('');
        for (const topic of topics) {
          lines.push(`- ${wikiLink(`../topics/${this.topicSlugs.get(topic.id)}.md`, topic.topic)}`);
        }
        lines.push('');
      }
    }

    // Relevant invariants
    const relatedInvariants = state.l4_invariants.filter(
      (inv) =>
        inv.key.toLowerCase().includes(entity.name.toLowerCase()) ||
        inv.value.toLowerCase().includes(entity.name.toLowerCase()),
    );
    if (relatedInvariants.length > 0) {
      lines.push('## Invariants');
      lines.push('');
      for (const inv of relatedInvariants) {
        lines.push(`- **${md(inv.key)}:** ${md(inv.value)}`);
      }
      lines.push('');
    }

    // Corrections (tombstones)
    const relatedTombstones = state.tombstones.filter(
      (t) =>
        (t.key && t.key.toLowerCase().includes(entity.name.toLowerCase())) ||
        t.supersededContent.toLowerCase().includes(entity.name.toLowerCase()),
    );
    if (relatedTombstones.length > 0) {
      lines.push('## Corrections');
      lines.push('');
      for (const t of relatedTombstones) {
        lines.push(
          `- ~~${md(t.supersededContent)}~~ → ${t.correctedValue == null ? '(removed)' : md(t.correctedValue)} — _${md(t.reason)}_`,
        );
      }
      lines.push('');
    }

    return {
      path: `entities/${slug}.md`,
      content: lines.join('\n'),
      title: entity.name,
      category: 'entity',
    };
  }

  // -----------------------------------------------------------------------
  // Topic pages
  // -----------------------------------------------------------------------

  private renderTopicPage(summary: TopicSummary, state: CompactedState): WikiPage {
    const slug = this.topicSlugs.get(summary.id);
    const lines: string[] = [];

    lines.push(`# ${md(summary.topic)}`);
    lines.push('');
    lines.push(escapeMarkdown(summary.summary));
    lines.push('');

    // Decisions made in this topic
    if (summary.decisions.length > 0) {
      lines.push('## Decisions');
      lines.push('');
      for (const decision of summary.decisions) {
        const status = decision.superseded ? '~~' : '';
        lines.push(`- ${status}**${md(decision.chosen)}**${status}: ${md(decision.description)}`);
        for (const alt of decision.alternatives) {
          lines.push(`  - Rejected: ${md(alt.option)}${alt.reason ? ` — _${md(alt.reason)}_` : ''}`);
        }
      }
      lines.push('');
    }

    // Linked entities
    if (summary.entityNames.length > 0) {
      lines.push('## Related Entities');
      lines.push('');
      for (const name of summary.entityNames) {
        lines.push(`- ${wikiLink(`../entities/${this.entitySlugs.get(name)}.md`, name)}`);
      }
      lines.push('');
    }

    return {
      path: `topics/${slug}.md`,
      content: lines.join('\n'),
      title: summary.topic,
      category: 'topic',
    };
  }

  // -----------------------------------------------------------------------
  // Index page
  // -----------------------------------------------------------------------

  private renderIndexPage(state: CompactedState, pages: WikiPage[]): WikiPage {
    const lines: string[] = [];

    lines.push(`# ${md(this.config.wikiTitle)}`);
    lines.push('');
    lines.push('_Auto-generated knowledge base. Cross-references maintained by short-hand._');
    lines.push('');

    // Entity index grouped by type
    const entities = Array.from(state.l3_graph.entities.values());
    if (entities.length > 0) {
      lines.push('## Entities');
      lines.push('');
      const grouped = groupByType(entities);
      const sortedTypes = Array.from(grouped.keys()).sort();
      for (const type of sortedTypes) {
        const group = grouped.get(type)!;
        lines.push(`### ${md(type.charAt(0).toUpperCase() + type.slice(1))}`);
        lines.push('');
        for (const entity of group.sort((a, b) => a.name.localeCompare(b.name))) {
          const propSummary = Object.values(entity.properties).join(', ');
          const desc = propSummary ? ` — ${md(propSummary)}` : '';
          lines.push(`- ${wikiLink(`entities/${this.entitySlugs.get(entity.name)}.md`, entity.name)}${desc}`);
        }
        lines.push('');
      }
    }

    // Topic index
    const topicPages = pages.filter((p) => p.category === 'topic');
    if (topicPages.length > 0) {
      lines.push('## Topics');
      lines.push('');
      for (const page of topicPages) {
        lines.push(`- ${wikiLink(page.path, page.title)}`);
      }
      lines.push('');
    }

    // Invariants summary
    if (state.l4_invariants.length > 0) {
      lines.push('## Core Invariants');
      lines.push('');
      for (const inv of state.l4_invariants) {
        lines.push(`- **${md(inv.key)}:** ${md(inv.value)}`);
      }
      lines.push('');
    }

    // Stats
    lines.push('---');
    lines.push('');
    lines.push(
      `_${entities.length} entities · ${state.l2_summaries.length} topics · ${state.l4_invariants.length} invariants · ${state.tombstones.length} corrections_`,
    );
    lines.push('');

    return {
      path: 'index.md',
      content: lines.join('\n'),
      title: this.config.wikiTitle,
      category: 'index',
    };
  }

  // -----------------------------------------------------------------------
  // Log page
  // -----------------------------------------------------------------------

  private renderLogPage(events: IngestionEvent[]): WikiPage {
    const lines: string[] = [];

    lines.push('# Ingestion Log');
    lines.push('');
    lines.push('_Chronological record of source ingestions._');
    lines.push('');

    for (const event of events) {
      const date = new Date(event.timestamp).toISOString();
      lines.push(`## [INGEST] ${date}`);
      lines.push('');
      lines.push(`- **Source:** ${md(event.sourceTitle)} (${markdownCodeSpan(event.sourceId)})`);
      lines.push(`- **Chunks:** ${event.chunkCount}`);
      if (event.entitiesDiscovered.length > 0) {
        lines.push(`- **Entities discovered:** ${md(event.entitiesDiscovered.join(', '))}`);
      }
      lines.push('');
    }

    return {
      path: 'log.md',
      content: lines.join('\n'),
      title: 'Ingestion Log',
      category: 'log',
    };
  }
}
