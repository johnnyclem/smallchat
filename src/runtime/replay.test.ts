/**
 * Replay — golden dispatch traces run against a compiled artifact with
 * learning, cache and semantic map frozen.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TraceFormatError,
  checkExpectation,
  findTraceFiles,
  formatReplayReport,
  isDecisionLogText,
  loadTraceFiles,
  parseTraceFile,
  replayPaths,
  replayTraces,
} from './replay.js';
import { DecisionLog } from './decision-log.js';
import { readFileSync } from 'node:fs';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { buildArtifact } from '../artifact/format.js';
import { writeArtifact } from '../artifact/io.js';
import { loadRuntime } from '../mcp/artifact.js';
import type { ProviderManifest } from '../core/types.js';
import type { ToolRuntime } from './runtime.js';

const manifests: ProviderManifest[] = [
  {
    id: 'notes',
    name: 'Notes',
    transportType: 'local',
    tools: [
      { name: 'create_note', description: 'Create a new note with a title and body', inputSchema: { type: 'object' }, providerId: 'notes', transportType: 'local' },
      { name: 'delete_note', description: 'Delete a note by id', inputSchema: { type: 'object' }, annotations: { destructiveHint: true }, providerId: 'notes', transportType: 'local' },
      { name: 'search_notes', description: 'Search notes by keyword', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, providerId: 'notes', transportType: 'local' },
    ],
  },
];

const TRACE = [
  '# golden traces for the notes toolkit',
  '{"intent": "search_notes: Search notes by keyword", "expect": {"toolId": "notes/search_notes", "tier": "exact"}}',
  '',
  '{"name": "vague create", "intent": "create a note", "expect": {"outcome": "needs-disambiguation", "candidates": ["notes/create_note"]}}',
  '{"intent": "note", "expect": {"outcome": "unresolved"}}',
].join('\n');

let dir: string;
let artifact: string;
let runtime: ToolRuntime;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sc5-replay-'));
  const embedder = new HashEmbedder(64);
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(manifests);
  artifact = join(dir, 'notes.toolkit.json');
  await writeArtifact(artifact, buildArtifact(result, manifests, embedder.fingerprint));
  runtime = (await loadRuntime(artifact)).runtime;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('trace files', () => {
  it('reads JSONL (skipping blank and # lines) and JSON (array or {cases})', () => {
    const jsonl = parseTraceFile(TRACE, 'notes.jsonl');
    expect(jsonl.map(c => [c.line, c.intent])).toEqual([
      [2, 'search_notes: Search notes by keyword'],
      [4, 'create a note'],
      [5, 'note'],
    ]);
    expect(jsonl[1].name).toBe('vague create');

    const cases = jsonl.map(({ file: _f, line: _l, ...c }) => c);
    expect(parseTraceFile(JSON.stringify(cases), 'a.json').map(c => c.intent)).toEqual(jsonl.map(c => c.intent));
    expect(parseTraceFile(JSON.stringify({ cases }), 'b.json')).toHaveLength(3);
  });

  it('names the file and line of a malformed case', () => {
    expect(() => parseTraceFile('{"intent": "x"}', 't.jsonl')).toThrow(/t\.jsonl, line 1: "expect" must be a JSON object/);
    expect(() => parseTraceFile('\n{"intent": "x", "expect": {"toolId": "bare_name"}}', 't.jsonl')).toThrow(/line 2: .*canonical tool id/);
    expect(() => parseTraceFile('{"intent": "x", "expect": {"outcome": "maybe"}}', 't.jsonl')).toThrow(TraceFormatError);
    expect(() => parseTraceFile('{"intent": "x", "expect": {"toolId": "a/b", "tier": "great"}}', 't.jsonl')).toThrow(/tier/);
    expect(() => parseTraceFile('not json', 't.jsonl')).toThrow(/line 1: not valid JSON/);
    expect(() => parseTraceFile('{"cases": 3}', 't.json')).toThrow(/array of cases/);
  });

  it('finds .jsonl and .json files in directories, in a stable order', () => {
    const root = join(dir, 'traces');
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'b.jsonl'), TRACE);
    writeFileSync(join(root, 'a.json'), '[]');
    writeFileSync(join(root, 'nested', 'c.jsonl'), TRACE);
    writeFileSync(join(root, 'README.md'), '# not a trace');
    expect(findTraceFiles([root], dir)).toEqual([join(root, 'a.json'), join(root, 'b.jsonl'), join(root, 'nested', 'c.jsonl')]);
    expect(loadTraceFiles([root], dir).map(c => c.file)).toEqual(['traces/b.jsonl', 'traces/b.jsonl', 'traces/b.jsonl', 'traces/nested/c.jsonl', 'traces/nested/c.jsonl', 'traces/nested/c.jsonl']);
    expect(() => findTraceFiles([join(dir, 'missing')], dir)).toThrow(/no such file/);
  });

  it('tells a decision log from a trace file', () => {
    const log = new DecisionLog();
    log.record({
      kind: 'resolve',
      proof: { intent: 'x', artifactHash: null, embedder: null, outcome: 'unresolved', decision: 'no-candidates', tier: 'none', chosen: null, callDigest: null, proofDigest: 'd' } as never,
      execution: 'none',
    });
    expect(isDecisionLogText(log.lines().join('\n'))).toBe(true);
    expect(isDecisionLogText(TRACE)).toBe(false);
  });
});

describe('replayTraces', () => {
  it('passes when every outcome, tool id, tier and candidate matches', async () => {
    const report = await replayTraces(runtime, parseTraceFile(TRACE, 'notes.jsonl'));
    expect(report.results.map(r => [r.status, r.problems])).toEqual([['pass', []], ['pass', []], ['pass', []]]);
    expect(report).toMatchObject({ total: 3, passed: 3, mismatched: 0, errors: 0 });
    expect(formatReplayReport(report)).toContain('3 passed, 0 mismatched, 0 errors');
  });

  it('reports each kind of mismatch with what the runtime did instead', async () => {
    const wrong = [
      '{"intent": "search_notes: Search notes by keyword", "expect": {"toolId": "notes/create_note"}}',
      '{"intent": "search_notes: Search notes by keyword", "expect": {"toolId": "notes/search_notes", "tier": "high"}}',
      '{"intent": "create a note", "expect": {"toolId": "notes/create_note"}}',
      '{"intent": "create a note", "expect": {"outcome": "needs-disambiguation", "candidates": ["notes/missing"]}}',
      '{"intent": "note", "expect": {"outcome": "needs-disambiguation"}}',
    ].join('\n');
    const report = await replayTraces(runtime, parseTraceFile(wrong, 'wrong.jsonl'));
    expect(report.mismatched).toBe(5);
    const problems = report.results.map(r => r.problems[0]);
    expect(problems[0]).toMatch(/expected resolved notes\/create_note, got resolved notes\/search_notes \(exact, ranked\)/);
    expect(problems[1]).toMatch(/expected tier high, got exact/);
    expect(problems[2]).toMatch(/expected resolved notes\/create_note, got needs-disambiguation/);
    expect(problems[3]).toMatch(/notes\/missing missing/);
    expect(problems[4]).toMatch(/expected needs-disambiguation, got unresolved/);
    expect(formatReplayReport(report)).toContain('✗ line 1');
  });

  it('runs frozen: nothing cached or learned, and order does not matter', async () => {
    const fresh = (await loadRuntime(artifact)).runtime;
    const cases = parseTraceFile(TRACE, 'notes.jsonl');
    const forward = await replayTraces(fresh, cases);
    const backward = await replayTraces(fresh, [...cases].reverse());
    expect(backward.results.map(r => r.actual!.proofDigest).reverse()).toEqual(forward.results.map(r => r.actual!.proofDigest));
    expect(fresh.cache.size).toBe(0);
    expect(fresh.semanticMap.size).toBe(0);
  });

  it('checkExpectation accepts refinement options as candidates when nothing reached LOW', () => {
    expect(checkExpectation(
      { outcome: 'needs-disambiguation', candidates: ['a/x'] },
      { outcome: 'needs-disambiguation', toolId: null, tier: 'low', decision: 'needs-llm-verifier', candidates: ['a/x', 'b/y'], proofDigest: '' },
    )).toEqual([]);
  });
});

describe('replayPaths (what `smallchat replay` runs)', () => {
  it('exits 0 when every trace passes and every decision log verifies and reproduces', async () => {
    const root = join(dir, 'run-pass');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'notes.jsonl'), TRACE);
    const logPath = join(root, 'decisions.jsonl');
    const logged = (await loadRuntime(artifact, { runtimeOptions: { decisionLog: logPath } })).runtime;
    await logged.resolve('create a note');
    await logged.resolve('search_notes: Search notes by keyword');
    logged.decisionLog!.close();

    const run = await replayPaths(runtime, [root], dir);
    expect(run.exitCode).toBe(0);
    expect(run.traces.passed).toBe(3);
    expect(run.decisionLogs).toEqual([expect.objectContaining({ file: 'run-pass/decisions.jsonl', verified: true, records: 2 })]);
    expect(run.decisionLogs[0].replay!.reproduced).toBe(2);
  });

  it('exits 1 on a mismatch or a broken chain, and throws (exit 2) on input it cannot read', async () => {
    const root = join(dir, 'run-fail');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'wrong.jsonl'), '{"intent": "create a note", "expect": {"toolId": "notes/create_note"}}');
    expect((await replayPaths(runtime, [root], dir)).exitCode).toBe(1);

    const logPath = join(dir, 'tampered.jsonl');
    const logged = (await loadRuntime(artifact, { runtimeOptions: { decisionLog: logPath } })).runtime;
    await logged.resolve('note');
    await logged.resolve('note');
    logged.decisionLog!.close();
    writeFileSync(logPath, readFileSync(logPath, 'utf-8').replace('"unresolved"', '"resolved"'));
    const tampered = await replayPaths(runtime, [logPath], dir);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.decisionLogs[0]).toMatchObject({ verified: false, error: { line: 1 } });

    writeFileSync(join(dir, 'garbled.jsonl'), '{"intent": ');
    await expect(replayPaths(runtime, [join(dir, 'garbled.jsonl')], dir)).rejects.toThrow(TraceFormatError);
    const empty = join(dir, 'empty');
    mkdirSync(empty, { recursive: true });
    await expect(replayPaths(runtime, [empty], dir)).rejects.toThrow(/No trace cases/);
  });
});
