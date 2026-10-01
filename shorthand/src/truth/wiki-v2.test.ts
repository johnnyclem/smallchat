/**
 * Truth format v2 reading: the status fold, the chain, identities, the
 * multi-file merge and v1 compatibility (spec/truth-format, Addendum A).
 *
 * The findings these reproduce: SH-03 / SAT-08 (a struck or overridden TB
 * stayed ground truth, because the wiki could not say so), SAT-07 (an open
 * contesting UV detached from an active TB), SAT-09 (fail closed on unknown
 * or missing statuses).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import { renderContextFrame } from '../compaction/frame.js';
import { renderTruthSection, truthToInvariantRecords } from './compaction-bridge.js';
import { chainTruthLines, decodeTruthLine } from './format.js';
import { identityKey, isAnonymousIdentity } from './identity.js';
import { groundTruthToInvariant } from './ledger-sync.js';
import {
  classifyEntry,
  entryToWikiLine,
  parseWikiFiles,
  parseWikiLines,
  selectCurrentTruth,
  serializeWikiEntries,
  truthStatusTable,
} from './wiki.js';
import type { TruthTbEntry } from './types.js';

const T = (minute: number) => `2026-09-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const tb = (id: string, claim: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'TB',
  ts: T(0),
  author: 'johnny',
  claim,
  evidence: [{ kind: 'commit', ref: 'abc1234' }],
  signedBy: 'johnny',
  status: 'active',
  ...extra,
});

const uv = (id: string, assertion: string, contests: string | null = null, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'UV',
  ts: T(1),
  author: 'sam',
  assertion,
  basis: 'a hunch',
  verifyBy: { kind: 'ask', value: 'ops' },
  contests,
  status: 'open',
  ...(contests ? { 'x-steno': { links: [{ fromId: id, toId: contests, type: 'contests' }] } } : {}),
  ...extra,
});

const transition = (cause: string, target: string, status: string, kind: string, author = 'kim') => ({
  id: `${cause}:${target}`,
  type: 'TRANSITION',
  ts: T(5),
  author,
  target,
  status,
  cause: { kind, ref: cause },
});

/** An ADDENDUM that writes `links` (e.g. `[['UV1', 'verifies']]`). */
const addendum = (id: string, links: Array<[string, string]>) => ({
  id,
  type: 'ADDENDUM',
  ts: T(3),
  author: 'kim',
  evidence: [{ kind: 'file', ref: 'config.ts:3' }],
  note: null,
  'x-steno': { links: links.map(([toId, type]) => ({ fromId: id, toId, type })) },
});

const strike = (id: string, target: string) => ({
  id,
  type: 'RULING',
  ts: T(4),
  author: 'judge',
  kind: 'strike',
  opinion: 'the cited commit is on an abandoned branch',
  target,
  'x-steno': { links: [{ fromId: id, toId: target, type: 'strikes' }] },
});

describe('status is a fold over TRANSITION lines (SH-03, SAT-08)', () => {
  it('a struck TB is never ground truth, and its projected invariant is displaced', () => {
    const stream = chainTruthLines([
      tb('TB1', 'The rate limit is 30.'),
      strike('R1', 'TB1'),
      transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    ]);
    const { entries, errors, refused } = parseWikiLines(stream);
    expect(errors).toEqual([]);
    expect(refused).toBe(false);
    const selection = selectCurrentTruth(entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.history.map((e) => [e.id, e.status])).toEqual([['TB1', 'struck']]);
    expect(renderTruthSection(selection)).not.toContain('rate limit');

    // End to end: an invariant projected while the TB was active leaves on the next sync
    const engine = new CompactionEngine();
    const before = engine.syncTruthLedger(stream.slice(0, 1));
    engine.getState().l4_invariants.push(groundTruthToInvariant(before.selection.groundTruth[0])!);
    const after = engine.syncTruthLedger(stream);
    expect(after.displacedInvariantKeys).toEqual(['TB1']);
  });

  it('a contest, then an addendum that verifies it and overrides the TB, leave nothing current', () => {
    const stream = chainTruthLines([
      tb('TB1', 'LOG_BUDGET is 100.'),
      uv('UV1', 'LOG_BUDGET went back to 30.', 'TB1', { author: 'alex' }),
      transition('UV1', 'TB1', 'contested', 'contest', 'alex'),
      {
        id: 'AD1',
        type: 'ADDENDUM',
        ts: T(3),
        author: 'kim',
        evidence: [{ kind: 'file', ref: 'config.ts:3' }],
        note: null,
        'x-steno': {
          links: [
            { fromId: 'AD1', toId: 'UV1', type: 'verifies' },
            { fromId: 'AD1', toId: 'TB1', type: 'overrides' },
          ],
        },
      },
      transition('AD1', 'UV1', 'verified', 'verify'),
      transition('AD1', 'TB1', 'overridden', 'override'),
    ]);
    const { entries, transitions } = parseWikiLines(stream);
    expect(transitions.map((t) => t.status)).toEqual(['contested', 'verified', 'overridden']);
    const selection = selectCurrentTruth(entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.contested).toEqual([]);
    expect(selection.unverified).toEqual([]);
    expect(Object.fromEntries(entries.map((e) => [e.id, e.status]))).toEqual({ TB1: 'overridden', UV1: 'verified' });
    const tb1 = entries.find((e) => e.id === 'TB1')!;
    expect(tb1.source).toMatchObject({ version: 2, seq: 1, lineStatus: 'active', transition: { seq: 6, cause: { kind: 'override', ref: 'AD1' } } });
  });

  it('the highest-seq TRANSITION wins', () => {
    const stream = chainTruthLines([
      tb('TB1', 'Deploys need two approvals.'),
      uv('UV1', 'One approval is enough now.', 'TB1'),
      transition('UV1', 'TB1', 'contested', 'contest', 'sam'),
      addendum('AD9', [['UV1', 'refutes']]),
      transition('AD9', 'UV1', 'refuted', 'refute'),
      transition('AD9', 'TB1', 'active', 'refute'),
    ]);
    const [tb1] = parseWikiLines(stream).entries;
    expect(tb1.status).toBe('active');
  });

  it('incremental chunks that chain fold as one stream; a chunk alone is a partial stream', () => {
    const all = chainTruthLines([
      tb('TB1', 'The cron box is decommissioned.'),
      uv('UV2', 'Unrelated heads-up.'),
      uv('UV1', 'The cron box still runs backups.', 'TB1'),
      transition('UV1', 'TB1', 'contested', 'contest', 'sam'),
    ]);
    const first = parseWikiLines(all.slice(0, 2));
    const second = all.slice(2);

    // The host keeps what it read and appends the next chunk (sinceSeq = first.head.seq)
    const joined = parseWikiLines([...all.slice(0, 2), ...second]);
    expect(selectCurrentTruth(joined.entries).contested.map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)])).toEqual([
      ['TB1', ['UV1']],
    ]);

    // Alone, the second chunk starts part-way: valid, and its TRANSITION has no target here
    const alone = parseWikiLines(second, { previous: first.head! });
    expect(alone.errors).toEqual([]);
    expect(alone.transitions).toHaveLength(1);
    expect(alone.entries.map((e) => e.id)).toEqual(['UV1']);

    // A chunk that does not continue the stream the host read is refused
    const elsewhere = parseWikiLines(second, { previous: { seq: 2, hash: 'f'.repeat(64) } });
    expect(elsewhere.refused).toBe(true);
    expect(elsewhere.errors[0].error).toMatch(/^chain broken: prevHash/);
  });

  it('a stream that no longer holds the last line the host read is refused (truncation)', () => {
    const all = chainTruthLines([tb('TB1', 'a'), tb('TB2', 'b'), tb('TB3', 'c')]);
    const head = parseWikiLines(all).head!;
    const truncated = parseWikiLines(all.slice(0, 2), { previous: head });
    expect(truncated.refused).toBe(true);
    expect(truncated.errors[0].error).toMatch(/no longer holds line 3/);
    expect(parseWikiLines(all, { previous: head }).refused).toBe(false);
  });
});

describe('TRANSITIONs as stenographer writes them since its 1.0 review (spec: TRANSITION)', () => {
  it('a TRANSITION id is opaque: the transition:<sha256> form written past 256 characters reads and folds', () => {
    const tbId = `TB${'x'.repeat(200)}`;
    const adId = `AD${'y'.repeat(100)}`;
    const composed = `${adId}:${tbId}`;
    expect(composed.length).toBeGreaterThan(256);
    const override = {
      ...transition(adId, tbId, 'overridden', 'override'),
      id: `transition:${createHash('sha256').update(composed).digest('hex')}`,
    };
    const stream = chainTruthLines([tb(tbId, 'The queue is FIFO.'), addendum(adId, [[tbId, 'overrides']]), override]);
    const result = parseWikiLines(stream);
    expect(result.errors).toEqual([]);
    expect(result.entries[0].status).toBe('overridden');
    expect(result.entries[0].source?.transition).toMatchObject({ id: override.id, cause: { kind: 'override', ref: adId } });
    // The readable form would break the id rule, which is why stenographer hashes it
    expect(() => decodeTruthLine(chainTruthLines([{ ...override, id: composed }])[0])).toThrow(/^id: an id is 1–256 characters/);
  });

  it('a struck contest stops counting: its TB is active again (cause strike) and nothing cites the struck UV', () => {
    const stream = chainTruthLines([
      tb('TB1', 'Deploys need two approvals.'),
      uv('UV1', 'One approval is enough now.', 'TB1'),
      transition('UV1', 'TB1', 'contested', 'contest', 'sam'),
      strike('R1', 'UV1'),
      transition('R1', 'UV1', 'struck', 'strike', 'judge'),
      transition('R1', 'TB1', 'active', 'strike', 'judge'),
    ]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.groundTruth.map((t) => t.id)).toEqual(['TB1']);
    expect(selection.contested).toEqual([]);
    expect(selection.unverified).toEqual([]);
    expect(selection.history.map((e) => [e.id, e.status])).toEqual([['UV1', 'struck']]);
    expect(renderTruthSection(selection)).not.toContain('One approval');
  });

  it('a TB with another open contest stays contested, citing only that one', () => {
    const stream = chainTruthLines([
      tb('TB1', 'Deploys need two approvals.'),
      uv('UV1', 'One approval is enough now.', 'TB1'),
      transition('UV1', 'TB1', 'contested', 'contest', 'sam'),
      uv('UV2', 'Hotfixes skip approval.', 'TB1', { author: 'alex' }),
      strike('R1', 'UV1'),
      transition('R1', 'UV1', 'struck', 'strike', 'judge'),
    ]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.contested.map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)])).toEqual([['TB1', ['UV2']]]);
  });

  it('blank lines are skipped and counted in the line numbers errors report', () => {
    const [line] = chainTruthLines([tb('TB1', 'x')]);
    const edited = JSON.stringify({ ...JSON.parse(line), claim: 'y' });
    const result = parseWikiLines(['', '   ', edited, '']);
    expect(result.errors).toMatchObject([{ line: 3, id: 'TB1', error: expect.stringMatching(/^hash mismatch/) }]);
    expect(parseWikiLines(`\n${line}\n\n`).lines.map((l) => l.line)).toEqual([2]);
  });
});

describe('open contesting UVs are attached to their TB whatever its recorded status (SAT-07)', () => {
  it('an active TB with an open contest is carried as contested, with the UV beside it', () => {
    // A stream read before stenographer's TRANSITION reached it
    const stream = chainTruthLines([tb('TB1', 'All embeddings are 384-dimensional.'), uv('UV1', 'The ONNX path emits 768.', 'TB1')]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.contested.map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)])).toEqual([['TB1', ['UV1']]]);
    const text = renderTruthSection(selection);
    expect(text).toContain('[TB ⚠ CONTESTED] All embeddings are 384-dimensional.');
    expect(text).toContain('disputed by [UV — UNVERIFIED] The ONNX path emits 768.');
    expect(truthToInvariantRecords(selection)).toMatchObject([{ key: 'truth:TB1', contested: true }]);
  });

  it('a contest of a TB that is history still shows, standalone', () => {
    const stream = chainTruthLines([
      tb('TB1', 'The cache is per-tenant.'),
      uv('UV1', 'The cache is shared.', 'TB1'),
      addendum('AD1', [['TB1', 'overrides']]),
      transition('AD1', 'TB1', 'overridden', 'override'),
    ]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.unverified.map((u) => u.id)).toEqual(['UV1']);
    expect(renderTruthSection(selection)).toContain('contests TB1');
  });
});

describe('fail closed on unknown or missing statuses (SAT-09)', () => {
  it('keeps a v2 entry without a status as history, verbatim', () => {
    const { status: _s, ...noStatus } = tb('TB1', 'No status here.');
    const stream = chainTruthLines([noStatus]);
    const { entries, errors } = parseWikiLines(stream);
    expect(errors).toEqual([]);
    expect(entries[0].status).toBeNull();
    expect(classifyEntry(entries[0])).toBe('history');
    expect(serializeWikiEntries(entries)).toEqual(stream);
  });

  it('a TRANSITION to a status no one knows takes the entry out of current truth', () => {
    // A cause a newer writer's stream can't carry is named as none (ref null)
    const archive = { ...transition('X1', 'TB1', 'archived', 'archive', 'johnny'), cause: { kind: 'archive', ref: null } };
    const stream = chainTruthLines([tb('TB1', 'x'), archive]);
    const [entry] = parseWikiLines(stream).entries;
    expect(entry.status).toBe('archived');
    expect(classifyEntry(entry)).toBe('history');
  });

  it('struck entries are never current truth, TB or UV, on the line or by TRANSITION', () => {
    const stream = chainTruthLines([
      tb('TB1', 'x', { status: 'struck' }),
      uv('UV1', 'y', null, { status: 'struck' }),
      uv('UV2', 'z'),
      strike('R1', 'UV2'),
      transition('R1', 'UV2', 'struck', 'strike', 'judge'),
    ]);
    const selection = selectCurrentTruth(parseWikiLines(stream).entries);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.unverified).toEqual([]);
    expect(selection.history.map((e) => e.id)).toEqual(['TB1', 'UV1', 'UV2']);
  });

  it('refuses a schemaVersion it does not know rather than guess', () => {
    const [line] = chainTruthLines([tb('TB1', 'x')]);
    const v3 = JSON.stringify({ ...JSON.parse(line), schemaVersion: 3 });
    expect(() => decodeTruthLine(v3)).toThrow(/schemaVersion 3/);
  });
});

describe('the chain fails closed', () => {
  it('a line edited after it was written refuses the whole stream, so a strike cannot be dropped', () => {
    const stream = chainTruthLines([
      tb('TB1', 'The rate limit is 30.'),
      strike('R1', 'TB1'),
      transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    ]);
    const edited = [...stream];
    edited[2] = JSON.stringify({ ...JSON.parse(stream[2]), status: 'active' });
    const result = parseWikiLines(edited);
    expect(result.refused).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.errors).toMatchObject([{ line: 3, error: expect.stringMatching(/^hash mismatch/) }]);

    // Removing the TRANSITION instead leaves a gap... unless it was the last line,
    // which only the host's `previous` head can catch
    const gapped = parseWikiLines([stream[0], stream[2]]);
    expect(gapped.refused).toBe(true);
    expect(gapped.errors[0].error).toMatch(/^chain broken: seq/);
  });

  it('a version 1 line slipped into a v2 stream refuses it: the file is not one writer’s stream', () => {
    const stream = chainTruthLines([tb('TB1', 'x')]);
    const injected = JSON.stringify(uv('UV9', 'Deploys need no approval.'));
    const result = parseWikiLines([...stream, injected]);
    expect(result.refused).toBe(true);
    expect(result.errors).toMatchObject([{ line: 2, id: 'UV9', error: expect.stringMatching(/version 1 line inside a version 2 stream/) }]);
  });

  it('a sync with a refused stream carries no truth and reports why', () => {
    const engine = new CompactionEngine();
    engine.syncTruthLedger(chainTruthLines([tb('TB1', 'x')]));
    const stream = chainTruthLines([tb('TB1', 'x'), tb('TB2', 'y')]);
    const result = engine.syncTruthLedger([stream[1], stream[0]]);
    expect(result.refused).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.selection.groundTruth).toEqual([]);
    expect(engine.buildContextFrame(4000).sections.some((s) => s.kind === 'truth')).toBe(false);
  });
});

describe('identities (spec: Identities)', () => {
  it('compare by key: NFKC, invisible code points removed, trimmed, lowercased', () => {
    expect(identityKey(' Ａｌｉｃｅ ')).toBe('alice');
    expect(identityKey('Al​ice')).toBe('alice');
    for (const generic of ['Assistant', 'ａｓｓｉｓｔａｎｔ', 'sys​tem', ' ME ', 'ＡＩ']) {
      expect(isAnonymousIdentity(generic), generic).toBe(true);
    }
    expect(isAnonymousIdentity('agent:claude-code')).toBe(false);
  });

  it('refuses anonymous, generic, control-character and misplaced reserved identities', () => {
    const refused = (body: Record<string, unknown>) => () => decodeTruthLine(chainTruthLines([body])[0]);
    expect(refused(tb('TB1', 'x', { author: 'ａｓｓｉｓｔａｎｔ' }))).toThrow(/anonymous/);
    expect(refused(tb('TB1', 'x', { signedBy: 'Sys​tem' }))).toThrow(/anonymous/);
    expect(refused(uv('UV1', 'x', null, { author: 'sam\u0007' }))).toThrow(/control character/);
    expect(refused(uv('UV1', 'x', null, { author: 'Detector:wiki-sync' }))).toThrow(/reserved/);
    expect(refused(tb('TB1', 'x', { author: 'MIGRATION' }))).toThrow(/reserved/);
    expect(refused(tb('TB1', 'x', { signedBy: 'migration' }))).toThrow(/reserved/);
    // The backfill's unsigned TB is allowed
    expect(refused(tb('TB1', 'x', { author: 'migration', signedBy: null }))).not.toThrow();
    // A TRANSITION carries its cause's author, and no cause is written by the backfill or a detector
    expect(refused(transition('C1', 'TB1', 'struck', 'strike', 'migration'))).toThrow(/reserved/);
    expect(refused(transition('C1', 'TB1', 'struck', 'strike', 'Detector:wiki-sync'))).toThrow(/reserved/);
  });
});

describe('admission: what a reader takes as truth', () => {
  it('an unsigned TB is never truth on its own', () => {
    const stream = chainTruthLines([tb('TB1', 'Superseded: redis', { author: 'migration', signedBy: null })]);
    const [entry] = parseWikiLines(stream).entries;
    expect(entry.inadmissible).toMatchObject({ reason: 'unsigned' });
    expect(classifyEntry(entry)).toBe('history');
    // Hand-built entries too
    const handBuilt: TruthTbEntry = { ...(entry as TruthTbEntry), source: undefined, inadmissible: undefined };
    expect(classifyEntry(handBuilt)).toBe('history');
  });

  it('a v1 TB is unverifiable (no hash) unless the host opts in; a v1 UV is read', () => {
    const v1 = [JSON.stringify(tb('TB1', 'The API is REST-only.')), JSON.stringify(uv('UV1', 'The cron box has a stale hosts file.'))];
    const strict = selectCurrentTruth(parseWikiLines(v1).entries);
    expect(strict.groundTruth).toEqual([]);
    expect(strict.unverified.map((u) => u.id)).toEqual(['UV1']);
    expect(strict.history.map((e) => [e.id, e.inadmissible?.reason])).toEqual([['TB1', 'unverifiable']]);

    const opted = selectCurrentTruth(parseWikiLines(v1, { admitV1Tbs: true }).entries);
    expect(opted.groundTruth.map((t) => t.id)).toEqual(['TB1']);
  });

  it('with a signer registry, only listed authors and signers count (agent:* matches by prefix)', () => {
    const stream = chainTruthLines([
      tb('TB1', 'listed'),
      tb('TB2', 'unlisted signer', { author: 'mallory', signedBy: 'mallory' }),
      uv('UV1', 'agent heads-up', null, { author: 'agent:claude-code' }),
      uv('UV2', 'unlisted heads-up', null, { author: 'eve' }),
    ]);
    const registry = { signers: [{ id: 'Johnny', role: 'human' as const }, { id: 'agent:*', role: 'agent' as const }] };
    const selection = selectCurrentTruth(parseWikiLines(stream, { signers: registry }).entries);
    expect(selection.groundTruth.map((t) => t.id)).toEqual(['TB1']);
    expect(selection.unverified.map((u) => u.id)).toEqual(['UV1']);
    expect(selection.history.map((e) => [e.id, e.inadmissible?.reason])).toEqual([
      ['TB2', 'unverifiable'],
      ['UV2', 'unverifiable'],
    ]);
  });
});

describe('re-serialization never rewrites a line', () => {
  it('writes back the line as read, whatever the fold made of its status', () => {
    const stream = chainTruthLines([
      tb('TB1', 'x', { reviewers: ['sam'], 'x-other': { n: 1.5 } }),
      strike('R1', 'TB1'),
      transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    ]);
    const { entries } = parseWikiLines(stream);
    expect(entries[0].status).toBe('struck');
    expect(serializeWikiEntries(entries)).toEqual([stream[0]]);
    expect(entryToWikiLine(entries[0])).toEqual(JSON.parse(stream[0]));
  });
});

describe('several files: each folds alone, then the most advanced status wins', () => {
  const alex = chainTruthLines([tb('TB1', 'The batch box is gone.'), uv('UV1', 'Retries are idempotent.')]);
  const sam = chainTruthLines([
    tb('TB1', 'The batch box is gone.'),
    uv('UV1', 'Retries are idempotent.'),
    strike('R1', 'TB1'),
    transition('R1', 'TB1', 'struck', 'strike', 'judge'),
    addendum('AD1', [['UV1', 'verifies']]),
    transition('AD1', 'UV1', 'verified', 'verify'),
  ]);

  it('takes struck over active, verified over open', () => {
    const merged = parseWikiFiles([
      { name: 'wiki/alex.jsonl', text: alex },
      { name: 'wiki/sam.jsonl', text: sam },
    ]);
    expect(merged.refused).toBe(false);
    expect(Object.fromEntries(merged.entries.map((e) => [e.id, e.status]))).toEqual({ TB1: 'struck', UV1: 'verified' });
    expect(merged.entries.find((e) => e.id === 'TB1')!.source?.file).toBe('wiki/sam.jsonl');
  });

  it('an entry two files disagree about is a conflict, and not truth', () => {
    const other = chainTruthLines([tb('TB1', 'The batch box is back.')]);
    const merged = parseWikiFiles([
      { name: 'a.jsonl', text: alex },
      { name: 'b.jsonl', text: other },
    ]);
    const tb1 = merged.entries.find((e) => e.id === 'TB1')!;
    expect(tb1.inadmissible?.reason).toBe('conflict');
    expect(classifyEntry(tb1)).toBe('history');
    expect(merged.conflicts).toEqual([{ id: 'TB1', files: ['a.jsonl', 'b.jsonl'] }]);
  });

  it('key order does not make a conflict (JCS comparison)', () => {
    const reordered = alex.map((l) => {
      const { claim, evidence, ...rest } = JSON.parse(l);
      return JSON.stringify(rest.type === 'TB' ? { evidence, ...rest, claim } : JSON.parse(l));
    });
    // Same bytes for the hash (JCS), different key order on the wire
    const merged = parseWikiFiles([
      { name: 'a.jsonl', text: alex },
      { name: 'b.jsonl', text: reordered },
    ]);
    expect(merged.errors).toEqual([]);
    expect(merged.conflicts).toEqual([]);
  });

  it('a refused file refuses the merge', () => {
    const merged = parseWikiFiles([
      { name: 'a.jsonl', text: alex },
      { name: 'b.jsonl', text: [sam[0], sam[2]] },
    ]);
    expect(merged.refused).toBe(true);
    expect(merged.entries).toEqual([]);
    expect(merged.errors[0]).toMatchObject({ file: 'b.jsonl', line: 2 });
  });
});

// ---------------------------------------------------------------------------
// Review findings SH-R1, SH-R2 / SH-REV-C1, SH-R9 (golden ledger fixture)
// ---------------------------------------------------------------------------

const FIXTURES = new URL('../../test/fixtures/truth-format/', import.meta.url);
const ledgerLines = readFileSync(new URL('valid/ledger.jsonl', FIXTURES), 'utf8').split('\n').filter((l) => l.length > 0);
const ledgerExpected = JSON.parse(readFileSync(new URL('valid/ledger.expected.json', FIXTURES), 'utf8'));
const fixtureSigners = JSON.parse(readFileSync(new URL('signers.json', FIXTURES), 'utf8'));
const OVERRIDDEN_TB = '01M1E6JK80P9Y3CMA9HBZEND9H';
const STRUCK_TB = '01M1E6JK8605J7H4P2BYWD97SN';
const OPEN_UV = '01M1E6JK81TR57BA191BG8Y0Q3';
const ACTIVE_TB = '01M1E6JK84NECBQZ8GX9C7H1KA';
const ADDENDUM = '01M1E6JK8334CZN2ND29RFBWSK';
const fullRead = () => parseWikiLines(ledgerLines);

/** The fixture ledger with bodies appended, chained onto its head as a writer would. */
const appended = (...bodies: Array<Record<string, unknown>>) => [...ledgerLines, ...chainTruthLines(bodies, fullRead().head)];

describe('a TRANSITION cannot bring back what is final, or come from someone the registry does not list (SH-R1)', () => {
  const revive = (author: string, ref: string | null = null) =>
    appended({ id: `revive-${author}`, type: 'TRANSITION', ts: T(30), author, target: OVERRIDDEN_TB, status: 'active', cause: { kind: 'verify', ref } });

  it('an unlisted author cannot revive an overridden TB as ground truth', () => {
    const read = parseWikiLines(revive('mallory'), { signers: fixtureSigners, previous: fullRead().head });
    expect(read.refused).toBe(false);
    const tb = read.entries.find((e) => e.id === OVERRIDDEN_TB)!;
    expect(tb.status).toBe('overridden');
    expect(selectCurrentTruth(read.entries).groundTruth.map((t) => t.id)).not.toContain(OVERRIDDEN_TB);
    expect(read.held).toMatchObject([{ line: 16, id: 'revive-mallory', reason: expect.stringMatching(/mallory.*signer registry/) }]);
  });

  it('a listed author cannot either: overridden and struck never change again', () => {
    const read = parseWikiLines(revive('kim', ADDENDUM), { signers: fixtureSigners });
    expect(read.entries.find((e) => e.id === OVERRIDDEN_TB)!.status).toBe('overridden');
    expect(read.held).toMatchObject([{ id: 'revive-kim', reason: expect.stringMatching(/overridden.*final/) }]);

    const unstrike = parseWikiLines(
      appended({ id: 'unstrike', type: 'TRANSITION', ts: T(30), author: 'lee', target: STRUCK_TB, status: 'active', cause: { kind: 'verify', ref: null } }),
    );
    expect(unstrike.entries.find((e) => e.id === STRUCK_TB)!.status).toBe('struck');
    expect(selectCurrentTruth(unstrike.entries).groundTruth.map((t) => t.id)).not.toContain(STRUCK_TB);
  });

  it('a final status can still advance on the lattice (overridden, then struck)', () => {
    const read = parseWikiLines(
      appended(strike('R9', OVERRIDDEN_TB), { ...transition('R9', OVERRIDDEN_TB, 'struck', 'strike', 'johnnyclem') }),
    );
    expect(read.errors).toEqual([]);
    expect(read.held).toEqual([]);
    expect(read.entries.find((e) => e.id === OVERRIDDEN_TB)!.status).toBe('struck');
  });

  it('an unlisted author cannot close an open contest, so the dispute stays visible', () => {
    const lines = appended(
      uv('UVC', 'LOG_BUDGET is 30 again.', ACTIVE_TB, { author: 'sam' }),
      transition('UVC', ACTIVE_TB, 'contested', 'contest', 'sam'),
      { id: 'close', type: 'TRANSITION', ts: T(31), author: 'mallory', target: 'UVC', status: 'verified', cause: { kind: 'verify', ref: null } },
    );
    const read = parseWikiLines(lines, { signers: fixtureSigners });
    expect(read.refused).toBe(false);
    expect(read.entries.find((e) => e.id === 'UVC')!.status).toBe('open');
    const contested = selectCurrentTruth(read.entries).contested.map((c) => [c.tombstone.id, c.contestedBy.map((u) => u.id)]);
    expect(contested).toEqual([[ACTIVE_TB, ['UVC']]]);
    expect(read.held.map((h) => h.id)).toEqual(['close']);
  });

  it('a verified or refuted UV stays closed', () => {
    const read = parseWikiLines(
      appended({ id: 'reopen', type: 'TRANSITION', ts: T(30), author: 'kim', target: '01M1E6JK82QWPK6VS437JKMJPZ', status: 'open', cause: { kind: 'contest', ref: null } }),
    );
    expect(read.entries.find((e) => e.id === '01M1E6JK82QWPK6VS437JKMJPZ')!.status).toBe('verified');
    expect(read.held.map((h) => h.id)).toEqual(['reopen']);
  });

  it('a TRANSITION whose cause is not an earlier line refuses the stream', () => {
    const read = parseWikiLines(
      appended({ id: 'ghost', type: 'TRANSITION', ts: T(30), author: 'kim', target: OPEN_UV, status: 'verified', cause: { kind: 'verify', ref: 'AD-NOWHERE' } }),
    );
    expect(read.refused).toBe(true);
    expect(read.errors).toMatchObject([{ line: 16, id: 'ghost', error: expect.stringMatching(/cause AD-NOWHERE.*not an earlier line/) }]);
  });
});

describe('incremental reads fold the increment into what was read before (SH-R2, SH-REV-C1)', () => {
  it('a strike that arrives in an increment demotes a TB from the earlier read', () => {
    const read = parseWikiLines(ledgerLines.slice(0, 9));
    expect(read.entries.find((e) => e.id === STRUCK_TB)!.status).toBe('active');
    const next = parseWikiLines(ledgerLines.slice(9), { base: read });
    expect(next.refused).toBe(false);
    expect(next.errors).toEqual([]);
    expect(truthStatusTable(next.entries)).toEqual(ledgerExpected);
    expect(selectCurrentTruth(next.entries).groundTruth.map((t) => t.id)).not.toContain(STRUCK_TB);
    // The result is the whole stream so far: keep it as the next base
    expect(next.lines.map((l) => l.text)).toEqual(ledgerLines);
    expect(next.head).toEqual(fullRead().head);
    expect(next.transitions.map((t) => t.id)).toEqual(fullRead().transitions.map((t) => t.id));
    // The earlier read is not changed
    expect(read.entries.find((e) => e.id === STRUCK_TB)!.status).toBe('active');
  });

  it('chunk by chunk gives the whole-file fold, whatever the cut', () => {
    for (const cut of [1, 3, 4, 6, 10, 11, 14]) {
      const first = parseWikiLines(ledgerLines.slice(0, cut));
      const next = parseWikiLines(ledgerLines.slice(cut), { base: first });
      expect(truthStatusTable(next.entries), `cut at ${cut}`).toEqual(ledgerExpected);
    }
    // An empty increment (nothing new since the last read) is the base again
    expect(truthStatusTable(parseWikiLines([], { base: fullRead() }).entries)).toEqual(ledgerExpected);
  });

  it('an increment that does not continue its base is refused, as is a refused base', () => {
    const read = parseWikiLines(ledgerLines.slice(0, 9));
    expect(parseWikiLines(ledgerLines.slice(10), { base: read }).refused).toBe(true);
    const refusedBase = parseWikiLines([ledgerLines[1]]);
    expect(refusedBase.refused).toBe(false); // a partial stream on its own is fine…
    const broken = parseWikiLines([ledgerLines[0], ledgerLines[2]]);
    expect(broken.refused).toBe(true);
    expect(parseWikiLines(ledgerLines.slice(3), { base: broken })).toMatchObject({ refused: true, errors: [{ line: 0 }] });
  });

  it('the engine syncs an increment onto what it synced before', () => {
    const engine = new CompactionEngine();
    const first = engine.syncTruthLedger(ledgerLines.slice(0, 9));
    expect(first.selection.groundTruth.map((t) => t.id)).toEqual([ACTIVE_TB, STRUCK_TB]);
    const second = engine.syncTruthLedger(ledgerLines.slice(9), { base: first.read! });
    expect(second.refused).toBe(false);
    expect(second.selection.groundTruth.map((t) => t.id)).toEqual([ACTIVE_TB, '01M1E6JK8BVGAAP733SN0VCW9W']);
    const frame = renderContextFrame(engine.buildContextFrame(4000));
    expect(frame).not.toContain('The cron box is decommissioned.');
    expect(frame).toContain('fetchV1 is superseded by fetchV2.');
  });

  it('the engine refuses a stream that starts part-way without the read it continues', () => {
    const engine = new CompactionEngine();
    engine.syncTruthLedger(ledgerLines.slice(0, 9));
    const partial = engine.syncTruthLedger(ledgerLines.slice(9), { previous: parseWikiLines(ledgerLines.slice(0, 9)).head });
    expect(partial.refused).toBe(true);
    expect(partial.errors[0].error).toMatch(/starts at seq 10.*base/);
    expect(partial.selection.groundTruth).toEqual([]);
  });
});

describe('a previous head needs the stream it names (SH-R9)', () => {
  const head = () => fullRead().head!;

  it('an empty input is not a continuation of the stream read before', () => {
    const read = parseWikiLines('', { previous: head() });
    expect(read.refused).toBe(true);
    expect(read.errors).toMatchObject([{ line: 0, error: expect.stringMatching(/holds no line of the stream.*seq 15/) }]);
  });

  it('a stream rewritten as version 1 lines is refused, and its UVs are not heads-ups', () => {
    const v1 = JSON.stringify(uv('UVX', 'LOG_BUDGET is 30 again.', null, { author: 'mallory' }));
    const read = parseWikiLines([v1], { previous: head() });
    expect(read.refused).toBe(true);
    expect(selectCurrentTruth(read.entries).unverified).toEqual([]);
  });
});
