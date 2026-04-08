import { describe, it, expect } from 'vitest';
import {
  emitWikiPages,
  emitWikiIndex,
  renderIndexMarkdown,
  renderLogMarkdown,
  estimateTokens,
} from './wiki-emitter.js';
import type {
  ExtractedClaim,
  ExtractedEntity,
  ExtractedRelationship,
  KnowledgeSchema,
} from './types.js';

const TEST_SCHEMA: KnowledgeSchema = {
  name: 'test',
  domain: 'test',
  entityTypes: ['place', 'person', 'event'],
  sources: [],
};

function makeClaim(overrides: Partial<ExtractedClaim> & { id: string }): ExtractedClaim {
  return {
    text: 'A test claim.',
    entities: [],
    sourceId: 'src-1',
    sourceSpan: [0, 10],
    confidence: 0.8,
    ...overrides,
  };
}

describe('emitWikiPages', () => {
  it('generates entity pages from claims', () => {
    const claims: ExtractedClaim[] = [
      makeClaim({ id: 'c1', text: 'Gondor was a kingdom.', entities: ['Gondor'] }),
      makeClaim({ id: 'c2', text: 'Gondor had a great army.', entities: ['Gondor'] }),
    ];
    const entities: ExtractedEntity[] = [
      { id: 'gondor', type: 'place', name: 'Gondor', sourceIds: ['src-1'], claimCount: 2 },
    ];

    const pages = emitWikiPages(claims, entities, [], TEST_SCHEMA);

    expect(pages.has('gondor')).toBe(true);
    const page = pages.get('gondor')!;
    expect(page.title).toBe('Gondor');
    expect(page.pageType).toBe('entity');
    expect(page.claimIds.length).toBe(2);
    expect(page.content).toContain('# Gondor');
    expect(page.content).toContain('Gondor was a kingdom');
  });

  it('generates relationship sections in entity pages', () => {
    const claims: ExtractedClaim[] = [
      makeClaim({ id: 'c1', text: 'Gondor was great.', entities: ['Gondor'] }),
      makeClaim({ id: 'c2', text: 'Mordor was dark.', entities: ['Mordor'] }),
    ];
    const entities: ExtractedEntity[] = [
      { id: 'gondor', type: 'place', name: 'Gondor', sourceIds: ['src-1'], claimCount: 1 },
      { id: 'mordor', type: 'place', name: 'Mordor', sourceIds: ['src-1'], claimCount: 1 },
    ];
    const rels: ExtractedRelationship[] = [
      { from: 'gondor', to: 'mordor', relation: 'borders', establishedBy: 'c1' },
    ];

    const pages = emitWikiPages(claims, entities, rels, TEST_SCHEMA);
    const gondorPage = pages.get('gondor')!;
    expect(gondorPage.content).toContain('## Relationships');
    expect(gondorPage.content).toContain('borders');
    expect(gondorPage.outboundLinks).toContain('mordor');
  });

  it('populates inbound links', () => {
    const claims: ExtractedClaim[] = [
      makeClaim({ id: 'c1', text: 'Gondor was great.', entities: ['Gondor'] }),
      makeClaim({ id: 'c2', text: 'Mordor was dark.', entities: ['Mordor'] }),
    ];
    const entities: ExtractedEntity[] = [
      { id: 'gondor', type: 'place', name: 'Gondor', sourceIds: ['src-1'], claimCount: 1 },
      { id: 'mordor', type: 'place', name: 'Mordor', sourceIds: ['src-1'], claimCount: 1 },
    ];
    const rels: ExtractedRelationship[] = [
      { from: 'gondor', to: 'mordor', relation: 'borders', establishedBy: 'c1' },
    ];

    const pages = emitWikiPages(claims, entities, rels, TEST_SCHEMA);
    const mordorPage = pages.get('mordor')!;
    expect(mordorPage.inboundLinks).toContain('gondor');
  });

  it('generates topic pages for orphan claims', () => {
    const claims: ExtractedClaim[] = [
      makeClaim({ id: 'c1', text: 'A general fact about the world.', entities: [], section: 'General' }),
    ];

    const pages = emitWikiPages(claims, [], [], TEST_SCHEMA);
    expect(pages.size).toBeGreaterThan(0);
    const topicPage = Array.from(pages.values()).find((p) => p.pageType === 'topic');
    expect(topicPage).toBeDefined();
  });
});

describe('emitWikiIndex', () => {
  it('categorizes pages by entity type', () => {
    const pages = new Map<string, any>();
    pages.set('gondor', { slug: 'gondor', title: 'Gondor', pageType: 'entity', claimIds: ['c1'] });
    pages.set('aragorn', { slug: 'aragorn', title: 'Aragorn', pageType: 'entity', claimIds: ['c2'] });

    const entities: ExtractedEntity[] = [
      { id: 'gondor', type: 'place', name: 'Gondor', sourceIds: [], claimCount: 1 },
      { id: 'aragorn', type: 'person', name: 'Aragorn', sourceIds: [], claimCount: 1 },
    ];

    const index = emitWikiIndex(pages, entities, 5);

    expect(index.categories['place']).toContain('gondor');
    expect(index.categories['person']).toContain('aragorn');
    expect(index.pageCount).toBe(2);
    expect(index.claimCount).toBe(5);
  });
});

describe('renderIndexMarkdown', () => {
  it('produces markdown with categories', () => {
    const pages = new Map<string, any>();
    pages.set('gondor', { slug: 'gondor', title: 'Gondor', claimIds: ['c1', 'c2'] });

    const index = {
      categories: { place: ['gondor'] },
      pageCount: 1,
      claimCount: 2,
      lastRebuilt: '2026-01-01T00:00:00Z',
    };

    const md = renderIndexMarkdown(index, pages);
    expect(md).toContain('# Knowledge Base Index');
    expect(md).toContain('## Place');
    expect(md).toContain('[[Gondor]]');
    expect(md).toContain('2 claims');
  });
});

describe('renderLogMarkdown', () => {
  it('renders log entries as markdown', () => {
    const log = [
      { timestamp: '2026-01-01T00:00:00Z', action: 'ingest', sourceId: 'doc-1', summary: 'Ingested doc-1' },
      { timestamp: '2026-01-02T00:00:00Z', action: 'lint', sourceId: '__all__', summary: 'Ran lint' },
    ];

    const md = renderLogMarkdown(log);
    expect(md).toContain('# Ingestion Log');
    expect(md).toContain('[ingest]');
    expect(md).toContain('[lint]');
    expect(md).toContain('Ingested doc-1');
  });
});

describe('estimateTokens', () => {
  it('estimates approximately 4 chars per token', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
