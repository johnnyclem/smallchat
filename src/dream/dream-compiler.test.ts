/**
 * Dream on real inputs (SAT-21, SAT-22, SAT-23, SAT-24).
 *
 * - SAT-21: Claude Code writes tool_result content as an array of blocks;
 *   the analyzer called .toLowerCase() on it and `smallchat dream` aborted.
 * - SAT-22: a successful call whose output mentions "error" counted as a
 *   failure, sentiment was taken from a ±1-line window ("Use read_file
 *   instead of cat" marked read_file negative), and two such mentions
 *   removed a tool from compilation with no human in the loop.
 * - SAT-23: every archive was labelled manual, so after maxRetainedVersions
 *   `--auto` runs the real manual artifact was pruned and rollback restored
 *   a dream output.
 * - SAT-24: the report said boosted/demoted tools had "higher/lower
 *   priority", but nothing applies them to dispatch.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileLatest } from './dream-compiler.js';
import { analyzeSessionLog, aggregateUsageStats } from './log-analyzer.js';
import { extractToolMentions } from './memory-reader.js';
import { prioritizeTools, generateReport } from './tool-prioritizer.js';
import { listVersions, rollbackToFallback } from './artifact-versioning.js';

let dir: string;
let home: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc7-dream-'));
  // readMemoryFiles always reads ~/.claude/CLAUDE.md: keep the real one out.
  home = process.env.HOME;
  process.env.HOME = join(dir, 'home');
});

afterEach(() => {
  process.env.HOME = home;
  rmSync(dir, { recursive: true, force: true });
});

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);

/** One tool call and its result, Claude Code style. */
function call(id: string, name: string, result: Record<string, unknown>): string[] {
  return [
    line({ type: 'assistant', sessionId: 's1', timestamp: '2026-09-30T10:00:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } }),
    line({ type: 'user', sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...result }] } }),
  ];
}

function writeManifest(): string {
  const manifests = join(dir, 'manifests');
  mkdirSync(manifests, { recursive: true });
  writeFileSync(join(manifests, 'fs-manifest.json'), JSON.stringify({
    id: 'fs',
    name: 'Filesystem',
    transportType: 'local',
    tools: [
      { name: 'read_file', description: 'Read a file from disk and return its text', providerId: 'fs', transportType: 'local', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'cat', description: 'Concatenate files to standard output with a shell command', providerId: 'fs', transportType: 'local', inputSchema: { type: 'object', properties: { file: { type: 'string' } } } },
      { name: 'list_directory', description: 'List the entries of a directory', providerId: 'fs', transportType: 'local', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
    ],
  }));
  return manifests;
}

describe('log analysis (SAT-21, SAT-22)', () => {
  it('reads array-form tool_result content instead of crashing', () => {
    const log = join(dir, 'session.jsonl');
    writeFileSync(log, [
      ...call('c1', 'read_file', { content: [{ type: 'text', text: 'file contents' }] }),
      ...call('c2', 'read_file', { is_error: true, content: [{ type: 'text', text: 'ENOENT' }] }),
    ].join('\n'));
    const records = analyzeSessionLog(log);
    expect(records.map(r => r.success)).toEqual([true, false]);
  });

  it('counts a result as a failure only when the harness says is_error', () => {
    const log = join(dir, 'session.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(...call(`c${i}`, 'read_file', { content: 'class NotFoundError extends Error {} // read failed? no: this is the file' }));
    writeFileSync(log, lines.join('\n'));
    const [stats] = aggregateUsageStats(analyzeSessionLog(log));
    expect(stats.successRate).toBe(1);
  });
});

describe('memory sentiment (SAT-22)', () => {
  const tools = ['read_file', 'cat'];

  it('attributes "X instead of Y" to both sides correctly', () => {
    const mentions = extractToolMentions('Use read_file instead of cat for reading files.', tools, 'CLAUDE.md');
    const byTool = Object.fromEntries(mentions.map(m => [m.toolName, m.sentiment]));
    expect(byTool).toEqual({ read_file: 'positive', cat: 'negative' });
  });

  it('reads sentiment from the clause that names the tool, not the neighbouring lines', () => {
    const memory = 'Use read_file instead of cat for reading files.\nAvoid raw shell reads; read_file is safer.';
    const readFile = extractToolMentions(memory, tools, 'CLAUDE.md').filter(m => m.toolName === 'read_file');
    expect(readFile.map(m => m.sentiment)).not.toContain('negative');
  });
});

describe('exclusions are proposals unless configured (SAT-22)', () => {
  const tools = ['read_file', 'cat'];
  const mentions = [
    { toolName: 'cat', context: "avoid cat — it's deprecated", sentiment: 'negative' as const, source: 'a.md' },
    { toolName: 'cat', context: "don't use cat anymore", sentiment: 'negative' as const, source: 'b.md' },
  ];

  it('never excludes a tool on heuristics by default; it proposes the exclusion', () => {
    const hints = prioritizeTools(mentions, [], tools);
    expect([...hints.excluded]).toEqual([]);
    expect([...hints.proposedExclusions]).toEqual(['cat']);
    const report = generateReport(hints, [], mentions);
    expect(report).toMatch(/Proposed exclusions \(not applied/);
  });

  it('excludes exactly the tools named by an explicit rule', () => {
    const hints = prioritizeTools([], [], tools, { exclude: ['cat'] });
    expect([...hints.excluded]).toEqual(['cat']);
  });

  it('applies proposed exclusions only when opted in', () => {
    const hints = prioritizeTools(mentions, [], tools, { applyProposedExclusions: true });
    expect([...hints.excluded]).toEqual(['cat']);
  });

  it('says boosts and demotions are advisory (SAT-24)', () => {
    const hints = prioritizeTools([{ toolName: 'read_file', context: 'read_file is reliable', sentiment: 'positive', source: 'a.md' }], [], tools);
    expect(hints.boosted.has('read_file')).toBe(true);
    const report = generateReport(hints, [], []);
    expect(report).not.toMatch(/higher priority|lower priority/);
    expect(report).toMatch(/advisory/i);
  });
});

describe('compileLatest', () => {
  function config(extra: Record<string, unknown> = {}): string {
    const path = join(dir, 'smallchat.dream.json');
    writeFileSync(path, JSON.stringify({ sourcePath: join(dir, 'manifests'), logDir: join(dir, 'logs'), embedder: 'hash', maxRetainedVersions: 5, outputPath: 'tools.toolkit.json', ...extra }));
    return path;
  }

  it('survives real Claude Code logs and keeps the tool the memory recommends (SAT-21, SAT-22)', async () => {
    writeManifest();
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'session.jsonl'), [
      ...call('c1', 'read_file', { content: [{ type: 'text', text: 'export class NotFoundError extends Error {}' }] }),
      ...call('c2', 'cat', { content: [{ type: 'text', text: 'hello' }] }),
    ].join('\n'));
    writeFileSync(join(dir, 'CLAUDE.md'), 'Use read_file instead of cat.\nAvoid raw shell reads; read_file is safer.\nDo not use cat; avoid cat for binary files.\n');

    const result = await compileLatest({ projectDir: dir, configPath: config() });
    expect(result.analysis.usageStats.find(s => s.toolName === 'read_file')?.successRate).toBe(1);
    expect(result.analysis.priorityHints.excluded.size).toBe(0);
    const artifact = JSON.parse(readFileSync(result.artifactPath!, 'utf-8')) as { tools: Record<string, unknown> };
    expect(Object.keys(artifact.tools).sort()).toEqual(['fs/cat', 'fs/list_directory', 'fs/read_file']);
  }, 60_000);

  it('keeps the manual artifact through repeated --auto runs, and rollback restores it (SAT-23)', async () => {
    writeManifest();
    mkdirSync(join(dir, 'logs'));
    const manual = JSON.stringify({ manual: 'M0', stats: { toolCount: 3 } });
    writeFileSync(join(dir, 'tools.toolkit.json'), manual);
    const path = config({ autoDream: true });

    for (let i = 0; i < 7; i++) await compileLatest({ projectDir: dir, configPath: path });

    const versions = listVersions(dir);
    expect(versions.filter(v => !v.isAutoGenerated)).toHaveLength(1);
    expect(versions.filter(v => v.isAutoGenerated).length).toBeGreaterThan(0);
    rollbackToFallback(dir, 'tools.toolkit.json');
    expect(readFileSync(join(dir, 'tools.toolkit.json'), 'utf-8')).toBe(manual);
  }, 120_000);
});
