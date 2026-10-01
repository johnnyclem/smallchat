/**
 * The PROPOSAL write path: the suite envelope, written as one writer's
 * hash-chained stream (spec/truth-format, "The PROPOSAL envelope"), deduped
 * by (targetRef, assertion) (SAT-10), with the bare short-hand format kept
 * as read-only compatibility.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { DefaultCompactor } from '../compaction/snapshot/compactor.js';
import type { ConversationHistory } from '../compaction/snapshot/types.js';
import type { CompactedState } from '../types.js';
import { appendProposalsFile, proposeInvariants, serializeProposals } from './compaction-bridge.js';
import { checkTruthChain, decodeTruthLine } from './format.js';
import { exportProposalDrafts, tbProposal, uvProposal } from './proposal-export.js';
import { COMPACTION_DETECTOR, ProposalStream, parseProposalLines } from './proposals.js';
import { assertAccountableAuthor } from './identity.js';

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const schemaPath = fileURLToPath(new URL('../../test/fixtures/truth-format/wiki-line.v2.schema.json', import.meta.url));
const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));

const history = (...contents: string[]): ConversationHistory => ({
  sessionId: 'sess-1',
  messages: contents.map((content, i) => ({ id: `m${i + 1}`, role: 'user' as const, content, timestamp: i + 1 })),
});

const ENVELOPE_KEYS = ['schemaVersion', 'seq', 'id', 'type', 'ts', 'author', 'kind', 'draft', 'targetRef', 'signal', 'agentSessionId', 'prevHash', 'hash'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proposals-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stateWithTombstone(): CompactedState {
  return {
    l0_messages: [],
    l1_compacted: [],
    l2_summaries: [],
    l3_graph: { entities: new Map(), edges: [] },
    l4_invariants: [{ key: 'db', value: 'postgres', sourceMessage: 'm1', timestamp: 1 }],
    tombstones: [
      {
        originalMessageId: 'm1',
        correctionMessageId: 'm2',
        supersededContent: 'MAX_RETRIES 3',
        correctedValue: 'MAX_RETRIES 5',
        reason: 'user correction',
        timestamp: 2,
      },
    ],
    totalTokenEstimate: 0,
  };
}

describe('the suite PROPOSAL envelope, exactly', () => {
  it('writes every line with the envelope fields and nothing else, hash-chained, valid against the schema', () => {
    const lines = exportProposalDrafts(stateWithTombstone(), { author: COMPACTION_DETECTOR, now: new Date('2026-09-01T10:20:00.000Z') });
    expect(lines).toHaveLength(2);
    const decoded = lines.map((l) => decodeTruthLine(l));
    expect(checkTruthChain(decoded)).toEqual([]);
    for (const [i, line] of lines.entries()) {
      const obj = JSON.parse(line);
      expect(validate(obj), ajv.errorsText(validate.errors)).toBe(true);
      expect(Object.keys(obj)).toEqual(ENVELOPE_KEYS);
      expect(obj).toMatchObject({ schemaVersion: 2, seq: i + 1, type: 'PROPOSAL', author: 'detector:short-hand' });
      expect(obj.prevHash).toBe(i === 0 ? null : JSON.parse(lines[i - 1]).hash);
      expect(obj.signal.source).toBe('compaction-candidate');
    }
    const [uvLine, tbLine] = lines.map((l) => JSON.parse(l));
    expect(Object.keys(uvLine.draft).sort()).toEqual(['assertion', 'basis', 'verifyBy']);
    expect(tbLine.kind).toBe('tb');
    expect(Object.keys(tbLine.draft).sort()).toEqual(['claim', 'evidence']);
  });

  it('continues a stream from its head', () => {
    const first = serializeProposals(proposeInvariants(stubSnapshot(), { author: 'johnny' }));
    const head = { seq: first.length, hash: JSON.parse(first.at(-1)!).hash };
    const next = serializeProposals([uvProposal(uvDraft('More.'), { targetRef: 'x', detail: 'd' }, { author: 'johnny' })], { head });
    expect(checkTruthChain([...first, ...next].map((l) => decodeTruthLine(l)))).toEqual([]);
  });

  it('an anonymous, generic, control-character or migration author never writes', () => {
    for (const author of ['system', 'ａｇｅｎｔ', 'Bo​t', 'johnny\n', 'migration']) {
      expect(() => assertAccountableAuthor(author), JSON.stringify(author)).toThrow();
      expect(() => uvProposal(uvDraft('x'), { targetRef: 't', detail: 'd' }, { author })).toThrow();
    }
    // Detectors file proposals
    expect(() => tbProposal({ claim: 'c', evidence: [{ kind: 'message', ref: 'm1' }] }, { targetRef: 't', detail: 'd' }, { author: 'detector:short-hand' })).not.toThrow();
  });
});

describe('appendProposalsFile: one writer’s chained stream, deduped by (targetRef, assertion)', () => {
  it('proposes a corrected value instead of blocking it on its targetRef (SAT-10)', async () => {
    const path = join(dir, 'proposals.jsonl');
    const compactor = new DefaultCompactor();
    const round1 = await compactor.compact(history('We configured LOG_BUDGET to 30'), 'L3');
    expect(appendProposalsFile(path, proposeInvariants(round1, { author: 'johnny' }))).toMatchObject({ written: 1, skipped: 0 });

    const round2 = await compactor.compact(history('We configured LOG_BUDGET to 30', 'We changed LOG_BUDGET to 60'), 'L3');
    const second = appendProposalsFile(path, proposeInvariants(round2, { author: 'johnny' }));
    expect(second).toMatchObject({ written: 1, skipped: 0 });

    // The same round again files nothing new
    expect(appendProposalsFile(path, proposeInvariants(round2, { author: 'johnny' }))).toMatchObject({ written: 0, skipped: 1 });

    const written = readFileSync(path, 'utf8').trim().split('\n');
    expect(written.map((l) => JSON.parse(l).draft.assertion)).toEqual(['log_budget is 30.', 'log_budget is 60.']);
    expect(written.map((l) => JSON.parse(l).seq)).toEqual([1, 2]);
    expect(checkTruthChain(written.map((l) => decodeTruthLine(l)))).toEqual([]);
    expect(second.head).toEqual({ seq: 2, hash: JSON.parse(written[1]).hash });
  });

  it('does not propose tautologies ("postgres is postgres.")', async () => {
    const state = await new DefaultCompactor().compact(history('We chose postgres and are using vitest'), 'L3');
    const assertions = proposeInvariants(state, { author: 'johnny' }).map((p) => p.draft.assertion);
    for (const a of assertions) expect(a).not.toMatch(/^(\S+) is \1\.$/i);
  });

  it('refuses to append to a file that is not one valid proposal stream, and leaves it untouched', () => {
    const legacy = join(dir, 'legacy.jsonl');
    const bare = JSON.stringify({ kind: 'uv', draft: uvDraft('Old.'), signal: { source: 'compaction-candidate' }, targetRef: 'a' });
    writeFileSync(legacy, bare + '\n');
    const fresh = [uvProposal(uvDraft('New.'), { targetRef: 'b', detail: 'd' }, { author: 'johnny' })];
    expect(() => appendProposalsFile(legacy, fresh)).toThrow(/new proposals file/);
    expect(readFileSync(legacy, 'utf8')).toBe(bare + '\n');

    const broken = join(dir, 'broken.jsonl');
    const lines = serializeProposals([...fresh, uvProposal(uvDraft('Two.'), { targetRef: 'c', detail: 'd' }, { author: 'johnny' })]);
    writeFileSync(broken, lines[1] + '\n');
    expect(() => appendProposalsFile(broken, fresh)).toThrow(/chain broken|first line/);
  });

  it('an id names one envelope: a different envelope under an id the file holds is refused, the same one is skipped', () => {
    const path = join(dir, 'proposals.jsonl');
    const first = uvProposal(uvDraft('A.'), { targetRef: 'a', detail: 'd' }, { author: 'johnny' });
    appendProposalsFile(path, [first]);
    const before = readFileSync(path, 'utf8');

    // Stenographer's intake files a line once by its id, and refuses a different envelope under a filed id
    const reused = { ...uvProposal(uvDraft('B.'), { targetRef: 'b', detail: 'd' }, { author: 'johnny' }), id: first.id };
    expect(() => appendProposalsFile(path, [reused])).toThrow(/an id names one envelope/);
    // Even when the rest of the batch is new, and when its claim matches what the file holds
    const fresh = uvProposal(uvDraft('C.'), { targetRef: 'c', detail: 'd' }, { author: 'johnny' });
    const retimed = { ...first, ts: '2026-09-02T00:00:00.000Z' };
    expect(() => appendProposalsFile(path, [fresh, retimed])).toThrow(/an id names one envelope/);
    expect(readFileSync(path, 'utf8')).toBe(before);

    // The same envelope, from another stream with its own chain fields, is the same envelope
    const [elsewhere] = serializeProposals([first], { head: { seq: 7, hash: 'a'.repeat(64) } });
    expect(appendProposalsFile(path, [JSON.parse(elsewhere)])).toMatchObject({ written: 0, skipped: 1 });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('a stream never writes two different envelopes under one id', () => {
    const a = uvProposal(uvDraft('A.'), { targetRef: 'a', detail: 'd' }, { author: 'johnny' });
    const b = { ...uvProposal(uvDraft('B.'), { targetRef: 'b', detail: 'd' }, { author: 'johnny' }), id: a.id };
    expect(() => serializeProposals([a, b])).toThrow(/an id names one envelope/);
    const resumed = ProposalStream.resume(serializeProposals([a]));
    expect(() => resumed.append(b)).toThrow(/an id names one envelope/);
    expect(resumed.head?.seq).toBe(1);
  });

  it('a stream writes the same envelope again as a new line; only appendProposalsFile skips it (SH-SYNC-R1)', () => {
    const a = uvProposal(uvDraft('A.'), { targetRef: 'a', detail: 'd' }, { author: 'johnny' });
    // ProposalStream.append and serializeProposals chain it again under its id, with the next seq
    const lines = serializeProposals([a, a]);
    expect(lines.map((l) => JSON.parse(l))).toMatchObject([
      { seq: 1, id: a.id },
      { seq: 2, id: a.id },
    ]);
    const third = ProposalStream.resume(lines).append(a);
    expect(third).toMatchObject({ seq: 3, id: a.id });
    // which readers take as one valid stream (stenographer's intake files the id once)
    const read = parseProposalLines([...lines, JSON.stringify(third)]);
    expect(read).toMatchObject({ errors: [], refused: false });
    expect(read.proposals.map((p) => p.id)).toEqual([a.id, a.id, a.id]);

    // appendProposalsFile skips it, from the file or within the batch
    const path = join(dir, 'proposals.jsonl');
    expect(appendProposalsFile(path, [a, a])).toMatchObject({ written: 1, skipped: 1 });
    expect(appendProposalsFile(path, [a])).toMatchObject({ written: 0, skipped: 1 });
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('ProposalStream.resume continues the file it read', () => {
    const lines = serializeProposals([uvProposal(uvDraft('A.'), { targetRef: 'a', detail: 'd' }, { author: 'johnny' })]);
    const stream = ProposalStream.resume(lines);
    const next = stream.append(uvProposal(uvDraft('B.'), { targetRef: 'b', detail: 'd' }, { author: 'johnny' }));
    expect(next).toMatchObject({ seq: 2, prevHash: JSON.parse(lines[0]).hash });
    expect(stream.head).toEqual({ seq: 2, hash: next.hash });
  });
});

describe('reading proposals: the suite envelope, and the bare format as read-only compatibility', () => {
  it('reads bare short-hand lines and the retired shorthand-compaction source, normalizing the kind', () => {
    const bareTb = JSON.stringify({
      kind: 'tombstone',
      draft: { claim: 'X is dead.', evidence: [{ kind: 'message', ref: 'm1' }], signedBy: null },
      signal: { source: 'compaction-candidate' },
      targetRef: 'shorthand:tombstone:m1',
    });
    const vendored = JSON.stringify({
      type: 'PROPOSAL',
      id: '01J9VENDORED000000000000000',
      ts: '2026-01-01T00:00:00.000Z',
      author: 'johnny',
      kind: 'uv',
      draft: uvDraft('Y holds.'),
      signal: { source: 'shorthand-compaction' },
    });
    const result = parseProposalLines([bareTb, vendored]);
    expect(result.errors).toEqual([]);
    expect(result.proposals.map((p) => [p.kind, p.version, p.targetRef])).toEqual([
      ['tb', 'bare', 'shorthand:tombstone:m1'],
      ['uv', 'bare', null],
    ]);
    expect(result.proposals.map((p) => p.text)).toEqual([bareTb, vendored]);
  });

  it('skips blank lines and counts them in line numbers', () => {
    const lines = serializeProposals([
      uvProposal(uvDraft('A.'), { targetRef: 'a', detail: 'd' }, { author: 'johnny' }),
      uvProposal(uvDraft('B.'), { targetRef: 'b', detail: 'd' }, { author: 'johnny' }),
    ]);
    const read = parseProposalLines(['', lines[0], '  ', lines[1]]);
    expect(read.errors).toEqual([]);
    expect(read.proposals.map((p) => p.line)).toEqual([2, 4]);
    const edited = JSON.stringify({ ...JSON.parse(lines[1]), targetRef: 'z' });
    expect(parseProposalLines(`${lines[0]}\n\n${edited}\n`).errors).toMatchObject([{ line: 3, error: expect.stringMatching(/^hash mismatch/) }]);
  });

  it('refuses a stream with a bare line slipped into it', () => {
    const lines = serializeProposals([uvProposal(uvDraft('A.'), { targetRef: 'a', detail: 'd' }, { author: 'johnny' })]);
    const bareUv = JSON.stringify({ kind: 'uv', draft: uvDraft('Injected.'), signal: { source: 'compaction-candidate' } });
    const result = parseProposalLines([...lines, bareUv]);
    expect(result.refused).toBe(true);
    expect(result.proposals).toEqual([]);
    expect(result.errors[0]).toMatchObject({ line: 2 });
  });
});

function uvDraft(assertion: string) {
  return { assertion, basis: 'compaction', verifyBy: { kind: 'inspect' as const, value: 'message:m1' } };
}

function stubSnapshot() {
  return {
    sessionId: 's',
    level: 'L3' as const,
    roundNumber: 1,
    summary: '',
    entities: [{ name: 'db', type: 'configuration' as const, firstMention: 'm1', lastMention: 'm1', value: 'postgres', corrections: [] }],
    decisions: [],
    tombstones: [],
    originalTokenCount: 0,
    compactedTokenCount: 0,
    compactedAt: 0,
  } as unknown as Parameters<typeof proposeInvariants>[0];
}
