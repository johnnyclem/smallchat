/**
 * shorthand/ mirrors @shorthand/core from the short-hand repository; it is
 * never edited here (SAT-28, XSUITE-17: two diverged codebases shared the
 * @shorthand/core identity). scripts/sync-shorthand.mjs writes it and
 * records every file's sha256 in shorthand/SOURCE; these tests fail when
 * the tree differs from that record.
 */

import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMirror, readSource, DEFAULT_MIRROR } from '../scripts/sync-shorthand.mjs';

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
});
