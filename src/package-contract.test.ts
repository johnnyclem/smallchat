/**
 * The published package's dependency contract (review: @shorthand/core was
 * `file:./shorthand`, which no registry install can resolve, yet dist/
 * imports it at load time). Every package src/ imports must be a declared
 * registry dependency. `npm run test:pack` checks the packed tarball itself.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
  name: string;
  dependencies: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files: string[];
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(entry) && !/\.test\.ts$/.test(entry) && !path.includes('__fixtures__') ? [path] : [];
  });
}

/** Package name of a bare specifier: `@scope/name/sub` → `@scope/name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('published package contract', () => {
  it('declares only registry dependencies', () => {
    const specs = { ...pkg.dependencies, ...pkg.peerDependencies };
    const local = Object.entries(specs).filter(([, spec]) => /^(file|link|workspace|git\+|github):/.test(spec));
    expect(local).toEqual([]);
    expect(pkg.dependencies['@shorthand/core']).toBe('^1.0.0');
  });

  it('declares every package src/ imports at runtime', () => {
    const declared = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies ?? {}), pkg.name]);
    const builtins = new Set(builtinModules);
    const undeclared = new Set<string>();
    for (const file of sources(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf-8');
      // Value imports and re-exports (type-only imports are erased at build).
      for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
        const specifier = m[1] ?? m[2];
        if (specifier.startsWith('.') || specifier.startsWith('node:') || builtins.has(specifier)) continue;
        const name = packageOf(specifier);
        if (!declared.has(name)) undeclared.add(`${name} (${file.slice(ROOT.length)})`);
      }
    }
    expect([...undeclared]).toEqual([]);
  });

  // npm 11 (Node 24) `npm ci` refuses a lockfile that leaves out another
  // platform's optional packages, and npm 10 then installs no binary for
  // them on that platform. Regenerate with `npm install --package-lock-only`
  // on npm 11 when this fails.
  it('the lockfile lists every optional platform package, so npm ci works on npm 10 and 11', () => {
    const { packages } = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf-8')) as {
      packages: Record<string, { optionalDependencies?: Record<string, string> }>;
    };
    // npm resolves a dependency in the nearest node_modules up the tree
    const resolves = (from: string, name: string): boolean => {
      for (let dir = from; ; dir = dir.replace(/\/?node_modules\/(@[^/]+\/)?[^/]+$/, '')) {
        if (packages[`${dir ? `${dir}/` : ''}node_modules/${name}`]) return true;
        if (!dir || !dir.includes('node_modules')) return Boolean(packages[`node_modules/${name}`]);
      }
    };
    const missing = Object.entries(packages).flatMap(([path, entry]) =>
      Object.keys(entry.optionalDependencies ?? {})
        .filter(name => !resolves(path, name))
        .map(name => `${path || '(root)'} -> ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('builds from a clean dist/, so a removed module never ships', () => {
    const scripts = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.build).toMatch(/^npm run clean && tsc$/);
    expect(scripts.clean).toContain("rmSync('dist'");
    expect(scripts.prepublishOnly).toBe('npm run build');
  });
});
