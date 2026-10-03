/**
 * Agents settle claims only together (spec/truth-format: "Evidence
 * classes", "Agent quorum", "Identities"), as a reader sees it.
 *
 * The user's rule, verbatim: "agents can only settle claims together,
 * meaning 2 or more agreeing from different angles at the same time". A
 * reader refuses a line whose `quorum` breaks the rules (line-local, like
 * the link rules), and does not take a TB an agent signed as truth unless
 * it carries a quorum of agents. The rule tests run the cases stenographer's
 * own checkQuorum tests run, against this codec, so the two codecs are
 * checked against each other as well as against the golden fixtures.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainTruthLines } from './format.js';
import {
  CONSUMPTION_RULES,
  EVIDENCE_KINDS,
  QUORUM_MIN_MEMBERS,
  QUORUM_WINDOW_MS,
  SETTLING_EVIDENCE_KINDS,
  TruthLineError,
  checkQuorum,
  classifyEntry,
  createSignerRegistry,
  decodeTruthLine,
  entryToWikiLine,
  evidenceClass,
  parseWikiLines,
  serializeWikiEntries,
  truthLineHash,
  wikiLineToEntry,
  writeWikiFile,
  type TruthQuorumMember,
  type TruthTbEntry,
} from './index.js';

const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

const COMMIT = { kind: 'commit', ref: 'a1b2c3', detail: 'config.ts sets LOG_BUDGET = 100' };
const FILE = { kind: 'file', ref: 'config.ts:3', detail: 'LOG_BUDGET = 100' };
const TEST = { kind: 'test', ref: 'test/config.test.ts', detail: 'budget is 100' };

const AGENT = 'agent:claude-code';
const LITERALS = [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }, { dead: 'legacyRateLimiter' }];

describe('evidence classes (spec: Evidence classes)', () => {
  it('knows chat, ticket and doc, and classes every kind as settling or question', () => {
    expect([...EVIDENCE_KINDS]).toEqual(['commit', 'file', 'test', 'command', 'claimed-command', 'wiki', 'message', 'chat', 'ticket', 'doc']);
    expect([...SETTLING_EVIDENCE_KINDS]).toEqual(['commit', 'file', 'test', 'claimed-command', 'wiki']);
    for (const kind of SETTLING_EVIDENCE_KINDS) expect(evidenceClass(kind), kind).toBe('settling');
    // What someone said or wrote down, and pre-1.0 command output nobody re-ran
    for (const kind of ['message', 'chat', 'ticket', 'doc', 'command']) expect(evidenceClass(kind), kind).toBe('question');
  });

  it('fails closed: a kind this version does not know is question-class', () => {
    for (const kind of ['screenshot', 'benchmark', 'Commit', ' commit', '']) expect(evidenceClass(kind), JSON.stringify(kind)).toBe('question');
  });

  it('reads chat, ticket and doc evidence on a version 1 line, which is validated like a live write', () => {
    const v1 = (kind: string) =>
      JSON.stringify({ id: 'TB1', type: 'TB', ts: at(0), author: 'kim', claim: 'x is dead', evidence: [{ kind, ref: 'r1' }], signedBy: 'kim' });
    for (const kind of ['chat', 'ticket', 'doc']) expect(decodeTruthLine(v1(kind)).version, kind).toBe(1);
    expect(() => decodeTruthLine(v1('screenshot'))).toThrow(/not an evidence kind a version 1 line could carry/);
  });

  it("classes a version 1 line's command evidence by the line's own kind: the typed entry reads it as claimed-command", () => {
    // Stenographer 1.0 reads v1 command evidence as claimed-command (spec: Version 1 lines), and so does the
    // typed entry; the class of what the line says is pre-1.0 command, which is question-class
    const v1 = JSON.stringify({ id: 'TB1', type: 'TB', ts: at(0), author: 'kim', claim: 'x is dead', evidence: [{ kind: 'command', ref: 'grep -r x' }], signedBy: 'kim' });
    const entry = parseWikiLines([v1], { admitV1Tbs: true }).entries[0] as TruthTbEntry;
    expect(entry.evidence.map((e) => e.kind)).toEqual(['claimed-command']);
    const asWritten = (JSON.parse(entry.source!.text) as { evidence: Array<{ kind: string }> }).evidence;
    expect(asWritten.map((e) => [e.kind, evidenceClass(e.kind)])).toEqual([['command', 'question']]);
  });
});

describe('checkQuorum: the rules a line with a quorum must keep', () => {
  const member = (over: Partial<TruthQuorumMember> = {}): TruthQuorumMember => ({
    author: AGENT,
    agentSessionId: 'sess-a',
    ts: at(0),
    evidence: [{ kind: 'commit', ref: 'a1b2c3' }],
    verdict: 'verified',
    ...over,
  });
  const second = (over: Partial<TruthQuorumMember> = {}) =>
    member({ agentSessionId: 'sess-b', ts: at(5 * MIN), evidence: [{ kind: 'file', ref: 'config.ts:3' }], ...over });
  // An ADDENDUM's links are the ones its x-steno.links lists starting at its id
  const linked = (...types: string[]) => ({ 'x-steno': { links: types.map((type, i) => ({ fromId: 'ADD1', toId: `UV${i + 1}`, type })) } });
  const addendum = (over: Record<string, unknown> = {}) => {
    const quorum = (over.quorum as TruthQuorumMember[] | undefined) ?? [member(), second()];
    return {
      type: 'ADDENDUM',
      id: 'ADD1',
      author: AGENT,
      ts: at(5 * MIN),
      evidence: quorum.flatMap((m) => m.evidence),
      quorum,
      ...linked('verifies'),
      ...over,
    };
  };
  const tbOf = (a: TruthQuorumMember, b: TruthQuorumMember, over: Record<string, unknown> = {}) => {
    const { verdict: _a, ...x } = a;
    const { verdict: _b, ...y } = b;
    return { type: 'TB', author: AGENT, signedBy: AGENT, ts: at(5 * MIN), evidence: [...x.evidence, ...y.evidence], quorum: [x, y], literals: LITERALS, ...over };
  };

  it('passes two sessions agreeing from different angles at the same time', () => {
    expect(QUORUM_MIN_MEMBERS).toBe(2);
    expect(QUORUM_WINDOW_MS).toBe(900_000);
    expect(checkQuorum(addendum())).toEqual([]);
    // Two sessions may share one identity: distinct sessions are distinct witnesses
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'Agent:Claude-Code' })] }))).toEqual([]);
    // A TB: no verdicts; signed by its author
    expect(checkQuorum(tbOf(member(), second()))).toEqual([]);
  });

  it('rule 1: two or more members, from distinct sessions, each an accountable identity', () => {
    const one = [member()];
    expect(checkQuorum(addendum({ quorum: one, evidence: one[0].evidence })).join()).toMatch(/at least 2 members.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: 'sess-a' })] })).join()).toMatch(/share agent session sess-a.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: '  ' })] })).join()).toMatch(/agent session.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'Assistant' })] })).join()).toMatch(/anonymous.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'detector:x' })] })).join()).toMatch(/reserved.*rule 1/);
    expect(checkQuorum(addendum({ quorum: [member(), second({ author: 'agent:x\u0007' })] })).join()).toMatch(/control character.*rule 1/);
  });

  it('rule 1: sessions compare trimmed of Unicode White_Space, and only of it', () => {
    for (const spelling of [' sess-a', 'sess-a\t', ' sess-a　', '\u0085sess-a']) {
      expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: spelling })] })).join(), JSON.stringify(spelling)).toMatch(
        /share agent session sess-a.*rule 1/,
      );
    }
    // U+FEFF is not White_Space: another session id (String.prototype.trim would have removed it)
    expect(checkQuorum(addendum({ quorum: [member(), second({ agentSessionId: 'sess-a﻿' })] }))).toEqual([]);
  });

  it('rule 2: the writer is a member, and a TB is signed by its author', () => {
    expect(checkQuorum(addendum({ author: 'agent:other' })).join()).toMatch(/agent:other is not a quorum member.*rule 2/);
    expect(checkQuorum(tbOf(member(), second(), { signedBy: 'kim' })).join()).toMatch(/signed by its author.*rule 2/);
    expect(checkQuorum(tbOf(member(), second(), { signedBy: null })).join()).toMatch(/signed by its author.*rule 2/);
    // signedBy compares with the author by key, like every identity
    expect(checkQuorum(tbOf(member(), second(), { signedBy: 'AGENT:CLAUDE-CODE' }))).toEqual([]);
  });

  it('rule 3: from different angles — settling evidence each, no item shared, two settling kinds', () => {
    const chat = second({ evidence: [{ kind: 'chat', ref: 'slack:C01/p17' }] });
    expect(checkQuorum(addendum({ quorum: [member({ evidence: [COMMIT, TEST] }), chat] })).join()).toMatch(/member 2 cites no settling evidence.*rule 3/);
    // Items compare by kind and ref, the ref trimmed
    const shared = second({ evidence: [{ kind: 'commit', ref: ' a1b2c3 ' }, { kind: 'file', ref: 'config.ts:3' }] });
    expect(
      checkQuorum(addendum({ quorum: [member(), shared], evidence: [{ kind: 'commit', ref: 'a1b2c3' }, { kind: 'file', ref: 'config.ts:3' }] })).join(),
    ).toMatch(/both cite commit a1b2c3.*rule 3/);
    const oneKind = second({ evidence: [{ kind: 'commit', ref: 'd4e5f6' }] });
    expect(checkQuorum(addendum({ quorum: [member(), oneKind] })).join()).toMatch(/two settling kinds.*rule 3/);
    // Question-class evidence only: message, chat, ticket, doc, pre-1.0 command
    for (const kind of ['message', 'chat', 'ticket', 'doc', 'command']) {
      const q = [member({ evidence: [{ kind, ref: 'x1' }] }), second({ evidence: [{ kind, ref: 'x2' }] })];
      expect(checkQuorum(addendum({ quorum: q })).join(), kind).toMatch(/cites no settling evidence.*rule 3/);
    }
  });

  it('rule 3: a kind the reader does not know is an unknown value, not a broken rule', () => {
    // A newer writer's settling kind, perhaps: this reader can't tell, so rule 3 doesn't refuse the line over it
    const bench = { kind: 'benchmark', ref: 'bench/retry' };
    expect(
      checkQuorum(addendum({ quorum: [member({ evidence: [{ kind: 'commit', ref: 'a1b2c3' }, { kind: 'file', ref: 'x.ts:1' }] }), second({ evidence: [bench] })] })),
    ).toEqual([]);
    expect(checkQuorum(addendum({ quorum: [member(), second({ evidence: [{ kind: 'commit', ref: 'd4e5f6' }, bench] })] }))).toEqual([]);
    // ...but the rules it can read still hold: an item two members cite, whatever its kind
    expect(
      checkQuorum(
        addendum({ quorum: [member({ evidence: [{ kind: 'commit', ref: 'a1b2c3' }, bench] }), second({ evidence: [{ kind: 'file', ref: 'f' }, bench] })] }),
      ).join(),
    ).toMatch(/both cite benchmark bench\/retry.*rule 3/);
  });

  it('rule 3: the same evidence in another spelling is one angle (refs compare normalized for their kind)', () => {
    const test = { kind: 'test', ref: 'test/a.test.ts' };
    const file = { kind: 'file', ref: 'src/b.ts:1' };
    const twice = (a: { kind: string; ref: string }, b: { kind: string; ref: string }) =>
      checkQuorum(addendum({ quorum: [member({ evidence: [a, test] }), second({ evidence: [b, file] })] })).join();
    const same: Array<[string, string, string]> = [
      ['commit', 'a1b2c3d', 'A1B2C3D'],
      ['commit', 'a1b2c3d', 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e'],
      ['commit', ' a1b2c3d ', 'a1b2c3d'],
      ['file', 'src/retry.ts:10', './src/retry.ts:10'],
      ['file', 'src/retry.ts:10', 'src//retry.ts:10'],
      ['file', 'src/retry.ts:10', 'src\\retry.ts:10'],
      ['file', 'src/retry.ts:10', 'src/./retry.ts:10'],
      ['test', 'retry budget is per tenant', 'retry  budget is\tper tenant'],
      ['claimed-command', 'grep -n LOG_BUDGET config.ts', 'grep  -n LOG_BUDGET\tconfig.ts'],
    ];
    for (const [kind, a, b] of same) {
      expect(twice({ kind, ref: a }, { kind, ref: b }), `${kind}: ${JSON.stringify(a)} and ${JSON.stringify(b)}`).toMatch(/both cite.*rule 3/);
    }
    const different: Array<[string, string, string]> = [
      ['commit', 'a1b2c3d', 'b1b2c3d'],
      ['file', 'src/retry.ts:10', 'src/retry.ts:12'],
      ['file', 'src/retry.ts', 'lib/src/retry.ts'],
      ['file', '/src/retry.ts', 'src/retry.ts'],
      ['test', 'retry budget', 'Retry budget'],
      // U+FEFF is not White_Space, so it is not trimmed
      ['wiki', '01J9ABC', '01J9ABC﻿'],
    ];
    for (const [kind, a, b] of different) {
      expect(twice({ kind, ref: a }, { kind, ref: b }), `${kind}: ${JSON.stringify(a)} and ${JSON.stringify(b)}`).not.toMatch(/both cite/);
    }
  });

  it('rule 4: every member and the line within 15 minutes of each other', () => {
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: at(15 * MIN) })], ts: at(15 * MIN) }))).toEqual([]);
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: at(15 * MIN + 1) })], ts: at(15 * MIN + 1) })).join()).toMatch(
      /more than 15 minutes.*rule 4/,
    );
    // The line's own ts counts too
    expect(checkQuorum(addendum({ ts: at(20 * MIN) })).join()).toMatch(/rule 4/);
    // Offsets are read as the instants they name
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: '2026-09-01T14:05:00.000+02:00' })] }))).toEqual([]);
    // To the millisecond: digits past the third fractional digit are dropped, not rounded
    const subMs = '2026-09-01T12:15:00.0009Z';
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: subMs })], ts: subMs }))).toEqual([]);
    const pastEdge = '2026-09-01T12:15:00.001Z';
    expect(checkQuorum(addendum({ quorum: [member(), second({ ts: pastEdge })], ts: pastEdge })).join()).toMatch(/900001 ms.*rule 4/);
  });

  it('rule 5: agreeing — every verdict is the one the link applies, and a quorum never overrides', () => {
    expect(checkQuorum(addendum({ quorum: [member(), second({ verdict: 'refuted' })] })).join()).toMatch(/verdict refuted.*verifies.*rule 5/);
    expect(checkQuorum(addendum(linked('refutes'))).join()).toMatch(/rule 5/);
    expect(checkQuorum(addendum(linked('verifies', 'overrides'))).join()).toMatch(/never overrides.*rule 5/);
    // A line that lists no resolution link (no x-steno.links, an empty list, or only types the reader doesn't
    // know) is checked for agreeing verdicts only
    for (const xSteno of [undefined, {}, { links: [] }, linked('corroborates')['x-steno']]) {
      const subject = { ...addendum(), 'x-steno': xSteno };
      expect(checkQuorum(subject), JSON.stringify(xSteno)).toEqual([]);
      expect(checkQuorum({ ...subject, quorum: [member(), second({ verdict: 'refuted' })] }).join(), JSON.stringify(xSteno)).toMatch(/disagree.*rule 5/);
    }
  });

  it('rule 5: a quorum TB carries the literals its members agreed on (at least one)', () => {
    const tb = tbOf(member(), second());
    const { literals: _l, ...without } = tb;
    expect(checkQuorum(without).join()).toMatch(/literals.*rule 5/);
    expect(checkQuorum({ ...tb, literals: [] }).join()).toMatch(/literals.*rule 5/);
    expect(checkQuorum(tb)).toEqual([]);
  });

  it("rule 6: the line shows its evidence — the members' items, and only theirs", () => {
    expect(checkQuorum(addendum({ evidence: [{ kind: 'commit', ref: 'a1b2c3' }] })).join()).toMatch(/lacks quorum member 2's file config\.ts:3.*rule 6/);
    const extra = [{ kind: 'commit', ref: 'a1b2c3' }, { kind: 'file', ref: 'config.ts:3' }, { kind: 'test', ref: 't' }];
    expect(checkQuorum(addendum({ evidence: extra })).join()).toMatch(/test t, which no quorum member cites.*rule 6/);
  });

  it('appears only on a TB or an ADDENDUM', () => {
    for (const type of ['UV', 'RULING', 'TRANSITION', 'PROPOSAL']) {
      expect(checkQuorum({ ...addendum(), type }).join(), type).toMatch(/only on TB and ADDENDUM lines/);
    }
  });

  it("reads an ADDENDUM's links from x-steno.links: those it writes", () => {
    const line = addendum({ quorum: [member({ verdict: 'refuted' }), second({ verdict: 'refuted' })] });
    const refutes = { ...line, 'x-steno': { links: [{ fromId: 'ADD1', toId: 'UV1', type: 'refutes' }] } };
    expect(checkQuorum(refutes)).toEqual([]);
    const verifies = { ...refutes, 'x-steno': { links: [{ fromId: 'ADD1', toId: 'UV1', type: 'verifies' }] } };
    expect(checkQuorum(verifies).join()).toMatch(/verdict refuted.*verifies.*rule 5/);
    // A link that starts at another entry is not one this line writes
    expect(checkQuorum({ ...refutes, 'x-steno': { links: [{ fromId: 'ADD2', toId: 'UV1', type: 'verifies' }] } })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The codec: a line whose quorum breaks a rule is refused
// ---------------------------------------------------------------------------

const quorumTb = (over: Record<string, unknown> = {}) => ({
  id: 'TBQ1',
  type: 'TB',
  ts: at(5 * MIN),
  author: AGENT,
  claim: 'LOG_BUDGET 30 is dead.',
  evidence: [COMMIT, FILE],
  signedBy: AGENT,
  literals: LITERALS,
  quorum: [
    { author: AGENT, agentSessionId: 'sess-a', ts: at(0), evidence: [COMMIT] },
    { author: AGENT, agentSessionId: 'sess-b', ts: at(5 * MIN), evidence: [FILE] },
  ],
  status: 'active',
  ...over,
});

const quorumAddendum = (over: Record<string, unknown> = {}) => ({
  id: 'ADDQ1',
  type: 'ADDENDUM',
  ts: at(5 * MIN),
  author: AGENT,
  evidence: [COMMIT, TEST],
  note: null,
  quorum: [
    { author: AGENT, agentSessionId: 'sess-a', ts: at(0), evidence: [COMMIT], verdict: 'verified' },
    { author: AGENT, agentSessionId: 'sess-b', ts: at(5 * MIN), evidence: [TEST], verdict: 'verified' },
  ],
  'x-steno': { links: [{ fromId: 'ADDQ1', toId: 'UV1', type: 'verifies' }] },
  ...over,
});

const decode = (body: Record<string, unknown>) => decodeTruthLine(chainTruthLines([body])[0]);

describe('the codec refuses a line whose quorum breaks a rule (spec: Agent quorum)', () => {
  it('reads a TB and an ADDENDUM whose quorum keeps every rule', () => {
    expect(decode(quorumTb())).toMatchObject({ version: 2, type: 'TB' });
    expect(decode(quorumAddendum())).toMatchObject({ version: 2, type: 'ADDENDUM' });
  });

  it('refuses a quorum on any other line, and on a version 1 line', () => {
    const contest = { id: 'UV1', type: 'UV', ts: at(0), author: 'sam', assertion: 'x', basis: 'y', verifyBy: { kind: 'ask', value: 'ops' }, contests: null };
    expect(() => decode({ ...contest, quorum: quorumTb().quorum })).toThrow(/^quorum: .*only on TB and ADDENDUM lines/);
    const transition = { id: 'C1:TB1', type: 'TRANSITION', ts: at(0), author: 'kim', target: 'TB1', status: 'struck', cause: { kind: 'strike', ref: null } };
    expect(() => decode({ ...transition, quorum: quorumTb().quorum })).toThrow(/only on TB and ADDENDUM lines/);
    const v1 = { id: 'TB1', type: 'TB', ts: at(0), author: 'johnnyclem', claim: 'x is dead', evidence: [COMMIT], signedBy: 'johnnyclem', quorum: quorumTb().quorum };
    expect(() => decodeTruthLine(JSON.stringify(v1))).toThrow(/v1 line carries no quorum/);
  });

  it('refuses each broken rule, naming it', () => {
    const [a, b] = quorumTb().quorum;
    expect(() => decode(quorumTb({ quorum: [a], evidence: [COMMIT] }))).toThrow(/at least 2 members.*rule 1/);
    expect(() => decode(quorumTb({ quorum: [a, { ...b, agentSessionId: 'sess-a ' }] }))).toThrow(/share agent session.*rule 1/);
    expect(() => decode(quorumTb({ signedBy: 'kim' }))).toThrow(/signed by its author.*rule 2/);
    expect(() => decode(quorumTb({ quorum: [a, { ...b, evidence: [{ kind: 'commit', ref: 'D4E5F6' }] }], evidence: [COMMIT, { kind: 'commit', ref: 'D4E5F6' }] }))).toThrow(
      /two settling kinds.*rule 3/,
    );
    expect(() => decode(quorumTb({ quorum: [{ ...a, ts: at(-11 * MIN) }, b] }))).toThrow(/more than 15 minutes.*rule 4/);
    const { literals: _l, ...noLiterals } = quorumTb();
    expect(() => decode(noLiterals)).toThrow(/literals.*rule 5/);
    expect(() => decode(quorumAddendum({ 'x-steno': { links: [{ fromId: 'ADDQ1', toId: 'UV1', type: 'refutes' }] } }))).toThrow(/verdict verified.*refutes.*rule 5/);
    expect(() => decode(quorumTb({ evidence: [COMMIT] }))).toThrow(/lacks quorum member 2's file config\.ts:3.*rule 6/);
  });

  it("refuses a member that isn't shaped as the schema says", () => {
    const [a, b] = quorumAddendum().quorum;
    const { verdict: _v, ...noVerdict } = b;
    expect(() => decode(quorumAddendum({ quorum: [a, noVerdict] }))).toThrow(/verdict is verified or refuted/);
    expect(() => decode(quorumAddendum({ quorum: [a, { ...b, ts: '2026-09-01T23:59:60Z' }] }))).toThrow(/leap second/);
    expect(() => decode(quorumAddendum({ quorum: [a, { ...b, ts: '2026-02-30T00:00:00Z' }] }))).toThrow(/RFC 3339/);
    expect(() => decode(quorumAddendum({ quorum: [a, { ...b, evidence: [{ kind: '', ref: 'x' }] }] }))).toThrow(/quorum\.1\.evidence\.0\.kind/);
    expect(() => decode(quorumAddendum({ quorum: [a, { ...b, evidence: [{ kind: 'test', ref: 'x', detail: 3 }] }] }))).toThrow(/detail/);
    expect(() => decode(quorumAddendum({ quorum: [a, { ...b, evidence: [] }] }))).toThrow(/evidence/);
    expect(() => decode(quorumAddendum({ quorum: { 0: a, 1: b } }))).toThrow(/an array of members/);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 reads x-steno.links: a line's top-level `links` is an unknown field
// ---------------------------------------------------------------------------

describe("rule 5 reads an ADDENDUM's x-steno.links: a top-level links field is an unknown field (spec: Agent quorum, Unknown values)", () => {
  // The lines a three-way differential test found stenographer's codec and this one reading wrongly, against
  // smallchat-swift and the spec, as it wrote them (cases 79, 163, 80, 164 and 81). Each is correctly hashed: a
  // reader that refuses one refuses it for its quorum, and one that takes one checked its hash. Their UV,
  // UV-1, is in no stream here: the rules are line-local
  const probe = (links: unknown, verdict: 'verified' | 'refuted', resolution: 'verifies' | 'refutes', hash: string) =>
    JSON.stringify({
      schemaVersion: 2,
      seq: 1,
      id: 'ADQ',
      type: 'ADDENDUM',
      ts: '2026-09-01T10:14:00.000Z',
      author: 'agent:codex',
      evidence: [
        { kind: 'commit', ref: 'c4fe0b1' },
        { kind: 'file', ref: 'src/api/search.ts:1' },
      ],
      note: null,
      quorum: [
        { author: 'agent:claude-code', agentSessionId: 'sess_a', ts: '2026-09-01T10:13:00.000Z', evidence: [{ kind: 'commit', ref: 'c4fe0b1' }], verdict },
        { author: 'agent:codex', agentSessionId: 'sess_b', ts: '2026-09-01T10:14:00.000Z', evidence: [{ kind: 'file', ref: 'src/api/search.ts:1' }], verdict },
      ],
      links,
      'x-steno': {
        origin: 'local',
        provenance: { kind: 'manual' },
        agentSessionId: 'sess_b',
        targetRef: null,
        links: [{ fromId: 'ADQ', toId: 'UV-1', type: resolution }],
      },
      prevHash: null,
      hash,
    });
  const VERIFIES_UV1 = [{ fromId: 'ADQ', toId: 'UV-1', type: 'verifies' }];
  // Both members say verified, and the line's x-steno link refutes UV-1: rule 5 is broken, whatever links says
  const HIDDEN = [
    ['79', probe(null, 'verified', 'refutes', '9b470f9b4ebd01d35f371b48f8b80ca278830aa01e98deb9b8c9ece3a9361cb1')],
    ['163', probe([], 'verified', 'refutes', '8237234f86768b859133c6e44851ef3a1d0ff68b06d99265f02ca4856e6d8110')],
  ] as const;
  // The verdicts are the ones the line's x-steno links apply: rule 5 is kept, whatever links says
  const KEPT = [
    ['80', probe([{ type: 'overrides' }], 'verified', 'verifies', '64c385fd3b2b076132f836daf923e942defd62877f76b1225181b3ca1f2f3f26')],
    ['164', probe(VERIFIES_UV1, 'refuted', 'refutes', 'ab56c7e44d916541035ec0e5f6b239784b4c40eafa2fb66cf4e4de138e57c5f4')],
    ['81', probe('corroborates', 'verified', 'verifies', '3278f0e12b68aca9ecabfc55bb81846af2ab5f77be87dd5c6bca35dea90ebb68')],
  ] as const;

  it('refuses a quorum ADDENDUM whose verdicts break rule 5 against its x-steno links, whatever a links field says', () => {
    for (const [name, line] of HIDDEN) {
      // Correctly hashed, so it is refused for its quorum alone
      expect(truthLineHash(JSON.parse(line)), name).toBe(JSON.parse(line).hash);
      expect(() => decodeTruthLine(line), name).toThrow(TruthLineError);
      expect(() => decodeTruthLine(line), name).toThrow(/quorum member 1's verdict verified is not the one its line's refutes link applies \(refuted\) \(rule 5\)/);
      expect(() => decodeTruthLine(line), name).toThrow(/quorum member 2's verdict verified is not the one its line's refutes link applies \(refuted\) \(rule 5\)/);
      expect(parseWikiLines([line]).errors.map((e) => e.error), name).toEqual([expect.stringMatching(/^quorum: .*rule 5/)]);
    }
  });

  it('reads a quorum ADDENDUM that keeps rule 5 against its x-steno links, whatever a links field holds', () => {
    for (const [name, line] of KEPT) {
      expect(decodeTruthLine(line), name).toMatchObject({ version: 2, type: 'ADDENDUM', hash: JSON.parse(line).hash });
      // An ADDENDUM changes no status a reader folds, and its unknown field travels with its line
      const result = parseWikiLines([line]);
      expect(result.errors, name).toEqual([]);
      expect(result.entries, name).toEqual([]);
    }
  });

  it("checkQuorum(line) reads the line's x-steno links, never its links field, and never throws on one", () => {
    for (const [name, line] of HIDDEN) {
      expect(checkQuorum(JSON.parse(line)).join(), name).toMatch(/verdict verified is not the one its line's refutes link applies.*rule 5/);
    }
    for (const [name, line] of KEPT) expect(checkQuorum(JSON.parse(line)), name).toEqual([]);
    // Any value a newer writer might put there, on an otherwise valid line
    const line = quorumAddendum();
    for (const links of [null, [], 'corroborates', 7, true, {}, { type: 'overrides' }, [{ type: 'overrides' }], [{ type: 'refutes' }], [null], [7]]) {
      expect(() => checkQuorum({ ...line, links }), JSON.stringify(links)).not.toThrow();
      expect(checkQuorum({ ...line, links }), JSON.stringify(links)).toEqual([]);
      expect(decode({ ...line, links }), JSON.stringify(links)).toMatchObject({ version: 2, type: 'ADDENDUM' });
      // ...and rule 5 still reads the x-steno links beside it
      const refutes = { ...line, links, 'x-steno': { links: [{ fromId: 'ADDQ1', toId: 'UV1', type: 'refutes' }] } };
      expect(() => decode(refutes), JSON.stringify(links)).toThrow(/verdict verified.*refutes.*rule 5/);
    }
  });
});

// ---------------------------------------------------------------------------
// Admission: a TB an agent signs is truth only with a quorum of agents
// ---------------------------------------------------------------------------

describe('reader admission: an agent signs a TB only together with other agent sessions', () => {
  const REGISTRY = { signers: [{ id: 'kim', role: 'human' as const }, { id: 'agent:*', role: 'agent' as const }] };
  const alone = () => {
    const { quorum: _q, ...rest } = quorumTb({ evidence: [COMMIT] });
    return rest;
  };
  const read = (body: Record<string, unknown>, signers: typeof REGISTRY | null = null) => {
    const result = parseWikiLines(chainTruthLines([body]), { signers });
    expect(result.errors).toEqual([]);
    return result.entries[0] as TruthTbEntry;
  };

  it('an agent-signed TB without a quorum is never truth, with or without a registry', () => {
    for (const signers of [null, REGISTRY]) {
      const entry = read(alone(), signers);
      expect(entry.inadmissible).toMatchObject({ reason: 'agent-without-quorum' });
      expect(entry.inadmissible!.detail).toMatch(/no quorum/);
      expect(classifyEntry(entry)).toBe('history');
    }
  });

  it('an agent-signed TB with a valid quorum of agents is ground truth, with or without a registry', () => {
    for (const signers of [null, REGISTRY]) {
      const entry = read(quorumTb(), signers);
      expect(entry.inadmissible).toBeUndefined();
      expect(classifyEntry(entry)).toBe('ground-truth');
    }
  });

  it("a quorum that isn't all agents settles nothing: a person's word is no agent's second witness", () => {
    const [a, b] = quorumTb().quorum;
    const withKim = quorumTb({ quorum: [a, { ...b, author: 'kim' }] });
    for (const signers of [null, REGISTRY]) {
      const entry = read(withKim, signers);
      expect(entry.inadmissible).toMatchObject({ reason: 'agent-without-quorum' });
      expect(entry.inadmissible!.detail).toMatch(/quorum member kim is not an agent/);
    }
  });

  it('with a registry, a member is an agent only when the registry lists it as one: an unlisted agent: name is no witness', () => {
    const registry = { signers: [{ id: 'kim', role: 'human' as const }, { id: 'agent:ci', role: 'agent' as const }] };
    const [a, b] = quorumTb().quorum;
    const ghost = quorumTb({ author: 'agent:ci', signedBy: 'agent:ci', quorum: [{ ...a, author: 'agent:ci' }, { ...b, author: 'agent:ghost' }] });
    const listed = parseWikiLines(chainTruthLines([ghost]), { signers: registry }).entries[0];
    expect(listed.inadmissible).toMatchObject({ reason: 'agent-without-quorum' });
    expect(listed.inadmissible!.detail).toMatch(/agent:ghost/);
    // Without a registry, the agent: prefix is the rule
    expect(classifyEntry(parseWikiLines(chainTruthLines([ghost])).entries[0])).toBe('ground-truth');
  });

  it('with a registry, who is an agent is its role, not the name', () => {
    // An identity listed as a person signs alone, whatever it is called
    const registry = { signers: [{ id: 'agent:lead', role: 'human' as const }, { id: 'ci-bot', role: 'agent' as const }] };
    const person = { ...alone(), author: 'agent:lead', signedBy: 'agent:lead' };
    expect(classifyEntry(read(person, registry as never))).toBe('ground-truth');
    // An agent listed without the prefix still signs only in a quorum
    const bot = { ...alone(), author: 'ci-bot', signedBy: 'ci-bot' };
    expect(read(bot, registry as never).inadmissible).toMatchObject({ reason: 'agent-without-quorum' });
  });

  it('a quorum citing an evidence kind this version does not know fails closed: it cannot show two settling angles', () => {
    // The codec keeps these lines (an unknown kind breaks no rule), so the reader, which admits truth, refuses them
    const [a, b] = quorumTb().quorum;
    const BENCH = { kind: 'benchmark', ref: 'bench/retry-budget' };
    const SHOT = { kind: 'screenshot', ref: 'shot.png' };
    const shapes: Array<[string, TruthQuorumMember[], string]> = [
      ['member 2 cites only an unknown kind', [a, { ...b, evidence: [BENCH] }], 'benchmark'],
      ['no member cites a known settling kind', [{ ...a, evidence: [SHOT] }, { ...b, evidence: [BENCH] }], 'screenshot'],
      ['one settling kind, and an unknown item clears rule 3', [a, { ...b, evidence: [{ kind: 'commit', ref: '9a8b7c6' }, { kind: 'vibes', ref: 'v' }] }], 'vibes'],
      ['a known question kind plus an invented one', [a, { ...b, evidence: [{ kind: 'message', ref: 'msg_1' }, BENCH] }], 'benchmark'],
    ];
    for (const [name, quorum, kind] of shapes) {
      const body = quorumTb({ quorum, evidence: quorum.flatMap((m) => m.evidence) });
      expect(checkQuorum(body), name).toEqual([]);
      for (const signers of [null, REGISTRY]) {
        const entry = read(body, signers);
        expect(entry.inadmissible, name).toMatchObject({ reason: 'unknown-value' });
        expect(entry.inadmissible!.detail, name).toContain(`evidence kind '${kind}'`);
        expect(classifyEntry(entry), name).toBe('history');
      }
      expect(wikiLineToEntry(chainTruthLines([body])[0]).inadmissible, name).toMatchObject({ reason: 'unknown-value' });
    }
    // The classes bind agents only: a person may sign on evidence of any class, a kind this version doesn't know included
    const { quorum: _q, ...person } = quorumTb({ author: 'kim', signedBy: 'kim', evidence: [SHOT] });
    expect(classifyEntry(read(person, REGISTRY))).toBe('ground-truth');
  });

  it('a TB a person signs needs no quorum, and an agent may still draft what a person signs', () => {
    expect(classifyEntry(read({ ...alone(), author: 'kim', signedBy: 'kim' }))).toBe('ground-truth');
    expect(classifyEntry(read({ ...alone(), author: AGENT, signedBy: 'kim' }, REGISTRY))).toBe('ground-truth');
  });

  it('a version 1 TB an agent signed is not truth even when the host admits v1 TBs: a v1 line carries no quorum', () => {
    const { schemaVersion: _v, ...v1 } = { ...alone(), schemaVersion: 1 };
    const entry = parseWikiLines([JSON.stringify(v1)], { admitV1Tbs: true }).entries[0];
    expect(entry.inadmissible).toMatchObject({ reason: 'agent-without-quorum' });
  });

  it('keeps the quorum as a typed field, not an unknown one, and writes the line back verbatim', () => {
    const lines = chainTruthLines([quorumTb()]);
    const entry = parseWikiLines(lines).entries[0] as TruthTbEntry;
    expect(entry.quorum).toEqual(quorumTb().quorum);
    expect(entry.extra).not.toHaveProperty('quorum');
    expect(serializeWikiEntries([entry])).toEqual(lines);
  });

  it('will not write an entry built by hand that carries a quorum: it would be a version 1 line, which never carries one', () => {
    const read = parseWikiLines(chainTruthLines([quorumTb()])).entries[0] as TruthTbEntry;
    const { source: _s, inadmissible: _i, extra: _e, ...handBuilt } = read;
    expect(() => entryToWikiLine(handBuilt)).toThrow(TruthLineError);
    expect(() => entryToWikiLine(handBuilt)).toThrow(/^quorum: .*TB TBQ1.*version 1 line/);
    expect(() => serializeWikiEntries([handBuilt])).toThrow(TruthLineError);
    // A copy or fixture file is not written at all, rather than written with a line its reader drops
    const dir = mkdtempSync(join(tmpdir(), 'quorum-write-'));
    try {
      const path = join(dir, 'copy.jsonl');
      expect(() => writeWikiFile(path, [handBuilt])).toThrow(TruthLineError);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Nor as a field this package does not interpret, on a TB or a UV
    const { quorum, ...noQuorum } = handBuilt;
    expect(() => entryToWikiLine({ ...noQuorum, extra: { quorum } })).toThrow(TruthLineError);
    const uvEntry = { id: 'UV1', type: 'UV' as const, ts: at(0), author: 'sam', assertion: 'x', basis: 'y', verifyBy: { kind: 'ask', value: 'ops' }, contests: null, status: 'open' };
    expect(() => entryToWikiLine({ ...uvEntry, extra: { quorum } })).toThrow(TruthLineError);
    // Without one, an entry built by hand is written as a version 1 line its reader reads back
    const written = parseWikiLines(serializeWikiEntries([noQuorum, uvEntry]));
    expect(written.errors).toEqual([]);
    expect(written.entries.map((e) => [e.id, e.source?.version])).toEqual([
      ['TBQ1', 1],
      ['UV1', 1],
    ]);
  });

  it('the fixtures: an agent quorum TB folds as ground truth, and an agent TB without one is filed', () => {
    const DIR = new URL('../../test/fixtures/truth-format/', import.meta.url);
    const ledger = readFileSync(new URL('valid/ledger.jsonl', DIR), 'utf8');
    const signers = JSON.parse(readFileSync(new URL('signers.json', DIR), 'utf8'));
    const minted = parseWikiLines(ledger, { signers }).entries.find((e) => e.type === 'TB' && e.signedBy === 'agent:codex') as TruthTbEntry;
    expect(minted.quorum?.map((m) => m.agentSessionId)).toEqual(['sess_7f3a', 'sess_2b8e']);
    expect(classifyEntry(minted)).toBe('ground-truth');
  });
});

describe('signers.json keys (spec: Identities, the signer registry)', () => {
  it('accepts a signer with keys and ignores them: 1.x key signing will not break a 1.0 reader', () => {
    const keys = [{ alg: 'ed25519', id: 'johnnyclem/2026-09', publicKey: 'vwK0Oit9S-qSuXboNLd6z8x_ZT3Cikae7d8UUSPaxoE' }];
    const withKeys = createSignerRegistry({ signers: [{ id: 'johnnyclem', role: 'human', keys }, { id: 'agent:*', role: 'agent' }] });
    const without = createSignerRegistry({ signers: [{ id: 'johnnyclem', role: 'human' }, { id: 'agent:*', role: 'agent' }] });
    for (const who of ['johnnyclem', 'JohnnyClem', 'agent:codex', 'mallory']) expect(withKeys.lookup(who), who).toEqual(without.lookup(who));
  });

  it("the fixtures' registry lists keys on a signer, and reads", () => {
    const signers = JSON.parse(readFileSync(new URL('../../test/fixtures/truth-format/signers.json', import.meta.url), 'utf8'));
    expect(signers.signers.some((s: { keys?: unknown[] }) => Array.isArray(s.keys) && s.keys.length > 0)).toBe(true);
    expect(createSignerRegistry(signers).lookup('johnnyclem')).toEqual({ id: 'johnnyclem', role: 'human' });
  });
});

describe('CONSUMPTION_RULES', () => {
  it("ships stenographer's rules verbatim: a verdict settles only with another session from another angle, or a person", () => {
    expect(CONSUMPTION_RULES).toBe(
      [
        'Consumption rules by confidence type:',
        '- Active TB: treat as ground truth. A reviewer may block on it; a code agent may rely on it.',
        '- Contested TB: ground truth with a visible asterisk — cite both the TB and the contesting UV.',
        "- Open UV: FLAG, DON'T BLOCK. A finding grounded only in a UV is phrased as a question or heads-up, never a demanded change. " +
          'If your current task can check the UV, file your verdict and evidence with resolve_uv: it settles only when another agent session ' +
          'agrees from a different angle (other evidence, another kind) within 15 minutes, or when a person rules.',
        '- Refuted UV / overridden TB: retrievable for history, excluded from current-truth by default, never citable as support for a claim.',
      ].join('\n'),
    );
    expect(CONSUMPTION_RULES).not.toMatch(/settle the UV cheaply/);
  });
});
