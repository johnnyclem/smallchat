/**
 * Release documentation stays true to the package (XSUITE-07, XSUITE-16).
 *
 * - Commands run the scoped package: the unscoped `smallchat` and
 *   `stenographer` npm names are not this suite (one is unregistered, the
 *   other an unrelated package), and `npx` installs without asking when an
 *   MCP host starts it.
 * - The CHANGELOG opens with this version, Keep a Changelog style.
 * - MIGRATION covers the 1.0 package changes, and has an upgrade note for
 *   every Breaking change the review found without one.
 * - Review of the 1.0 docs: the docs-site landing page (TSX, which this
 *   test did not scan) still said "zero dependencies", showed a v0.1.0
 *   badge and ran `npx @smallchat/core` without -y; QUICKSTART, MIGRATION
 *   and REFERENCE did too, and ARCHITECTURE documented a provider-streaming
 *   API that does not exist. The current docs are scanned for those, and
 *   every TypeScript block that imports @smallchat/* must parse (test:pack
 *   typechecks them against the packed package).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
// @ts-expect-error -- a plain .mjs script, without declarations
import { extractSnippets } from '../scripts/doc-snippets.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { version: string };
const read = (path: string) => readFileSync(join(ROOT, path), 'utf-8');

function files(dir: string, pattern: RegExp): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap(entry => {
    const path = join(abs, entry);
    if (entry === 'node_modules' || entry === 'build' || entry === 'dist') return [];
    if (statSync(path).isDirectory()) return files(relative(ROOT, path), pattern);
    return pattern.test(entry) ? [relative(ROOT, path)] : [];
  });
}

const DOCS = [
  'README.md', 'QUICKSTART.md', 'MIGRATION.md', 'CHANGELOG.md', 'ARCHITECTURE.md', 'shorthand/README.md',
  ...files('docs', /\.mdx?$/),
  ...files('packages/docs/docs', /\.mdx?$/),
  ...files('packages/docs/blog', /\.mdx?$/),
  ...files('packages/docs/src', /\.(tsx?|mdx?)$/),
  ...files('examples', /\.md$/),
  ...files('src/cli', /\.ts$/).filter(f => !f.endsWith('.test.ts')),
];

/** Docs that describe 1.0 (not the changelog's history, the blog, or the 0.1 → 0.2 guide). */
const CURRENT_DOCS = [
  'README.md', 'QUICKSTART.md', 'MIGRATION.md', 'ARCHITECTURE.md', 'docs/REFERENCE.md',
  ...files('packages/docs/docs', /\.mdx?$/),
  ...files('packages/docs/src', /\.(tsx?|mdx?)$/),
];
const HISTORICAL_MIGRATION = '# Migration Guide: 0.1.0 → 0.2.0';
const current = (file: string) => {
  const text = read(file);
  return file === 'MIGRATION.md' && text.includes(HISTORICAL_MIGRATION) ? text.slice(0, text.indexOf(HISTORICAL_MIGRATION)) : text;
};
const offendingLines = (pattern: RegExp) => CURRENT_DOCS.flatMap(file =>
  current(file).split('\n').flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])));

describe('release docs', () => {
  it('never run an unscoped npx name', () => {
    const offenders: string[] = [];
    for (const file of DOCS) {
      read(file).split('\n').forEach((line, i) => {
        if (/\bnpx\s+(-y\s+)?(smallchat|stenographer)\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every current doc runs the scoped package with -y', () => {
    expect(offendingLines(/\bnpx @smallchat\//)).toEqual([]);
  });

  it('no current doc claims zero dependencies, an invented provider stream, or a version other than this one', () => {
    expect(offendingLines(/zero[- ](runtime )?dependenc/i)).toEqual([]);
    expect(offendingLines(/openProviderStream|hands control straight to the LLM provider/)).toEqual([]);
    const landing = read('packages/docs/src/pages/index.tsx');
    const badges = [...landing.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map(m => m[1]);
    expect(badges.length).toBeGreaterThan(0);
    expect(badges.every(v => v === pkg.version), badges.join(', ')).toBe(true);
  });

  it('every TypeScript block that imports @smallchat/* parses', () => {
    const snippets = extractSnippets(ROOT) as Array<{ file: string; line: number; lang: string; code: string }>;
    expect(snippets.length).toBeGreaterThan(30);
    const broken = snippets.flatMap(({ file, line, lang, code }) => {
      const { diagnostics } = ts.transpileModule(code, { reportDiagnostics: true, fileName: `snippet.${lang}`, compilerOptions: { jsx: ts.JsxEmit.ReactJSX } });
      return (diagnostics ?? []).map(d => `${file}:${line}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    });
    expect(broken).toEqual([]);
  });

  it('the CHANGELOG opens with this version and its Keep a Changelog sections', () => {
    const changelog = read('CHANGELOG.md');
    const first = changelog.match(/^## .*$/m)?.[0];
    expect(first).toMatch(new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - (Unreleased|\\d{4}-\\d{2}-\\d{2})$`));
    const section = changelog.slice(changelog.indexOf(first!), changelog.indexOf('\n## ', changelog.indexOf(first!) + 1));
    for (const heading of ['### Breaking', '### Added', '### Fixed', '### Security']) expect(section).toContain(`\n${heading}\n`);
  });

  it('MIGRATION covers the 1.0 package changes', () => {
    const migration = read('MIGRATION.md');
    expect(migration.split('\n')[0]).toBe('# Migration Guide: 0.5 → 1.0');
    for (const needle of [
      '@shorthand/core/compaction', 'CompactedSnapshot', '@smallchat/core/memex', 'authorize', 'unsafePublic', 'Node.js 22',
      // Breaking entries that had no upgrade note (review of the 1.0 docs)
      '`canonicalJson()`', 'resources/subscribe', 'Named-argument overload resolution', 'smallchat.config.json', '`--threshold`',
    ]) {
      expect(migration, needle).toContain(needle);
    }
  });

  it('documents the shortlist judge where dispatch is described (PR #91 review)', () => {
    // Determinism is stated with its judge boundary, not unconditionally.
    expect(read('README.md')).toMatch(/proof digest, with no judge configured or when replaying recorded judge verdicts/);
    expect(read('docs/REFERENCE.md')).toMatch(/shortlist judge's\s+verdicts/);
    expect(read('ARCHITECTURE.md')).toContain('with no shortlist judge configured');
    // The option, the page and the egress disclosure.
    expect(read('packages/docs/docs/api/runtime.md')).toMatch(/^\| `judge` \|/m);
    expect(read('packages/docs/sidebars.ts')).toContain("'concepts/judge'");
    const page = read('packages/docs/docs/concepts/judge.md');
    for (const needle of ['@smallchat/core/jev', 'What is sent', 'redactIntent', 'never call', 'judge-approved', 'judge-declined']) {
      expect(page, needle).toContain(needle);
    }
    expect(read('spec/resolve/README.md')).toContain('assume no shortlist judge');
    expect(read('spec/ranking/README.md')).toMatch(/shortlist judge's verdicts/);
    // An unreachable judge leaves the decision, not the proof, the latency or the cache, as without one.
    for (const file of ['README.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'docs/REFERENCE.md', 'packages/docs/docs/concepts/judge.md',
      'packages/docs/docs/concepts/dispatch.md', 'packages/docs/docs/api/runtime.md', 'spec/judge/README.md']) {
      expect(read(file), file).not.toMatch(/judge changes nothing|exactly what it is without one|decides exactly as without/);
    }
  });
});
