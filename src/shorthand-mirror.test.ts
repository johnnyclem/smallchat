/**
 * shorthand/ mirrors @shorthand/core from the short-hand repository; it is
 * never edited here (SAT-28, XSUITE-17: two diverged codebases shared the
 * @shorthand/core identity). scripts/sync-shorthand.mjs writes it and
 * records every file's sha256 in shorthand/SOURCE; these tests fail when
 * the tree differs from that record.
 *
 * Review of XSUITE-17: SOURCE is itself a file here, so a PR that edits a
 * mirrored file and its hash in SOURCE passed every check, and CI never
 * compared the mirror with short-hand. CI now checks out short-hand at the
 * commit SOURCE records and compares the tree with it (that checkout fails
 * when the commit was never pushed), and --registry compares src/ with the
 * published package.
 */

import { describe, it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMirror, checkPublished, readSource, DEFAULT_MIRROR } from '../scripts/sync-shorthand.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A copy of the mirror without node_modules/ and dist/. */
function copyMirror(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'shorthand-mirror-')), 'shorthand');
  cpSync(DEFAULT_MIRROR, dir, {
    recursive: true,
    filter: (src: string) => !/[\\/]shorthand[\\/](node_modules|dist)([\\/]|$)/.test(src.slice(ROOT.length - 1)),
  });
  return dir;
}

describe('shorthand/ is an exact mirror of @shorthand/core', () => {
  it('matches every file and hash SOURCE records', () => {
    expect(checkMirror()).toEqual([]);
  });

  it('records the short-hand commit and the package version smallchat depends on', () => {
    const source = readSource();
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.dirty).toBe('no');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    const mirror = JSON.parse(readFileSync(join(DEFAULT_MIRROR, 'package.json'), 'utf8')) as { name: string; version: string; private: boolean };
    expect(source.pkg).toBe(`${mirror.name}@${mirror.version}`);
    expect(mirror.private).toBe(true);
    expect(pkg.dependencies[mirror.name]).toBe(`^${mirror.version}`);
  });

  it('fails on an edited, added or deleted file', () => {
    const dir = copyMirror();
    try {
      expect(checkMirror(dir)).toEqual([]);
      writeFileSync(join(dir, 'src', 'index.ts'), readFileSync(join(dir, 'src', 'index.ts'), 'utf8') + '\nexport const forked = true;\n');
      writeFileSync(join(dir, 'src', 'local-patch.ts'), 'export {};\n');
      rmSync(join(dir, 'src', 'utils.ts'));
      expect(checkMirror(dir)).toEqual(expect.arrayContaining([
        'changed: src/index.ts',
        'not in SOURCE: src/local-patch.ts',
        'missing: src/utils.ts',
      ]));
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });

  it('ships no embedding module of its own: smallchat\'s src/embedding is the only copy', () => {
    const files = [...readSource().files.keys()] as string[];
    expect(files.filter(f => /onnx|sqlite-vector|worker-embedder|local-embedder/.test(f))).toEqual([]);
    const mirror = JSON.parse(readFileSync(join(DEFAULT_MIRROR, 'package.json'), 'utf8')) as { exports: Record<string, unknown>; dependencies?: Record<string, string> };
    expect(mirror.exports['./embedding']).toBeUndefined();
    expect(Object.keys(mirror.dependencies ?? {})).toEqual([]);
  });

  /** A stand-in short-hand checkout with the mirrored trees (no git: no commit to compare). */
  function fakeCheckout(mirror: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'short-hand-checkout-'));
    for (const entry of ['src', 'test', 'tsconfig.json', 'vitest.config.ts', 'LICENSE', 'package.json']) {
      cpSync(join(mirror, entry), join(dir, entry), { recursive: true });
    }
    return dir;
  }

  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

  it('an edit whose hash is also edited into SOURCE passes SOURCE, but not the upstream comparison', () => {
    const dir = copyMirror();
    const checkout = fakeCheckout(dir);
    try {
      expect(checkMirror(dir, checkout)).toEqual([]);
      const forked = readFileSync(join(dir, 'src', 'utils.ts'), 'utf8') + '\nexport const forked = true;\n';
      writeFileSync(join(dir, 'src', 'utils.ts'), forked);
      const source = readFileSync(join(dir, 'SOURCE'), 'utf8');
      const old = readSource(dir).files.get('src/utils.ts') as string;
      writeFileSync(join(dir, 'SOURCE'), source.replace(old, sha256(forked)));

      expect(checkMirror(dir)).toEqual([]);
      expect(checkMirror(dir, checkout)).toContain(`differs from ${checkout}: src/utils.ts`);
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it('compares src/ with a published package (its tarball ships src/ without tests)', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'shorthand-published-'));
    try {
      cpSync(join(DEFAULT_MIRROR, 'src'), join(pkg, 'src'), { recursive: true, filter: (src: string) => !src.endsWith('.test.ts') });
      expect(checkPublished(DEFAULT_MIRROR, pkg)).toEqual([]);
      writeFileSync(join(pkg, 'src', 'utils.ts'), readFileSync(join(pkg, 'src', 'utils.ts'), 'utf8') + '\n// patched before publishing\n');
      mkdirSync(join(pkg, 'src', 'extra'));
      writeFileSync(join(pkg, 'src', 'extra', 'only-published.ts'), 'export {};\n');
      expect(checkPublished(DEFAULT_MIRROR, pkg)).toEqual(expect.arrayContaining([
        'differs from the published package: src/utils.ts',
        'only in the published package: src/extra/only-published.ts',
      ]));
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  });

  it('CI compares the mirror with short-hand at the commit SOURCE records', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toContain('repository: johnnyclem/short-hand');
    expect(ci).toMatch(/ref: \$\{\{ steps\.shorthand\.outputs\.commit \}\}/);
    expect(ci).toMatch(/run: npm run check:shorthand -- --registry\n\s+env:\n\s+SHORTHAND_DIR: \S+/);
  });
});

