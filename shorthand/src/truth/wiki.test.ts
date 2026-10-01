import { describe, expect, it } from 'vitest';
import {
  classifyEntry,
  entryToWikiLine,
  literalValidationError,
  parseWikiLines,
  selectCurrentTruth,
  serializeWikiEntries,
  wikiLineToEntry,
} from './wiki.js';
import type { TruthTbEntry, TruthUvEntry, WikiEntryLine } from './types.js';
import { ulid } from './types.js';
import { assertAccountableAuthor, isAnonymousIdentity } from './identity.js';
import { chainTruthLines } from './format.js';

// ---------------------------------------------------------------------------
// Fixtures — version 1 lines, shaped like stenographer 0.x's export (the
// v2 stream is covered by wiki-v2.test.ts and conformance.test.ts)
// ---------------------------------------------------------------------------

const tbLine: WikiEntryLine = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAA1',
  type: 'TB',
  ts: '2026-09-18T10:00:00.000Z',
  author: 'johnny',
  claim: 'The REST fallback path is dead; all traffic goes through MCP.',
  evidence: [{ kind: 'commit', ref: 'abc1234', detail: 'removed rest-fallback.ts' }],
  signedBy: 'johnny',
  status: 'active',
  'x-steno': {
    origin: 'local',
    provenance: { kind: 'commitSha', ref: 'abc1234' },
    agentSessionId: null,
    links: [],
  },
};

const uvLine: WikiEntryLine = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAA2',
  type: 'UV',
  ts: '2026-09-18T11:00:00.000Z',
  author: 'sam',
  assertion: 'The embedder cache is safe to share across worker threads.',
  basis: 'No crash observed in three weeks of soak testing.',
  verifyBy: { kind: 'command', value: 'npm run test -- embedding' },
  contests: null,
  status: 'open',
  'x-steno': {
    origin: 'wiki',
    provenance: { kind: 'manual' },
    agentSessionId: null,
    links: [],
  },
};

const lines = [JSON.stringify(tbLine), JSON.stringify(uvLine)];

// ---------------------------------------------------------------------------
// Round trip — the seam's release gate
// ---------------------------------------------------------------------------

describe('wiki JSONL round trip', () => {
  it('import(export(entries)) preserves every field including x-steno', () => {
    const { entries, errors } = parseWikiLines(lines);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(2);

    const reserialized = serializeWikiEntries(entries);
    const reparsed = reserialized.map((l) => JSON.parse(l) as WikiEntryLine);
    expect(reparsed[0]).toEqual(tbLine);
    expect(reparsed[1]).toEqual(uvLine);
  });

  it('single-entry conversion is symmetric', () => {
    const entry = wikiLineToEntry(tbLine);
    expect(entryToWikiLine(entry)).toEqual(tbLine);
  });

  it('later lines for the same id supersede earlier ones (append-only)', () => {
    const overridden = JSON.stringify({ ...tbLine, status: 'overridden' });
    const { entries } = parseWikiLines([...lines, overridden]);
    expect(entries).toHaveLength(2);
    const tb = entries.find((e) => e.id === tbLine.id) as TruthTbEntry;
    expect(tb.status).toBe('overridden');
  });

  it('collects per-line errors without dropping the rest of the file', () => {
    const { entries, errors } = parseWikiLines(['not json', '', ...lines, '{"type":"RULING","id":"x","status":"active"}']);
    expect(entries).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(errors[1].error).toContain('a version 1 line is a TB or UV');
  });
});

// ---------------------------------------------------------------------------
// Consumption rules (§7)
// ---------------------------------------------------------------------------

describe('consumption rules', () => {
  it('classifies each lifecycle state per §7', () => {
    // A v1 TB carries no hash: it is truth only when the host opts in
    expect(classifyEntry(wikiLineToEntry(tbLine))).toBe('history');
    const tb = wikiLineToEntry(tbLine, { admitV1Tbs: true }) as TruthTbEntry;
    const uv = wikiLineToEntry(uvLine) as TruthUvEntry;

    expect(classifyEntry(tb)).toBe('ground-truth');
    expect(classifyEntry({ ...tb, status: 'contested' })).toBe('contested');
    expect(classifyEntry({ ...tb, status: 'overridden' })).toBe('history');
    expect(classifyEntry(uv)).toBe('flag');
    expect(classifyEntry({ ...uv, status: 'refuted' })).toBe('history');
    expect(classifyEntry({ ...uv, status: 'verified' })).toBe('history');
  });

  it('pairs contested TBs with their live contesting UVs', () => {
    const tb = { ...(wikiLineToEntry(tbLine, { admitV1Tbs: true }) as TruthTbEntry), status: 'contested' as const };
    const contestingUv: TruthUvEntry = {
      ...(wikiLineToEntry(uvLine) as TruthUvEntry),
      id: '01JAAAAAAAAAAAAAAAAAAAAAA3',
      assertion: 'The REST fallback still serves the legacy iOS client.',
      contests: tb.id,
    };
    const standaloneUv = wikiLineToEntry(uvLine) as TruthUvEntry;

    const selection = selectCurrentTruth([tb, contestingUv, standaloneUv]);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.contested).toHaveLength(1);
    expect(selection.contested[0].tombstone.id).toBe(tb.id);
    expect(selection.contested[0].contestedBy.map((u) => u.id)).toEqual([contestingUv.id]);
    // Both open UVs are unverified; the contesting one also rides its TB.
    expect(selection.unverified.map((u) => u.id).sort()).toEqual(
      [contestingUv.id, standaloneUv.id].sort(),
    );
    expect(selection.history).toEqual([]);
  });

  it('excludes overridden TBs and refuted UVs from current truth', () => {
    const tb = { ...(wikiLineToEntry(tbLine) as TruthTbEntry), status: 'overridden' as const };
    const uv = { ...(wikiLineToEntry(uvLine) as TruthUvEntry), status: 'refuted' as const };
    const selection = selectCurrentTruth([tb, uv]);
    expect(selection.groundTruth).toEqual([]);
    expect(selection.unverified).toEqual([]);
    expect(selection.history.map((e) => e.id).sort()).toEqual([tb.id, uv.id].sort());
  });
});

// ---------------------------------------------------------------------------
// Authorship floor & ULID
// ---------------------------------------------------------------------------

describe('authorship', () => {
  it('rejects generic identities at the schema level', () => {
    for (const bad of ['system', 'assistant', ' AGENT ', '', 'anonymous']) {
      expect(isAnonymousIdentity(bad)).toBe(true);
      expect(() => assertAccountableAuthor(bad)).toThrow(/anonymous or generic/);
    }
    expect(isAnonymousIdentity('johnny')).toBe(false);
    expect(() => assertAccountableAuthor('johnny')).not.toThrow();
  });
});

describe('ulid', () => {
  it('is 26 chars, sortable, and monotonic within a millisecond', () => {
    const a = ulid(1_726_000_000_000);
    const b = ulid(1_726_000_000_000);
    expect(a).toHaveLength(26);
    expect(b).toHaveLength(26);
    expect(b > a).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tombstoned literals (§12) — what real-time objections cite
// ---------------------------------------------------------------------------

describe('tombstoned literals', () => {
  const withLiterals: WikiEntryLine = {
    ...tbLine,
    id: '01JAAAAAAAAAAAAAAAAAAAAAA3',
    literals: [
      { subject: 'LOG_BUDGET', dead: '30', current: '100' },
      { dead: 'legacyRateLimiter', current: 'TokenBucket' },
    ],
  };

  it('round-trips literals losslessly', () => {
    const { entries, errors } = parseWikiLines([JSON.stringify(withLiterals)]);
    expect(errors).toEqual([]);
    const tb = entries[0] as TruthTbEntry;
    expect(tb.literals).toEqual(withLiterals.literals);
    const [back] = serializeWikiEntries(entries);
    expect(JSON.parse(back)).toEqual(withLiterals);
  });

  it('keeps literal-free TBs in their exact shape', () => {
    const entry = wikiLineToEntry(tbLine) as TruthTbEntry;
    expect(entry.literals).toBeUndefined();
    expect('literals' in entryToWikiLine(entry)).toBe(false);
  });

  it('rejects a line whose literals cannot be matched, like stenographer', () => {
    const bad = { ...withLiterals, id: 'BAD', literals: [{ dead: '30' }] };
    const { entries, errors } = parseWikiLines([JSON.stringify(bad), JSON.stringify(tbLine)]);
    expect(entries.map((e) => e.id)).toEqual([tbLine.id]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: 'BAD', error: expect.stringMatching(/^literals\.0: .*distinctive identifier/) });
  });

  it('applies stenographer\'s write-time rule', () => {
    expect(literalValidationError({ subject: 'LOG_BUDGET', dead: '30' })).toBeNull();
    expect(literalValidationError({ dead: 'legacyRateLimiter' })).toBeNull();
    expect(literalValidationError({ dead: '30' })).toMatch(/distinctive identifier/);
    expect(literalValidationError({ dead: 'abc' })).toMatch(/distinctive identifier/);
    expect(literalValidationError({ dead: '1234' })).toMatch(/distinctive identifier/);
    expect(literalValidationError({ dead: ' ' })).toMatch(/dead value/);
    expect(literalValidationError({ dead: 'x', subject: '' })).toMatch(/subject/);
    expect(literalValidationError({ dead: 'legacyThing', current: 5 })).toMatch(/current/);
    expect(literalValidationError('30')).toMatch(/object/);
  });
});

// ---------------------------------------------------------------------------
// Fail closed (carried from short-hand; smallchat's fork coerced unknown or
// missing statuses to 'active' — SAT-09)
// ---------------------------------------------------------------------------

describe('fail-closed status handling', () => {
  it('never treats an unknown TB status as ground truth, and keeps it verbatim', () => {
    const { entries, errors } = parseWikiLines([JSON.stringify({ ...tbLine, status: 'retracted' })], { admitV1Tbs: true });
    expect(errors).toEqual([]);
    const tb = entries[0] as TruthTbEntry;
    expect(tb.status).toBe('retracted');
    expect(classifyEntry(tb)).toBe('history');
    expect(selectCurrentTruth(entries).groundTruth).toEqual([]);
    expect(JSON.parse(serializeWikiEntries(entries)[0]).status).toBe('retracted');
  });

  it('never treats an unknown UV status as an open flag', () => {
    const { entries } = parseWikiLines([JSON.stringify({ ...uvLine, status: 'pending-review' })]);
    expect(classifyEntry(entries[0])).toBe('history');
    expect(selectCurrentTruth(entries).unverified).toEqual([]);
  });

  it('classifies a struck TB as history', () => {
    const { entries } = parseWikiLines([JSON.stringify({ ...tbLine, status: 'struck' })]);
    expect(classifyEntry(entries[0])).toBe('history');
  });

  it('keeps a line with no status as history (status null) instead of defaulting it to active', () => {
    const { status: _status, ...noStatus } = tbLine;
    const { entries, errors } = parseWikiLines([JSON.stringify(noStatus), JSON.stringify(uvLine)], { admitV1Tbs: true });
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.id, e.status])).toEqual([[tbLine.id, null], [uvLine.id, 'open']]);
    expect(classifyEntry(entries[0])).toBe('history');
    expect(serializeWikiEntries(entries)[0]).toBe(JSON.stringify(noStatus));
  });

  it('rejects a TB without a claim and a UV without an assertion', () => {
    const { claim: _claim, ...noClaim } = tbLine;
    const { assertion: _assertion, ...noAssertion } = uvLine;
    const { entries, errors } = parseWikiLines([JSON.stringify(noClaim), JSON.stringify(noAssertion)]);
    expect(entries).toEqual([]);
    expect(errors.map((e) => e.error)).toEqual(['claim: must be a non-empty string', 'assertion: must be a non-empty string']);
  });

  it('rejects a line that is not a JSON object', () => {
    const { errors } = parseWikiLines(['[1,2]', '"x"']);
    expect(errors.map((e) => e.error)).toEqual(['a line is a JSON object', 'a line is a JSON object']);
  });
});

describe('lossless round trip of fields short-hand does not interpret', () => {
  it('preserves unknown top-level keys verbatim, beside the v2 chain fields', () => {
    const { status: _s, ...body } = tbLine;
    const [line] = chainTruthLines([{ ...body, status: 'active', 'x-other': { a: 1 }, reviewers: ['sam'] }]);
    const { entries, errors } = parseWikiLines([line]);
    expect(errors).toEqual([]);
    expect(entries[0].extra).toEqual({ schemaVersion: 2, seq: 1, prevHash: null, hash: JSON.parse(line).hash, 'x-other': { a: 1 }, reviewers: ['sam'] });
    expect(serializeWikiEntries(entries)).toEqual([line]);
  });
});
