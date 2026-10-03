/**
 * Package surface — @shorthand/core is the one canonical package.
 *
 * smallchat vendored its own fork of @shorthand/core (smallchat/shorthand)
 * and re-exports it from four subpaths. These tests pin the surface that
 * smallchat imports today, so it can delete the fork and depend on this
 * package with at most mechanical import changes (SH-15, SAT-28,
 * XSUITE-17). Every value smallchat re-exports must resolve from the same
 * subpath here.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, it, expect } from 'vitest';
import * as root from './index.js';
import * as compaction from './compaction/index.js';
import * as crdt from './crdt/index.js';
import * as importance from './importance/index.js';
import * as truth from './truth/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
  repository: { url: string };
  dependencies?: Record<string, string>;
};

/** Values smallchat's src/index.ts re-exports from '@shorthand/core/compaction'. */
const SMALLCHAT_COMPACTION = [
  'DefaultCompactor',
  'estimateTokens',
  'estimateConversationTokens',
  'extractEntities',
  'extractDecisions',
  'detectTombstones',
  'DefaultQuizGenerator',
  'DefaultQuizEvaluator',
  'tokenOverlapScore',
  'runRecallTest',
  'correctionPropagation',
  'entityProvenance',
  'decisionCompleteness',
  'tombstoneConsistency',
  'temporalOrdering',
  'BUILTIN_INVARIANTS',
  'checkInvariants',
  'tokenize',
  'shannonEntropy',
  'totalInformationBits',
  'computeEntropyMetrics',
  'computeRateDistortion',
  'measureEntityRetention',
  'analyzeInformationTheoretic',
  'VerificationHarness',
  'DEFAULT_VERIFICATION_CONFIG',
];

/** Values smallchat re-exports from '@shorthand/core/truth'. */
const SMALLCHAT_TRUTH = [
  'CONSUMPTION_RULES',
  'isAnonymousIdentity',
  'assertAccountableAuthor',
  'ulid',
  'wikiLineToEntry',
  'entryToWikiLine',
  'parseWikiLines',
  'serializeWikiEntries',
  'readWikiFile',
  'writeWikiFile',
  'classifyEntry',
  'selectCurrentTruth',
  'renderTruthSection',
  'applyTruthToCompactedState',
  'TruthAwareCompactor',
  'truthToInvariantRecords',
  'proposeInvariants',
  'serializeProposals',
  'appendProposalsFile',
];

/** Values smallchat re-exports from '@shorthand/core/crdt'. */
const SMALLCHAT_CRDT = [
  'LamportClock',
  'compareLamport',
  'createVectorClock',
  'tickVectorClock',
  'mergeVectorClocks',
  'compareVectorClocks',
  'LWWRegister',
  'ORSet',
  'GSet',
  'defaultMergeFn',
  'RGA',
  'AgentMemory',
  'MemoryMerge',
  'ConflictDetector',
];

/** Values smallchat's src/importance/index.ts re-exports from '@shorthand/core/importance'. */
const SMALLCHAT_IMPORTANCE = [
  'ImportanceDetector',
  'EntityGraph',
  'computeStateDelta',
  'extractEntities',
  'extractRelations',
  'TrajectoryTracker',
  'RunningStats',
  'cosineSimilarity',
  'cosineDistance',
  'ReferenceGraph',
  'DEFAULT_IMPORTANCE_CONFIG',
];

function missing(mod: Record<string, unknown>, names: string[]): string[] {
  return names.filter((n) => mod[n] === undefined);
}

describe('package identity', () => {
  it('is published as @shorthand/core from the short-hand repo', () => {
    expect(pkg.name).toBe('@shorthand/core');
    expect(pkg.repository.url).toContain('github.com/johnnyclem/short-hand');
  });

  it('has no runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });

  it('exposes the subpaths smallchat imports plus this repo’s own modules', () => {
    for (const sub of [
      '.',
      './compaction',
      './crdt',
      './importance',
      './truth',
      './wiki',
      './ingestion',
      './interpreter',
      './verification',
      './benchmark',
    ]) {
      expect(pkg.exports[sub], sub).toBeDefined();
      expect(pkg.exports[sub].import).toMatch(/^\.\/dist\/.*\.js$/);
      expect(pkg.exports[sub].types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
    }
  });
});

describe('smallchat import surface', () => {
  it('@shorthand/core/compaction resolves every value smallchat re-exports', () => {
    expect(missing(compaction, SMALLCHAT_COMPACTION)).toEqual([]);
  });

  it('@shorthand/core/truth resolves every value smallchat re-exports', () => {
    expect(missing(truth, SMALLCHAT_TRUTH)).toEqual([]);
  });

  it('@shorthand/core/crdt resolves every value smallchat re-exports', () => {
    expect(missing(crdt, SMALLCHAT_CRDT)).toEqual([]);
  });

  it('@shorthand/core/importance resolves every value smallchat re-exports', () => {
    expect(missing(importance, SMALLCHAT_IMPORTANCE)).toEqual([]);
  });

  it('exports normalizeTimestamp from the root', () => {
    expect(root.normalizeTimestamp('1970-01-01T00:00:01.000Z')).toBe(1000);
    expect(root.normalizeTimestamp(42)).toBe(42);
  });
});

describe('truth-format contract additions before the first publish', () => {
  it('@shorthand/core/truth and the root export the evidence classes and the agent quorum', () => {
    const names = ['EVIDENCE_KINDS', 'SETTLING_EVIDENCE_KINDS', 'evidenceClass', 'QUORUM_WINDOW_MS', 'QUORUM_MIN_MEMBERS', 'checkQuorum'];
    expect(missing(truth, names)).toEqual([]);
    expect(missing(root as Record<string, unknown>, names)).toEqual([]);
    expect(truth.evidenceClass('chat')).toBe('question');
    expect(truth.QUORUM_WINDOW_MS).toBe(900_000);
  });
});

describe('root barrel', () => {
  it('re-exports each module’s canonical API', () => {
    expect(missing(root as Record<string, unknown>, [
      'CompactionEngine',
      'RegexCompactor',
      'CompactionLevel',
      'DefaultCompactor',
      'LamportClock',
      'RGA',
      'AgentMemory',
      'ActiveEngramStore',
      'ImportanceDetector',
      'parseWikiLines',
      'selectCurrentTruth',
      'TruthAwareCompactor',
      'WikiRenderer',
      'SourceIngester',
      'InvariantChecker',
      'RecallTester',
      'withFallback',
    ])).toEqual([]);
  });

  it('exports CompactionLevel as a runtime enum, not only a type', () => {
    expect(root.CompactionLevel.L4_INVARIANTS).toBe(4);
  });

  it('keeps the benchmark out of the runtime barrel', () => {
    for (const name of ['ContextShiftBenchmark', 'STARTER_FIXTURES', 'KeywordJudge', 'LMJudge', 'wilson95']) {
      expect((root as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});

describe('smallchat’s type re-exports (SH-REV-C3)', () => {
  it('its exact re-export blocks typecheck against this source, and the renamed names mean what MIGRATION says', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const files = ['test/smoke/smallchat-reexports.ts', 'test/smoke/smallchat-importance.ts'].map((f) => `${root}${f}`);
    const program = ts.createProgram(files, {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts'],
      types: ['node'],
      strict: true,
      noEmit: true,
      isolatedModules: true,
      skipLibCheck: true,
      baseUrl: root,
      paths: { '@shorthand/core': ['src/index.ts'], '@shorthand/core/*': ['src/*/index.ts'] },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file ? `${d.file.fileName.slice(root.length)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ` : '';
      return where + ts.flattenDiagnosticMessageText(d.messageText, '\n');
    });
    expect(diagnostics).toEqual([]);
  }, 60_000);
});
