/**
 * The deprecated `@smallchat/core/truth` subpath carries @shorthand/core
 * 1.0's truth contract, agent quorum included (stenographer
 * spec/truth-format, "Evidence classes" and "Agent quorum"). The user's
 * rule for the suite, verbatim: "agents can only settle claims together,
 * meaning 2 or more agreeing from different angles at the same time".
 *
 * @shorthand/core's own suite (the mirror's) runs stenographer's fixtures
 * against every rule. These tests read hand-built streams through this
 * package's subpath, so a smallchat build that ships a mirror from before
 * the quorum fails here as well as in `check:shorthand`.
 */

import { describe, it, expect } from 'vitest';
import {
  CONSUMPTION_RULES,
  EVIDENCE_KINDS,
  QUORUM_MIN_MEMBERS,
  QUORUM_WINDOW_MS,
  SETTLING_EVIDENCE_KINDS,
  evidenceClass,
  parseWikiLines,
  selectCurrentTruth,
  truthLineHash,
  type TruthTbEntry,
} from './index.js';

const T0 = Date.parse('2026-09-01T12:00:00.000Z');
const MIN = 60_000;
const at = (ms: number) => new Date(T0 + ms).toISOString();

const AGENT = 'agent:claude-code';
const COMMIT = { kind: 'commit', ref: 'a1b2c3' };
const FILE = { kind: 'file', ref: 'config.ts:3' };
const member = (session: string, ts: string, evidence: Array<{ kind: string; ref: string }>) => ({ author: AGENT, agentSessionId: session, ts, evidence });

/** One TB as a v2 stream of one line (seq 1, hash-chained). */
function tbStream(over: Record<string, unknown>): string[] {
  const unhashed = {
    schemaVersion: 2,
    seq: 1,
    id: '01M1E6JK8M988SWTQEY5B84FYN',
    type: 'TB',
    ts: at(5 * MIN),
    author: AGENT,
    claim: 'LOG_BUDGET is 100; legacyRateLimiter is gone.',
    evidence: [COMMIT, FILE],
    signedBy: AGENT,
    literals: [{ subject: 'LOG_BUDGET', dead: '30', current: '100' }],
    status: 'active',
    ...over,
    prevHash: null,
  };
  return [JSON.stringify({ ...unhashed, hash: truthLineHash(unhashed) })];
}

const groundTruthIds = (lines: string[]) => selectCurrentTruth(parseWikiLines(lines).entries).groundTruth.map((tb) => tb.id);

describe('@smallchat/core/truth: agents settle claims only together', () => {
  it('two agent sessions agreeing from different angles within 15 minutes make a TB truth', () => {
    const quorum = [member('sess-a', at(0), [COMMIT]), member('sess-b', at(5 * MIN), [FILE])];
    const read = parseWikiLines(tbStream({ quorum }));
    expect(read.refused).toBeFalsy();
    expect(selectCurrentTruth(read.entries).groundTruth.map((tb) => tb.id)).toEqual(['01M1E6JK8M988SWTQEY5B84FYN']);
    expect((read.entries[0] as TruthTbEntry).quorum?.map((m) => m.agentSessionId)).toEqual(['sess-a', 'sess-b']);
  });

  it('one agent alone settles nothing: its TB is not truth', () => {
    const read = parseWikiLines(tbStream({}));
    expect(read.refused).toBeFalsy();
    expect(read.entries[0].inadmissible?.reason).toBe('agent-without-quorum');
    expect(selectCurrentTruth(read.entries).groundTruth).toEqual([]);
  });

  it('refuses a quorum that is one session, one angle, or not at the same time', () => {
    const cases: Array<[string, ReturnType<typeof member>[], RegExp]> = [
      ['one member', [member('sess-a', at(0), [COMMIT, FILE])], /at least 2 members.*rule 1/],
      ['one session', [member('sess-a', at(0), [COMMIT]), member('sess-a', at(MIN), [FILE])], /share agent session sess-a.*rule 1/],
      ['one settling kind', [member('sess-a', at(0), [COMMIT]), member('sess-b', at(MIN), [{ kind: 'commit', ref: 'd4e5f6' }])], /two settling kinds.*rule 3/],
      ['a chat message is no angle', [member('sess-a', at(0), [COMMIT]), member('sess-b', at(MIN), [{ kind: 'chat', ref: 'slack:C01/p17' }])], /member 2 cites no settling evidence.*rule 3/],
      ['16 minutes apart', [member('sess-a', at(-11 * MIN), [COMMIT]), member('sess-b', at(5 * MIN), [FILE])], /more than 15 minutes apart.*rule 4/],
    ];
    for (const [name, quorum, rule] of cases) {
      const lines = tbStream({ quorum, evidence: quorum.flatMap((m) => m.evidence) });
      const read = parseWikiLines(lines);
      expect(read.refused, name).toBe(true);
      expect(read.errors.map((e) => e.error).join('; '), name).toMatch(rule);
      expect(groundTruthIds(lines), name).toEqual([]);
    }
  });

  it('a person may still sign alone, on evidence of any class', () => {
    const lines = tbStream({ author: 'kim', signedBy: 'kim', evidence: [{ kind: 'chat', ref: 'slack:C01/p17' }] });
    expect(groundTruthIds(lines)).toEqual(['01M1E6JK8M988SWTQEY5B84FYN']);
  });

  it('exports the evidence classes, the quorum bounds and the consumption rule that says so', () => {
    expect(QUORUM_MIN_MEMBERS).toBe(2);
    expect(QUORUM_WINDOW_MS).toBe(900_000);
    expect([...SETTLING_EVIDENCE_KINDS]).toEqual(['commit', 'file', 'test', 'claimed-command', 'wiki']);
    for (const kind of ['chat', 'ticket', 'doc']) {
      expect(EVIDENCE_KINDS, kind).toContain(kind);
      expect(evidenceClass(kind), kind).toBe('question');
    }
    expect(evidenceClass('screenshot')).toBe('question');
    expect(CONSUMPTION_RULES).toContain(
      'If your current task can check the UV, file your verdict and evidence with resolve_uv: it settles only when another agent session agrees from a different angle (other evidence, another kind) within 15 minutes, or when a person rules.',
    );
    expect(CONSUMPTION_RULES).not.toMatch(/settle the UV cheaply/);
  });
});
