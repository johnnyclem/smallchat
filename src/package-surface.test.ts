/**
 * The 1.0 package surface. The root entry (`@smallchat/core`) is the
 * inference core: it no longer re-exports the optimization satellites
 * (compaction, CRDT, importance, truth from @shorthand/core; memex and
 * dream from this package). @shorthand/core's modules stay reachable on
 * deprecated subpaths that re-export it unchanged; memex and dream have
 * experimental subpaths of their own.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as root from './index.js';
import * as inference from './inference.js';
import * as compaction from './compaction/index.js';
import * as crdt from './crdt/index.js';
import * as importance from './importance/index.js';
import * as truth from './truth/index.js';
import * as memex from './memex/index.js';
import * as dream from './dream/index.js';
import * as shCompaction from '@shorthand/core/compaction';
import * as shCrdt from '@shorthand/core/crdt';
import * as shImportance from '@shorthand/core/importance';
import * as shTruth from '@shorthand/core/truth';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
  exports: Record<string, { types: string; import: string }>;
};

/** Satellite values 0.x re-exported from the root entry (a sample of each section). */
const SATELLITE_VALUES = {
  compaction: ['DefaultCompactor', 'VerificationHarness', 'estimateTokens', 'detectTombstones', 'BUILTIN_INVARIANTS'],
  truth: ['parseWikiLines', 'selectCurrentTruth', 'renderTruthSection', 'applyTruthToCompactedState', 'TruthAwareCompactor', 'proposeInvariants'],
  crdt: ['LamportClock', 'LWWRegister', 'ORSet', 'GSet', 'RGA', 'AgentMemory', 'MemoryMerge', 'ConflictDetector'],
  importance: ['ImportanceDetector', 'EntityGraph', 'TrajectoryTracker', 'ReferenceGraph'],
  memex: ['memexCompile', 'memexIngest', 'memexResolveQuery', 'memexLint', 'loadMemexConfig', 'discoverSources', 'extractKnowledge', 'emitWikiPages'],
  dream: ['compileLatest', 'dream', 'readMemoryFiles', 'analyzeSessionLog', 'prioritizeTools', 'loadDreamConfig', 'loadArtifactManifest', 'rollbackToFallback'],
};

const present = (mod: object, names: string[]) => names.filter(n => (mod as Record<string, unknown>)[n] !== undefined);

describe('@smallchat/core root entry is the inference core', () => {
  for (const [section, names] of Object.entries(SATELLITE_VALUES)) {
    it(`does not re-export ${section}`, () => {
      expect(present(root, names)).toEqual([]);
    });
  }

  it('still exports the engine, the MCP surface and artifacts', () => {
    for (const name of ['ToolRuntime', 'loadRuntime', 'DispatchError', 'MCPServer', 'ToolCompiler', 'readArtifact', 'callDigest', 'PACKAGE_VERSION', 'ChannelServer', 'HttpTransport']) {
      expect((root as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  it('exports everything @smallchat/core/inference does', () => {
    expect(Object.keys(inference).filter(n => !(n in root))).toEqual([]);
  });
});

describe('deprecated @shorthand/core subpaths', () => {
  const subpaths = [
    ['compaction', compaction, shCompaction],
    ['crdt', crdt, shCrdt],
    ['importance', importance, shImportance],
    ['truth', truth, shTruth],
  ] as const;

  for (const [name, local, upstream] of subpaths) {
    it(`@smallchat/core/${name} re-exports @shorthand/core/${name} unchanged`, () => {
      expect(Object.keys(local).sort()).toEqual(Object.keys(upstream).sort());
      for (const key of Object.keys(upstream)) {
        expect((local as Record<string, unknown>)[key], key).toBe((upstream as Record<string, unknown>)[key]);
      }
      expect(pkg.exports[`./${name}`]).toEqual({ types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js` });
    });

    it(`@smallchat/core/${name} is marked @deprecated in favour of @shorthand/core/${name}`, () => {
      const source = readFileSync(join(ROOT, 'src', name, 'index.ts'), 'utf-8');
      expect(source).toMatch(new RegExp(`@deprecated[^]*@shorthand/core/${name}`));
      expect(source.replace(/\/\*[^]*?\*\//g, '').trim()).toBe(`export * from '@shorthand/core/${name}';`);
    });
  }

  it('the values 0.x re-exported from the root resolve on the subpaths', () => {
    expect(SATELLITE_VALUES.compaction.filter(n => !(n in compaction))).toEqual([]);
    expect(SATELLITE_VALUES.truth.filter(n => !(n in truth))).toEqual([]);
    expect(SATELLITE_VALUES.crdt.filter(n => !(n in crdt))).toEqual([]);
    expect(SATELLITE_VALUES.importance.filter(n => !(n in importance))).toEqual([]);
  });
});

describe('experimental memex and dream subpaths', () => {
  it('are exported as @smallchat/core/memex and @smallchat/core/dream', () => {
    expect(pkg.exports['./memex']).toEqual({ types: './dist/memex/index.d.ts', import: './dist/memex/index.js' });
    expect(pkg.exports['./dream']).toEqual({ types: './dist/dream/index.d.ts', import: './dist/dream/index.js' });
  });

  it('carry what the root used to export, under their module names', () => {
    expect(present(memex, ['compile', 'ingest', 'resolveQuery', 'lint', 'loadMemexConfig', 'discoverSources', 'extractKnowledge', 'emitWikiPages'])).toHaveLength(8);
    expect(present(dream, ['compileLatest', 'dream', 'readMemoryFiles', 'analyzeSessionLog', 'prioritizeTools', 'loadDreamConfig', 'loadManifest', 'rollbackToFallback'])).toHaveLength(8);
  });

  it('say they are experimental', () => {
    for (const name of ['memex', 'dream']) {
      expect(readFileSync(join(ROOT, 'src', name, 'index.ts'), 'utf-8'), name).toMatch(/@experimental/);
    }
  });
});

describe('every export points at a built file', () => {
  it('maps each subpath to src/<path>.ts', () => {
    for (const [key, target] of Object.entries(pkg.exports)) {
      const src = target.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
      expect(existsSync(join(ROOT, src)), `${key} -> ${src}`).toBe(true);
    }
  });
});
