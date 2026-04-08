import { describe, it, expect } from 'vitest';
import { lint, listLintRules } from './lint.js';
import type { KnowledgeBase, WikiPage, ExtractedClaim, ExtractedEntity, Contradiction } from './types.js';

function makeMinimalKB(overrides: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    schema: { name: 'test', domain: 'test', entityTypes: [], sources: [] },
    pages: new Map(),
    claims: new Map(),
    entities: new Map(),
    relationships: [],
    claimSelectors: new Map(),
    index: { categories: {}, pageCount: 0, claimCount: 0, lastRebuilt: '' },
    log: [],
    sources: new Map(),
    sourceCount: 0,
    claimCount: 0,
    mergedClaimCount: 0,
    entityCount: 0,
    pageCount: 0,
    contradictions: [],
    compiledAt: new Date().toISOString(),
    version: '0.1.0',
    ...overrides,
  };
}

function makePage(overrides: Partial<WikiPage> & { slug: string }): WikiPage {
  return {
    title: overrides.slug,
    content: '',
    pageType: 'entity',
    claimIds: [],
    entityIds: [],
    inboundLinks: [],
    outboundLinks: [],
    sourceIds: [],
    lastUpdated: new Date().toISOString(),
    tokenCount: 0,
    ...overrides,
  };
}

describe('lint', () => {
  it('returns passing report for healthy KB', () => {
    const kb = makeMinimalKB();
    const report = lint(kb);
    expect(report.passed).toBe(true);
    expect(report.counts.error).toBe(0);
  });

  it('flags contradictions', () => {
    const contradictions: Contradiction[] = [{
      claimA: 'c1',
      claimB: 'c2',
      similarity: 0.92,
      reason: 'Test contradiction',
      severity: 'warning',
      entityIds: [],
    }];

    const claims = new Map<string, ExtractedClaim>();
    claims.set('c1', {
      id: 'c1', text: 'Gondor was founded in 3320 SA.',
      entities: [], sourceId: 'src-1', sourceSpan: [0, 30], confidence: 0.8,
    });
    claims.set('c2', {
      id: 'c2', text: 'Gondor was not founded in the Second Age.',
      entities: [], sourceId: 'src-2', sourceSpan: [0, 40], confidence: 0.8,
    });

    const kb = makeMinimalKB({ contradictions, claims });
    const report = lint(kb);

    expect(report.findings.some((f) => f.rule === 'contradictions')).toBe(true);
    expect(report.counts.warning).toBeGreaterThan(0);
  });

  it('flags critical contradictions as errors', () => {
    const contradictions: Contradiction[] = [{
      claimA: 'c1', claimB: 'c2', similarity: 0.98,
      reason: 'Critical', severity: 'critical', entityIds: [],
    }];

    const kb = makeMinimalKB({ contradictions });
    const report = lint(kb);

    expect(report.passed).toBe(false);
    expect(report.counts.error).toBe(1);
  });

  it('flags orphan pages', () => {
    const pages = new Map<string, WikiPage>();
    pages.set('gondor', makePage({
      slug: 'gondor',
      title: 'Gondor',
      inboundLinks: [],
      claimIds: ['c1'],
    }));

    const kb = makeMinimalKB({ pages });
    const report = lint(kb);

    expect(report.findings.some((f) => f.rule === 'orphan-pages')).toBe(true);
  });

  it('does not flag pages with inbound links as orphans', () => {
    const pages = new Map<string, WikiPage>();
    pages.set('gondor', makePage({
      slug: 'gondor',
      title: 'Gondor',
      inboundLinks: ['mordor'],
      claimIds: ['c1'],
    }));

    const kb = makeMinimalKB({ pages });
    const report = lint(kb);

    expect(report.findings.some((f) => f.rule === 'orphan-pages')).toBe(false);
  });

  it('flags empty pages', () => {
    const pages = new Map<string, WikiPage>();
    pages.set('empty', makePage({ slug: 'empty', title: 'Empty', claimIds: [] }));

    const kb = makeMinimalKB({ pages });
    const report = lint(kb);

    expect(report.findings.some((f) => f.rule === 'empty-pages')).toBe(true);
  });

  it('flags coverage gaps (entities with few claims)', () => {
    const entities = new Map<string, ExtractedEntity>();
    entities.set('gondor', {
      id: 'gondor', type: 'place', name: 'Gondor',
      sourceIds: ['src-1'], claimCount: 0,
    });

    const kb = makeMinimalKB({ entities });
    const report = lint(kb, { minClaimsPerEntity: 2 });

    expect(report.findings.some((f) => f.rule === 'coverage-gaps')).toBe(true);
  });

  it('flags stale sources', () => {
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
    const sources = new Map();
    sources.set('old-src', {
      id: 'old-src', type: 'text', path: '/old.txt',
      title: 'Old Source', lastIngested: oldDate,
    });

    const kb = makeMinimalKB({ sources });
    const report = lint(kb, { stalenessThresholdDays: 30 });

    expect(report.findings.some((f) => f.rule === 'stale-sources')).toBe(true);
  });

  it('respects disabled rules', () => {
    const contradictions: Contradiction[] = [{
      claimA: 'c1', claimB: 'c2', similarity: 0.92,
      reason: 'Test', severity: 'warning', entityIds: [],
    }];

    const pages = new Map<string, WikiPage>();
    pages.set('orphan', makePage({ slug: 'orphan', claimIds: ['c1'] }));

    const kb = makeMinimalKB({ contradictions, pages });
    const report = lint(kb, { disabled: ['contradictions', 'orphan-pages'] });

    expect(report.findings.some((f) => f.rule === 'contradictions')).toBe(false);
    expect(report.findings.some((f) => f.rule === 'orphan-pages')).toBe(false);
  });
});

describe('listLintRules', () => {
  it('returns all available rules with descriptions', () => {
    const rules = listLintRules();
    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(rules.every((r) => r.name.length > 0 && r.description.length > 0)).toBe(true);
  });

  it('includes known rules', () => {
    const ruleNames = listLintRules().map((r) => r.name);
    expect(ruleNames).toContain('contradictions');
    expect(ruleNames).toContain('orphan-pages');
    expect(ruleNames).toContain('stale-sources');
    expect(ruleNames).toContain('coverage-gaps');
    expect(ruleNames).toContain('empty-pages');
    expect(ruleNames).toContain('missing-cross-refs');
  });
});
