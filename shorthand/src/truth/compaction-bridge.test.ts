import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultCompactor } from '../compaction/compactor.js';
import type { ConversationHistory } from '../compaction/types.js';
import {
  TruthAwareCompactor,
  appendProposalsFile,
  applyTruthToCompactedState,
  proposeInvariants,
  renderTruthSection,
  serializeProposals,
  truthToInvariantRecords,
} from './compaction-bridge.js';
import { selectCurrentTruth } from './wiki.js';
import type { TruthSelection, TruthTbEntry, TruthUvEntry } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const activeTb: TruthTbEntry = {
  id: 'TB1',
  type: 'TB',
  ts: '2026-09-18T10:00:00.000Z',
  author: 'johnny',
  claim: 'The REST fallback path is dead.',
  evidence: [{ kind: 'commit', ref: 'abc1234' }],
  signedBy: 'johnny',
  status: 'active',
};

const contestedTb: TruthTbEntry = {
  ...activeTb,
  id: 'TB2',
  claim: 'All embeddings are 384-dimensional.',
  status: 'contested',
};

const contestingUv: TruthUvEntry = {
  id: 'UV1',
  type: 'UV',
  ts: '2026-09-18T11:00:00.000Z',
  author: 'sam',
  assertion: 'The ONNX path still emits 768-dim vectors on fallback.',
  basis: 'Saw it once in a debug log.',
  verifyBy: { kind: 'command', value: 'npm test -- embedding' },
  contests: 'TB2',
  status: 'open',
};

const openUv: TruthUvEntry = {
  ...contestingUv,
  id: 'UV2',
  assertion: 'The embedder cache is safe to share across worker threads.',
  contests: null,
};

const refutedUv: TruthUvEntry = { ...openUv, id: 'UV3', status: 'refuted' };

function selection(): TruthSelection {
  return selectCurrentTruth([activeTb, contestedTb, contestingUv, openUv, refutedUv]);
}

const history: ConversationHistory = {
  sessionId: 'sess-1',
  messages: [
    { id: 'm1', role: 'user', content: 'Set database to postgres please', timestamp: 1 },
    { id: 'm2', role: 'assistant', content: 'Done. I decided to use drizzle for the ORM layer.', timestamp: 2 },
  ],
};

// ---------------------------------------------------------------------------
// Rendering & consumption contract
// ---------------------------------------------------------------------------

describe('renderTruthSection', () => {
  it('marks each confidence type distinctly and carries disputes', () => {
    const text = renderTruthSection(selection());
    expect(text).toContain('[TB] The REST fallback path is dead.');
    expect(text).toContain('[TB ⚠ CONTESTED] All embeddings are 384-dimensional.');
    expect(text).toContain('disputed by [UV — UNVERIFIED] The ONNX path still emits 768-dim vectors');
    expect(text).toContain('[UV — UNVERIFIED] The embedder cache is safe to share');
    // Open UVs never read as proven: every UV occurrence carries the marker.
    const uvMentions = text.split('\n').filter((l) => l.includes('ONNX') || l.includes('embedder cache'));
    for (const line of uvMentions) expect(line).toContain('UNVERIFIED');
    // History never renders.
    expect(text).not.toContain('UV3');
  });
});

describe('applyTruthToCompactedState', () => {
  it('attaches the truth section and structured truth to the state', async () => {
    const base = await new DefaultCompactor().compact(history, 'L3');
    const state = applyTruthToCompactedState(base, selection());

    expect(state.truth).toBeDefined();
    expect(state.truth!.groundTruth.map((t) => t.id)).toEqual(['TB1']);
    expect(state.truth!.contested[0].contestedBy[0].id).toBe('UV1');
    expect(state.truth!.unverified.map((u) => u.id).sort()).toEqual(['UV1', 'UV2']);
    expect(state.truth!.sourceEntryCount).toBe(5);
    expect(state.summary).toContain('## Asserted Truth (ledger)');
    expect(state.compactedTokenCount).toBeGreaterThan(base.compactedTokenCount);
  });

  it('displaces a stale cached section instead of stacking or keeping it', async () => {
    const base = await new DefaultCompactor().compact(history, 'L3');
    const first = applyTruthToCompactedState(base, selection());
    expect(first.summary).toContain('The REST fallback path is dead.');

    // The TB is overridden upstream; the next sync must displace it.
    const next = selectCurrentTruth([
      { ...activeTb, status: 'overridden' },
      contestedTb,
      contestingUv,
      openUv,
    ]);
    const second = applyTruthToCompactedState(first, next);
    expect(second.summary).not.toContain('The REST fallback path is dead.');
    expect(second.summary.match(/## Asserted Truth \(ledger\)/g)).toHaveLength(1);
    expect(second.truth!.groundTruth).toEqual([]);
  });
});

describe('TruthAwareCompactor', () => {
  it('carries truth through compact and recompact at every level', async () => {
    const compactor = new TruthAwareCompactor(new DefaultCompactor(), selection());
    const l2 = await compactor.compact(history, 'L2');
    expect(l2.summary).toContain('## Asserted Truth (ledger)');

    const l3 = await compactor.recompact(l2, 'L3');
    expect(l3.summary).toContain('[TB] The REST fallback path is dead.');
    expect(l3.summary).toContain('[UV — UNVERIFIED]');
    expect(l3.truth!.unverified.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// L4 bridge
// ---------------------------------------------------------------------------

describe('truthToInvariantRecords', () => {
  it('keeps the confidence type riding along into string-typed L4 values', () => {
    const records = truthToInvariantRecords(selection());
    const byKey = new Map(records.map((r) => [r.key, r]));

    expect(byKey.get('truth:TB1')!.value).toBe('[TB] The REST fallback path is dead.');
    expect(byKey.get('truth:TB1')!.confidence).toBe('tb');

    const contested = byKey.get('truth:TB2')!;
    expect(contested.contested).toBe(true);
    expect(contested.value).toContain('⚠ CONTESTED');
    expect(contested.value).toContain('disputed: The ONNX path still emits 768-dim vectors on fallback.');

    const uv = byKey.get('truth:UV2')!;
    expect(uv.confidence).toBe('uv');
    expect(uv.value).toContain('[UV — UNVERIFIED]');

    // Refuted history and TB-riding contesting UVs get no standalone record.
    expect(byKey.has('truth:UV1')).toBe(false);
    expect(byKey.has('truth:UV3')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Proposal emission — the only write path
// ---------------------------------------------------------------------------

describe('proposeInvariants', () => {
  it('drafts UV proposals from settled entities and live decisions', async () => {
    const state = await new DefaultCompactor().compact(history, 'L3');
    const proposals = proposeInvariants(state, { author: 'johnny', now: new Date('2026-09-19T00:00:00Z') });

    expect(proposals.length).toBeGreaterThan(0);
    for (const p of proposals) {
      expect(p.type).toBe('PROPOSAL');
      expect(p.kind).toBe('uv');
      expect(p.author).toBe('johnny');
      expect(p.signal.source).toBe('shorthand-compaction');
      expect(p.draft.assertion.length).toBeGreaterThan(0);
      expect(p.draft.verifyBy.kind).toBe('inspect');
      expect(p.id).toHaveLength(26);
    }
  });

  it('rejects anonymous authors — there is no anonymous write path', async () => {
    const state = await new DefaultCompactor().compact(history, 'L3');
    expect(() => proposeInvariants(state, { author: 'system' })).toThrow(/anonymous or generic/);
    expect(() => proposeInvariants(state, { author: 'assistant' })).toThrow();
  });
});

describe('appendProposalsFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'truth-proposals-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends JSONL and dedupes by targetRef across rounds', async () => {
    const state = await new DefaultCompactor().compact(history, 'L3');
    const proposals = proposeInvariants(state, { author: 'johnny' });
    const path = join(dir, 'proposals.jsonl');

    const first = appendProposalsFile(path, proposals);
    expect(first.written).toBe(proposals.length);
    expect(first.skipped).toBe(0);

    const second = appendProposalsFile(path, proposeInvariants(state, { author: 'johnny' }));
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(proposals.length);

    const written = readFileSync(path, 'utf8').trim().split('\n');
    expect(written).toHaveLength(proposals.length);
    expect(serializeProposals(proposals)).toEqual(written);
  });
});
