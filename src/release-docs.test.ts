/**
 * Release documentation stays true to the package (XSUITE-07, XSUITE-16).
 *
 * - Commands run the scoped package: the unscoped `smallchat` and
 *   `stenographer` npm names are not this suite (one is unregistered, the
 *   other an unrelated package), and `npx` installs without asking when an
 *   MCP host starts it.
 * - The CHANGELOG opens with this version, Keep a Changelog style.
 * - MIGRATION covers the 1.0 package changes.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  ...files('examples', /\.md$/),
  ...files('src/cli', /\.ts$/).filter(f => !f.endsWith('.test.ts')),
];

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

  it('the docs site runs the scoped package with -y', () => {
    const offenders = files('packages/docs/docs', /\.mdx?$/).flatMap(file =>
      read(file).split('\n').flatMap((line, i) => (/\bnpx @smallchat\//.test(line) ? [`${file}:${i + 1}`] : [])),
    );
    expect(offenders).toEqual([]);
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
    for (const needle of ['@shorthand/core/compaction', 'CompactedSnapshot', '@smallchat/core/memex', 'authorize', 'unsafePublic', 'Node.js 22']) {
      expect(migration, needle).toContain(needle);
    }
  });
});
