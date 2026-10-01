import { describe, it, expect } from 'vitest';
import { parseWikiLines, selectCurrentTruth } from './wiki.js';
import { renderTruthLines } from './compaction-bridge.js';
import { groundTruthToInvariant, displaceStaleInvariants } from './ledger-sync.js';
import {
  exportProposalDrafts,
  invariantsToProposalDrafts,
  tombstonesToProposalDrafts,
} from './proposal-export.js';
import { TRUTH_SOURCE_PREFIX, type TruthTbEntry, type WikiEntryLine } from './types.js';
import { chainTruthLines } from './format.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import type { CompactedState, Invariant } from '../types.js';

// Line shapes mirror stenographer's exportWikiEntries output; `stream`
// chains them into a truth format v2 stream as stenographer writes it.
function tb(id: string, status: string, claim: string, signedBy: string | null = 'johnny'): WikiEntryLine {
  return {
    id,
    type: 'TB',
    ts: '2026-09-19T12:00:00.000Z',
    author: 'johnny',
    claim,
    evidence: [{ kind: 'commit', ref: 'abc123' }],
    signedBy,
    status,
    'x-steno': { origin: 'local', provenance: { kind: 'manual' }, agentSessionId: null, links: [] },
  };
}

function uv(id: string, status: string, assertion: string, contests: string | null = null): WikiEntryLine {
  return {
    id,
    type: 'UV',
    ts: '2026-09-19T12:00:00.000Z',
    author: 'johnny',
    assertion,
    basis: 'seen in production',
    verifyBy: { kind: 'ask', value: 'johnny' },
    contests,
    status,
    'x-steno': {
      origin: 'local',
      provenance: { kind: 'manual' },
      agentSessionId: null,
      links: contests ? [{ fromId: id, toId: contests, type: 'contests' }] : [],
    },
  };
}

function stream(...lines: Array<Record<string, unknown>>): string[] {
  return chainTruthLines(lines);
}

function select(lines: WikiEntryLine[]) {
  const { entries, errors } = parseWikiLines(stream(...lines));
  expect(errors).toEqual([]);
  return selectCurrentTruth(entries);
}

function emptyState(): CompactedState {
  return {
    l0_messages: [],
    l1_compacted: [],
    l2_summaries: [],
    l3_graph: { entities: new Map(), edges: [] },
    l4_invariants: [],
    tombstones: [],
    totalTokenEstimate: 0,
  };
}

describe('parseWikiLines (stenographer export)', () => {
  it('parses valid lines and reports bad ones without aborting', () => {
    const lines = [
      JSON.stringify(tb('01A', 'active', 'We use PostgreSQL.')),
      'not json at all',
      JSON.stringify({ id: '01B', type: 'RULING', status: 'x' }),
      JSON.stringify(uv('01C', 'open', 'The cache TTL is 60 seconds.')),
    ];
    const { entries, errors } = parseWikiLines(lines);
    expect(entries.map((e) => e.id)).toEqual(['01A', '01C']);
    expect(errors).toHaveLength(2);
    expect(errors[0].line).toBe(2);
    expect(errors[1].error).toContain('a version 1 line is a TB or UV');
  });

  it('is last-line-wins per id (append-only file, statuses evolve)', () => {
    const { entries } = parseWikiLines([
      JSON.stringify(tb('01A', 'active', 'We use PostgreSQL.')),
      JSON.stringify(tb('01A', 'overridden', 'We use PostgreSQL.')),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('overridden');
  });

  it('accepts a single newline-joined string', () => {
    const blob = [tb('01A', 'active', 'A'), uv('01B', 'open', 'B')].map((e) => JSON.stringify(e)).join('\n');
    expect(parseWikiLines(blob).entries).toHaveLength(2);
  });
});

describe('selectCurrentTruth (§7 consumption rules)', () => {
  it('buckets active TB as ground truth, open UV as unverified, the rest as history', () => {
    const selection = select([
      tb('T1', 'active', 'We use PostgreSQL.'),
      tb('T2', 'overridden', 'We use MySQL.'),
      uv('U1', 'open', 'The importer is idempotent.'),
      uv('U2', 'refuted', 'The importer runs nightly.'),
      uv('U3', 'verified', 'Auth uses JWT.'),
    ]);
    expect(selection.groundTruth.map((e) => e.id)).toEqual(['T1']);
    expect(selection.unverified.map((e) => e.id)).toEqual(['U1']);
    expect(selection.history.map((e) => e.id).sort()).toEqual(['T2', 'U2', 'U3']);
  });

  it('carries the contesting UV with its contested TB, not as a standalone line', () => {
    const selection = select([
      tb('T1', 'contested', 'Deploys go through CI.'),
      uv('U1', 'open', 'Hotfixes are deployed manually.', 'T1'),
      uv('U2', 'open', 'Unrelated open belief.'),
    ]);
    expect(selection.contested).toHaveLength(1);
    expect(selection.contested[0].contestedBy.map((u) => u.id)).toEqual(['U1']);
    const lines = renderTruthLines(selection);
    expect(lines.filter((l) => l.includes('Hotfixes'))).toHaveLength(1);
    expect(lines.find((l) => l.includes('Hotfixes'))).toContain('disputed by [UV — UNVERIFIED]');
  });
});

describe('renderTruthLines (frozen suite markers)', () => {
  it('never renders an open UV as proven, and shows both sides of a dispute', () => {
    const lines = renderTruthLines(
      select([
        tb('T1', 'active', 'We use PostgreSQL.'),
        tb('T2', 'contested', 'Deploys go through CI.'),
        uv('U1', 'open', 'Hotfixes are deployed manually.', 'T2'),
        uv('U2', 'open', 'The cache TTL is 60 seconds.'),
      ]),
    );
    expect(lines[0]).toBe('- [TB] We use PostgreSQL. (signed: johnny, evidence: 1)');
    expect(lines[1]).toContain('[TB ⚠ CONTESTED] Deploys go through CI.');
    expect(lines[2]).toContain('disputed by [UV — UNVERIFIED] Hotfixes are deployed manually.');
    const uvLine = lines.find((l) => l.includes('cache TTL'));
    expect(uvLine).toContain('[UV — UNVERIFIED]');
    expect(uvLine).not.toContain('[TB]');
  });

  it('renders nothing for history entries', () => {
    expect(renderTruthLines(select([tb('T1', 'overridden', 'Old truth.')]))).toEqual([]);
  });

  it('renders nothing for an unsigned TB: it is never truth on its own', () => {
    expect(renderTruthLines(select([tb('T1', 'active', 'Backfilled.', null)]))).toEqual([]);
  });
});

describe('L4 projection and displacement', () => {
  it('projects an active TB with the truth: source prefix', () => {
    const selection = select([tb('T1', 'active', 'We use PostgreSQL.')]);
    const inv = groundTruthToInvariant(selection.groundTruth[0]);
    expect(inv).not.toBeNull();
    expect(inv!.sourceMessage).toBe(`${TRUTH_SOURCE_PREFIX}T1`);
    expect(inv!.value).toBe('We use PostgreSQL.');
  });

  it('refuses to project a contested TB (an invariant row cannot carry the asterisk)', () => {
    const selection = select([
      tb('T1', 'contested', 'Deploys go through CI.'),
      uv('U1', 'open', 'Hotfixes are deployed manually.', 'T1'),
    ]);
    expect(groundTruthToInvariant(selection.contested[0].tombstone)).toBeNull();
  });

  it('refuses to project a TB with an unknown status', () => {
    const { entries } = parseWikiLines([JSON.stringify(tb('T1', 'retracted', 'Gone?'))]);
    expect(groundTruthToInvariant(entries[0] as TruthTbEntry)).toBeNull();
  });

  it('displaces cached invariants whose entry was overridden, keeps the rest', () => {
    const invariants: Invariant[] = [
      { key: 'T1', value: 'Old truth.', sourceMessage: `${TRUTH_SOURCE_PREFIX}T1`, timestamp: 1 },
      { key: 'T2', value: 'Live truth.', sourceMessage: `${TRUTH_SOURCE_PREFIX}T2`, timestamp: 1 },
      { key: 'db', value: 'postgres', sourceMessage: 'msg-9', timestamp: 1 },
    ];
    const { kept, displacedKeys } = displaceStaleInvariants(
      invariants,
      select([tb('T1', 'overridden', 'Old truth.'), tb('T2', 'active', 'Live truth.')]),
    );
    expect(displacedKeys).toEqual(['T1']);
    expect(kept.map((i) => i.key).sort()).toEqual(['T2', 'db']);
  });
});

describe('CompactionEngine.syncTruthLedger', () => {
  it('puts synced truth first in the context frame', async () => {
    const engine = new CompactionEngine({ memtableSize: 10, contextBudget: 4000 });
    await engine.addMessage({ id: 'm1', role: 'user', content: 'hello there', timestamp: Date.now() });

    const result = engine.syncTruthLedger(
      stream(tb('T1', 'active', 'We use PostgreSQL.'), uv('U1', 'open', 'The cache TTL is 60 seconds.')),
    );
    expect(result.errors).toEqual([]);
    expect(result.refused).toBe(false);
    expect(result.selection.groundTruth).toHaveLength(1);

    const frame = engine.buildContextFrame(2000);
    expect(frame.sections[0].content).toContain('## Asserted Truth (ledger)');
    expect(frame.sections[0].content).toContain('[TB] We use PostgreSQL.');
    expect(frame.sections[0].content).toContain('[UV — UNVERIFIED] The cache TTL is 60 seconds.');
  });

  it('accepts already-parsed entries', () => {
    const engine = new CompactionEngine();
    const { entries } = parseWikiLines(stream(tb('T1', 'active', 'We use PostgreSQL.')));
    expect(engine.syncTruthLedger(entries).selection.groundTruth.map((e) => e.id)).toEqual(['T1']);
  });

  it('a later sync displaces truth the frame previously carried', () => {
    const engine = new CompactionEngine();
    const ledger = stream(tb('T1', 'active', 'We use PostgreSQL.'), {
      id: 'A1:T1',
      type: 'TRANSITION',
      ts: '2026-09-19T12:05:00.000Z',
      author: 'kim',
      target: 'T1',
      status: 'overridden',
      cause: { kind: 'override', ref: 'A1' },
    });
    engine.syncTruthLedger(ledger.slice(0, 1));
    const selection = engine.getTruthSelection()!;
    engine.getState().l4_invariants.push(groundTruthToInvariant(selection.groundTruth[0])!);

    // The stream grew by a TRANSITION; the entry line itself is never rewritten
    const result = engine.syncTruthLedger(ledger);
    expect(result.displacedInvariantKeys).toEqual(['T1']);
    expect(engine.getState().l4_invariants).toHaveLength(0);
    expect(engine.buildContextFrame(2000).sections.every((s) => !s.content.includes('PostgreSQL'))).toBe(true);
  });
});

describe('proposal export (write path is proposals only, suite PROPOSAL envelope)', () => {
  const options = { author: 'johnny', now: new Date('2026-09-19T00:00:00Z') };

  it('drafts a UV proposal per L4 invariant, skipping ledger-sourced ones', () => {
    const state = emptyState();
    state.l4_invariants = [
      { key: 'database', value: 'PostgreSQL', sourceMessage: 'msg-3', timestamp: 1 },
      { key: 'T9', value: 'From the ledger.', sourceMessage: `${TRUTH_SOURCE_PREFIX}T9`, timestamp: 1 },
    ];
    const proposals = invariantsToProposalDrafts(state, options);
    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p.schemaVersion).toBe(2);
    expect(p.type).toBe('PROPOSAL');
    expect(p.kind).toBe('uv');
    expect(p.id).toHaveLength(26);
    expect(p.ts).toBe('2026-09-19T00:00:00.000Z');
    expect(p.author).toBe('johnny');
    expect(p.draft.assertion).toBe('The invariant "database" holds: PostgreSQL.');
    expect(p.targetRef).toBe('shorthand:invariant:database');
    expect(p.signal.source).toBe('compaction-candidate');
    // The envelope is exact: the source message travels in the draft, not a top-level provenance field
    expect('provenance' in p).toBe(false);
    expect(p.draft.verifyBy.value).toBe('message:msg-3');
  });

  it('drafts an unsigned TB proposal per correction with message evidence', () => {
    const state = emptyState();
    state.tombstones = [
      {
        supersededContent: 'We use MySQL',
        originalMessageId: 'm1',
        correctionMessageId: 'm5',
        reason: 'user correction',
        timestamp: Date.now(),
        correctedValue: 'PostgreSQL',
      },
    ];
    const [p] = tombstonesToProposalDrafts(state, options);
    expect(p.kind).toBe('tb');
    expect(p.draft.claim).toContain('"We use MySQL" no longer holds');
    expect(p.draft.claim).toContain('superseded by "PostgreSQL"');
    expect(p.draft.evidence).toEqual([{ kind: 'message', ref: 'm5', detail: 'user correction' }]);
    // Unsigned by construction: the draft has no signer field at all (spec: claim, evidence, literals?)
    expect(Object.keys(p.draft).sort()).toEqual(['claim', 'evidence']);
  });

  it('rejects anonymous authors — there is no anonymous write path', () => {
    expect(() => exportProposalDrafts(emptyState(), { author: 'system' })).toThrow(/anonymous or generic/);
  });

  it('serializes to one JSON object per line', () => {
    const state = emptyState();
    state.l4_invariants = [{ key: 'db', value: 'postgres', sourceMessage: 'm1', timestamp: 1 }];
    const lines = exportProposalDrafts(state, options);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('PROPOSAL');
    expect(parsed.signal.source).toBe('compaction-candidate');
  });
});
