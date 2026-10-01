/**
 * Decision log — durable, hash-chained JSONL record of every resolution
 * and dispatch; verifiable, and replayable against the same artifact.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DecisionLog,
  DecisionLogError,
  decisionRecordHash,
  intentDigest,
  readDecisionLog,
  replayDecisionLog,
  verifyDecisionLog,
} from './decision-log.js';
import type { DecisionRecord } from './decision-log.js';
import { callDigest } from '../core/call-digest.js';
import { HashEmbedder } from '../embedding/hash-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { ToolCompiler } from '../compiler/compiler.js';
import { buildArtifact } from '../artifact/format.js';
import { writeArtifact } from '../artifact/io.js';
import { loadRuntime } from '../mcp/artifact.js';
import { registerLocalHandler, unregisterLocalHandler } from '../mcp/transport.js';
import type { ProviderManifest } from '../core/types.js';

const manifests: ProviderManifest[] = [
  {
    id: 'notes',
    name: 'Notes',
    transportType: 'local',
    tools: [
      {
        name: 'create_note',
        description: 'Create a new note with a title and body',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
        providerId: 'notes',
        transportType: 'local',
      },
      {
        name: 'delete_note',
        description: 'Delete a note by id',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { destructiveHint: true },
        providerId: 'notes',
        transportType: 'local',
      },
      {
        name: 'search_notes',
        description: 'Search notes by keyword',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        annotations: { readOnlyHint: true },
        providerId: 'notes',
        transportType: 'local',
      },
    ],
  },
];

/** Intents and the outcome each gets from the hash embedder (checked below). */
const RESOLVED = 'search_notes: Search notes by keyword';
const RESOLVED_CREATE = 'create_note: Create a new note with a title and body';
const AMBIGUOUS = 'create a note';
const NOTHING = 'note';

const tmpDirs: string[] = [];
const ran: Array<{ tool: string; args: Record<string, unknown> }> = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc5-decisions-'));
  tmpDirs.push(dir);
  return dir;
}

async function artifactPath(dir: string, extraDescription = ''): Promise<string> {
  const embedder = new HashEmbedder(64);
  const ms = extraDescription
    ? [{ ...manifests[0], tools: manifests[0].tools.map(t => ({ ...t, description: t.description + extraDescription })) }]
    : manifests;
  const result = await new ToolCompiler(embedder, new MemoryVectorIndex()).compile(ms);
  const path = join(dir, `notes${extraDescription ? '-changed' : ''}.toolkit.json`);
  await writeArtifact(path, buildArtifact(result, ms, embedder.fingerprint));
  return path;
}

for (const tool of ['create_note', 'delete_note', 'search_notes']) {
  registerLocalHandler(tool, async (args) => {
    ran.push({ tool, args });
    return { content: `${tool}:ok` };
  });
}

afterEach(() => {
  ran.length = 0;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

process.on('exit', () => {
  for (const tool of ['create_note', 'delete_note', 'search_notes']) unregisterLocalHandler(tool);
});

/** Make a mixed log: resolutions of every outcome, dispatches, dispatches by id. */
async function writeMixedLog(dir: string): Promise<{ path: string; artifact: string }> {
  const artifact = await artifactPath(dir);
  const path = join(dir, 'logs', 'decisions.jsonl');
  const { runtime } = await loadRuntime(artifact, { runtimeOptions: { decisionLog: path } });

  await runtime.resolve(RESOLVED);
  await runtime.resolve(AMBIGUOUS);
  await runtime.resolve(NOTHING);
  await runtime.dispatch(RESOLVED, { query: 'groceries' });
  await runtime.dispatch(AMBIGUOUS, { title: 'x' });
  await runtime.dispatchById('notes/create_note', { title: 'Secret plans', body: 'do not log me' });
  await runtime.dispatchById('notes/create_note', { title: 7 });
  await runtime.dispatchById('notes/nope', {});
  for await (const _event of runtime.dispatchStream(RESOLVED_CREATE, { title: 'streamed' })) { /* drain */ }
  runtime.decisionLog!.close();
  return { path, artifact };
}

describe('decision log: what each line records', () => {
  it('appends one hash-chained line per resolution, dispatch and dispatch by id', async () => {
    const dir = tmp();
    const { path } = await writeMixedLog(dir);
    const records = readDecisionLog(path);

    expect(records.map(r => [r.kind, r.outcome, r.toolId, r.execution])).toEqual([
      ['resolve', 'resolved', 'notes/search_notes', 'none'],
      ['resolve', 'needs-disambiguation', null, 'none'],
      ['resolve', 'unresolved', null, 'none'],
      ['dispatch', 'resolved', 'notes/search_notes', 'ran'],
      ['dispatch', 'needs-disambiguation', null, 'none'],
      ['dispatch-by-id', 'resolved', 'notes/create_note', 'ran'],
      ['dispatch-by-id', 'resolved', 'notes/create_note', 'invalid-arguments'],
      ['dispatch-by-id', 'unresolved', 'notes/nope', 'none'],
      ['dispatch', 'resolved', 'notes/create_note', 'ran'],
    ]);
    expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(records[0].prevHash).toBeNull();
    for (let i = 1; i < records.length; i++) expect(records[i].prevHash).toBe(records[i - 1].hash);
    for (const r of records) expect(decisionRecordHash(r)).toBe(r.hash);
  });

  it('binds intents, artifact, embedder, call and proof by digest, and never records arguments', async () => {
    const dir = tmp();
    const artifact = await artifactPath(dir);
    const path = join(dir, 'decisions.jsonl');
    const { runtime, artifact: art } = await loadRuntime(artifact, { runtimeOptions: { decisionLog: path } });

    const result = await runtime.dispatchById('notes/create_note', { title: 'Secret plans', body: 'do not log me' });
    const dispatched = await runtime.dispatch(RESOLVED, { query: 'groceries' });
    runtime.decisionLog!.close();

    const [byId, byIntent] = readDecisionLog(path);
    expect(byId.callDigest).toBe(callDigest('notes/create_note', { title: 'Secret plans', body: 'do not log me' }));
    expect(byId.proofDigest).toBe((result.metadata!.proof as { proofDigest: string }).proofDigest);
    expect(byId.intentDigest).toBeNull();
    expect(byIntent.intent).toBe(RESOLVED);
    expect(byIntent.intentDigest).toBe(intentDigest(RESOLVED));
    expect(byIntent.callDigest).toBe(callDigest('notes/search_notes', { query: 'groceries' }));
    expect(byIntent.proofDigest).toBe((dispatched.metadata!.proof as { proofDigest: string }).proofDigest);
    for (const r of [byId, byIntent]) {
      expect(r.artifactHash).toBe(art.contentHash);
      expect(r.embedderFingerprint).toEqual(art.embedder);
      expect(r.schema).toBe('smallchat.decision.v1');
    }

    const text = readFileSync(path, 'utf-8');
    expect(text).not.toContain('Secret plans');
    expect(text).not.toContain('do not log me');
    expect(text).not.toContain('groceries');
  });

  it('records only the intent digest when recordIntent is false', async () => {
    const log = new DecisionLog({ recordIntent: false });
    const { runtime } = await loadRuntime(await artifactPath(tmp()), { runtimeOptions: { decisionLog: log } });
    await runtime.resolve(RESOLVED);
    const [line] = log.lines();
    const record = JSON.parse(line) as DecisionRecord;
    expect(record.intent).toBeUndefined();
    expect(record.intentDigest).toBe(intentDigest(RESOLVED));
  });

  it('intentDigest is total: NUL and lone surrogates do not throw and stay distinct', () => {
    expect(intentDigest('a\u0000b')).toMatch(/^[0-9a-f]{64}$/);
    expect(intentDigest('\ud800')).not.toBe(intentDigest('�'));
    expect(intentDigest('Delete the logs')).not.toBe(intentDigest('delete the logs'));
  });
});

describe('decision log: verification', () => {
  it('verifies an intact log and continues its chain when reopened', async () => {
    const dir = tmp();
    const { path, artifact } = await writeMixedLog(dir);
    const before = readDecisionLog(path);

    const { runtime } = await loadRuntime(artifact, { runtimeOptions: { decisionLog: { path } } });
    expect(runtime.decisionLog!.head).toEqual({ seq: before.length, hash: before[before.length - 1].hash });
    await runtime.resolve(RESOLVED);
    runtime.decisionLog!.close();

    const after = verifyDecisionLog(readFileSync(path, 'utf-8'));
    expect(after.ok).toBe(true);
    expect(after.records).toHaveLength(before.length + 1);
    expect(after.records[before.length].prevHash).toBe(before[before.length - 1].hash);
  });

  it('finds an edited, removed, reordered or inserted line', async () => {
    const dir = tmp();
    const { path } = await writeMixedLog(dir);
    const lines = readFileSync(path, 'utf-8').trimEnd().split('\n');
    const join_ = (ls: string[]) => `${ls.join('\n')}\n`;

    // Edit: the tool that ran is changed.
    const edited = [...lines];
    edited[3] = edited[3].replace('notes/search_notes', 'notes/delete_note');
    expect(verifyDecisionLog(join_(edited)).error).toEqual({ line: 4, message: expect.stringContaining('hash does not match') });

    // Edit with a recomputed hash: the next line's prevHash no longer matches.
    const forged = JSON.parse(lines[3]) as DecisionRecord;
    forged.toolId = 'notes/delete_note';
    forged.hash = decisionRecordHash(forged);
    const reHashed = [...lines];
    reHashed[3] = JSON.stringify(forged);
    expect(verifyDecisionLog(join_(reHashed)).error).toEqual({ line: 5, message: expect.stringContaining('prevHash') });

    // Removed line.
    expect(verifyDecisionLog(join_(lines.filter((_, i) => i !== 2))).error?.line).toBe(3);
    // Reordered lines.
    const swapped = [...lines];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    expect(verifyDecisionLog(join_(swapped)).error?.line).toBe(2);
    // Inserted line (a copy).
    expect(verifyDecisionLog(join_([...lines.slice(0, 3), lines[2], ...lines.slice(3)])).error?.line).toBe(4);
    // Truncated head.
    expect(verifyDecisionLog(join_(lines.slice(1))).error?.line).toBe(1);
    // Intact.
    expect(verifyDecisionLog(join_(lines)).ok).toBe(true);
  });

  it('refuses to append after an incomplete or altered last line', async () => {
    const dir = tmp();
    const { path } = await writeMixedLog(dir);
    const intact = readFileSync(path, 'utf-8');

    appendFileSync(path, '{"schema":"smallchat.decision.v1","seq":');
    expect(() => new DecisionLog({ path })).toThrow(/incomplete line/);
    expect(verifyDecisionLog(readFileSync(path, 'utf-8')).error?.message).toMatch(/incomplete/);

    const lines = intact.trimEnd().split('\n');
    lines[lines.length - 1] = lines[lines.length - 1].replace('"execution":"ran"', '"execution":"none"');
    writeFileSync(path, `${lines.join('\n')}\n`);
    expect(() => new DecisionLog({ path })).toThrow(DecisionLogError);
  });

  it('nothing executes when the line cannot be written', async () => {
    const log = new DecisionLog({ path: join(tmp(), 'decisions.jsonl') });
    const { runtime } = await loadRuntime(await artifactPath(tmp()), { runtimeOptions: { decisionLog: log } });
    log.close();

    await expect(runtime.dispatchById('notes/create_note', { title: 'x' })).rejects.toThrow(DecisionLogError);
    await expect(runtime.dispatch(RESOLVED, { query: 'x' })).rejects.toThrow(DecisionLogError);
    expect(ran).toEqual([]);
  });
});

describe('decision log: replay', () => {
  it("replaying the log's intents against the same artifact reproduces every outcome", async () => {
    const dir = tmp();
    const { path, artifact } = await writeMixedLog(dir);
    const records = readDecisionLog(path);
    expect(new Set(records.map(r => r.outcome))).toEqual(new Set(['resolved', 'needs-disambiguation', 'unresolved']));

    // A fresh process: same artifact, no log, nothing learned.
    ran.length = 0;
    const { runtime } = await loadRuntime(artifact);
    const report = await replayDecisionLog(runtime, records);

    expect(report.total).toBe(records.length);
    expect(report.differs).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.reproduced).toBe(records.length);
    // Pure resolutions reproduce their proofs exactly.
    for (const entry of report.entries.filter(e => e.kind === 'resolve')) expect(entry.proofIdentical).toBe(true);
    // Replay runs nothing and learns nothing.
    expect(ran).toEqual([]);
    expect(runtime.semanticMap.size).toBe(0);
    expect(runtime.cache.size).toBe(0);
  });

  it('reports a decision the runtime no longer makes, and skips lines of another artifact', async () => {
    const dir = tmp();
    const { path } = await writeMixedLog(dir);
    const records = readDecisionLog(path);

    // Another artifact (descriptions changed): every line is skipped, none "reproduced".
    const other = (await loadRuntime(await artifactPath(dir, ' (v2)'))).runtime;
    const elsewhere = await replayDecisionLog(other, records);
    expect(elsewhere.reproduced).toBe(0);
    expect(elsewhere.skipped).toBe(records.length);
    expect(elsewhere.entries[0].reason).toMatch(/recorded against artifact/);

    // Same artifact, but the operator taught the runtime otherwise: the change is reported.
    const { runtime } = await loadRuntime((await writeMixedLog(tmp())).artifact);
    runtime.feedback({ intent: RESOLVED, toolId: 'notes/search_notes', correct: false });
    const changed = await replayDecisionLog(runtime, records.filter(r => r.intent === RESOLVED));
    expect(changed.differs).toBeGreaterThan(0);
    expect(changed.entries.find(e => e.status === 'differs')!.reason).toMatch(/outcome resolved →|tool notes\/search_notes →/);
  });
});
