/**
 * Knowledge Lint — health checks for a compiled knowledge base.
 *
 * Detects: contradictions, stale pages, orphan pages, missing cross-references,
 * coverage gaps, and duplicate claims. Analogous to `smallchat doctor` but
 * for knowledge bases instead of tool compilations.
 */

import type {
  KnowledgeBase,
  LintFinding,
  LintReport,
  LintSeverity,
  LintRuleConfig,
} from './types.js';

// ---------------------------------------------------------------------------
// Lint rules
// ---------------------------------------------------------------------------

type LintRule = (kb: KnowledgeBase, config: LintRuleConfig) => LintFinding[];

interface LintRuleEntry {
  name: string;
  description: string;
  run: LintRule;
}

const LINT_RULES: LintRuleEntry[] = [
  {
    name: 'contradictions',
    description: 'Claims that contradict each other across sources',
    run: lintContradictions,
  },
  {
    name: 'orphan-pages',
    description: 'Pages with no inbound links from other pages',
    run: lintOrphanPages,
  },
  {
    name: 'stale-sources',
    description: 'Sources that may be outdated based on ingestion date',
    run: lintStaleSources,
  },
  {
    name: 'coverage-gaps',
    description: 'Entities with very few claims',
    run: lintCoverageGaps,
  },
  {
    name: 'missing-cross-refs',
    description: 'Claims that mention entities without linking to their pages',
    run: lintMissingCrossRefs,
  },
  {
    name: 'empty-pages',
    description: 'Pages with no claims',
    run: lintEmptyPages,
  },
];

// ---------------------------------------------------------------------------
// Main lint function
// ---------------------------------------------------------------------------

/**
 * Run all lint rules against a knowledge base and produce a report.
 */
export function lint(
  kb: KnowledgeBase,
  config: LintRuleConfig = {},
): LintReport {
  const disabled = new Set(config.disabled ?? []);
  const findings: LintFinding[] = [];

  for (const rule of LINT_RULES) {
    if (disabled.has(rule.name)) continue;
    findings.push(...rule.run(kb, config));
  }

  const counts: Record<LintSeverity, number> = { info: 0, warning: 0, error: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }

  const passed = counts.error === 0;

  const summary = [
    `Lint: ${findings.length} finding(s)`,
    `  ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info`,
    passed ? '  Status: PASSED' : '  Status: FAILED',
  ].join('\n');

  return {
    findings,
    counts,
    passed,
    checkedAt: new Date().toISOString(),
    summary,
  };
}

/**
 * Get the list of available lint rule names.
 */
export function listLintRules(): Array<{ name: string; description: string }> {
  return LINT_RULES.map((r) => ({ name: r.name, description: r.description }));
}

// ---------------------------------------------------------------------------
// Individual lint rules
// ---------------------------------------------------------------------------

/**
 * CONTRADICTIONS: flag claims that were marked as contradictory during compilation.
 */
function lintContradictions(kb: KnowledgeBase, _config: LintRuleConfig): LintFinding[] {
  return kb.contradictions.map((c) => {
    const claimA = kb.claims.get(c.claimA);
    const claimB = kb.claims.get(c.claimB);

    return {
      rule: 'contradictions',
      severity: c.severity === 'critical' ? 'error' : c.severity as LintSeverity,
      message: `Contradictory claims (${(c.similarity * 100).toFixed(1)}% similarity): "${claimA?.text?.slice(0, 80) ?? c.claimA}..." vs "${claimB?.text?.slice(0, 80) ?? c.claimB}..."`,
      pages: [],
      claims: [c.claimA, c.claimB],
      entities: c.entityIds,
      suggestion: 'Review these claims and resolve the contradiction by updating the source documents.',
    };
  });
}

/**
 * ORPHAN PAGES: pages with no inbound links from other pages.
 * The index page is exempt.
 */
function lintOrphanPages(kb: KnowledgeBase, _config: LintRuleConfig): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const [slug, page] of kb.pages) {
    if (page.pageType === 'index' || page.pageType === 'log') continue;
    if (page.inboundLinks.length === 0) {
      findings.push({
        rule: 'orphan-pages',
        severity: 'info',
        message: `Page "${page.title}" has no inbound links from other pages.`,
        pages: [slug],
        claims: [],
        entities: page.entityIds,
        suggestion: `Add cross-references to "${page.title}" from related pages.`,
      });
    }
  }

  return findings;
}

/**
 * STALE SOURCES: sources whose lastIngested date is older than the threshold.
 */
function lintStaleSources(kb: KnowledgeBase, config: LintRuleConfig): LintFinding[] {
  const findings: LintFinding[] = [];
  const thresholdDays = config.stalenessThresholdDays ?? 30;
  const now = Date.now();
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;

  for (const [id, source] of kb.sources) {
    if (!source.lastIngested) continue;
    const ingestedAt = new Date(source.lastIngested).getTime();
    const age = now - ingestedAt;

    if (age > thresholdMs) {
      const daysSince = Math.floor(age / (24 * 60 * 60 * 1000));
      findings.push({
        rule: 'stale-sources',
        severity: 'warning',
        message: `Source "${source.title ?? id}" was last ingested ${daysSince} days ago (threshold: ${thresholdDays} days).`,
        pages: [],
        claims: [],
        entities: [],
        suggestion: `Re-ingest source "${source.title ?? id}" to ensure claims are current.`,
      });
    }
  }

  return findings;
}

/**
 * COVERAGE GAPS: entities that have very few claims backing them.
 */
function lintCoverageGaps(kb: KnowledgeBase, config: LintRuleConfig): LintFinding[] {
  const findings: LintFinding[] = [];
  const minClaims = config.minClaimsPerEntity ?? 1;

  for (const [id, entity] of kb.entities) {
    if (entity.claimCount < minClaims) {
      findings.push({
        rule: 'coverage-gaps',
        severity: 'info',
        message: `Entity "${entity.name}" has only ${entity.claimCount} claim(s) (minimum: ${minClaims}).`,
        pages: kb.pages.has(id) ? [id] : [],
        claims: [],
        entities: [id],
        suggestion: `Add more source material about "${entity.name}" to improve coverage.`,
      });
    }
  }

  return findings;
}

/**
 * MISSING CROSS-REFS: claims that mention known entity names but whose
 * pages don't link to those entity pages.
 */
function lintMissingCrossRefs(kb: KnowledgeBase, _config: LintRuleConfig): LintFinding[] {
  const findings: LintFinding[] = [];
  const entityNames = new Map<string, string>(); // lowercase name → entity id

  for (const entity of kb.entities.values()) {
    entityNames.set(entity.name.toLowerCase(), entity.id);
  }

  for (const [slug, page] of kb.pages) {
    const linkedSlugs = new Set([...page.outboundLinks, slug]); // exclude self

    for (const claimId of page.claimIds) {
      const claim = kb.claims.get(claimId);
      if (!claim) continue;

      for (const entityName of claim.entities) {
        const entityId = entityNames.get(entityName.toLowerCase());
        if (entityId && !linkedSlugs.has(entityId) && kb.pages.has(entityId)) {
          findings.push({
            rule: 'missing-cross-refs',
            severity: 'info',
            message: `Page "${page.title}" mentions "${entityName}" but doesn't link to its page.`,
            pages: [slug, entityId],
            claims: [claimId],
            entities: [entityId],
            suggestion: `Add a cross-reference link from "${page.title}" to "${entityName}".`,
          });
          linkedSlugs.add(entityId); // avoid duplicate findings
        }
      }
    }
  }

  return findings;
}

/**
 * EMPTY PAGES: pages that have zero claims.
 */
function lintEmptyPages(kb: KnowledgeBase, _config: LintRuleConfig): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const [slug, page] of kb.pages) {
    if (page.pageType === 'index' || page.pageType === 'log') continue;
    if (page.claimIds.length === 0) {
      findings.push({
        rule: 'empty-pages',
        severity: 'warning',
        message: `Page "${page.title}" has no claims.`,
        pages: [slug],
        claims: [],
        entities: page.entityIds,
        suggestion: `Add source material that mentions "${page.title}" or remove this page.`,
      });
    }
  }

  return findings;
}
