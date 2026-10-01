import { describe, it, expect } from 'vitest';
import { CompactionEngine } from './compaction-engine.js';
import { RegexCompactor } from './regex-compactor.js';
import { InvariantChecker } from '../verification/invariant-checker.js';
import { applyTombstone, revertTombstone } from './corrections.js';
import { exportProposalDrafts } from '../truth/proposal-export.js';
import { CompactionLevel, type CompactedState, type ConversationMessage } from '../types.js';

let seq = 0;
function msg(content: string, role: ConversationMessage['role'] = 'user'): ConversationMessage {
  seq += 1;
  return { id: `m${seq}`, role, content, timestamp: 1_000 * seq };
}

function frameText(engine: CompactionEngine, budget = 8000): string {
  return engine.buildContextFrame(budget).sections.map((s) => s.content).join('\n');
}

function propagation(state: CompactedState) {
  return new InvariantChecker().verify(state).checks.find((c) => c.name === 'correction-propagation')!;
}

describe('corrections reach every level (SH-01)', () => {
  it('displaces L4 invariants and L3 entities that state only the superseded value', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage(msg('The service must use MySQL for all persistence.'));
    await engine.addMessage(msg("We're using MySQL for the orders table."));
    await engine.addMessage(msg('Actually, use Postgres instead of MySQL.'));
    await engine.recompact(CompactionLevel.L4_INVARIANTS);

    const text = frameText(engine);
    expect(text).not.toMatch(/\[invariant\][^\n]*MySQL/);
    expect(text).not.toMatch(/\[entity\] MySQL/);
    expect(text).toContain('Postgres');

    const state = engine.getState();
    expect(state.l4_invariants.some((i) => /mysql/i.test(i.value))).toBe(false);
    expect(state.l3_graph.entities.has('MySQL')).toBe(false);
    const archivedInvariant = state.archive!.find((a) => a.kind === 'invariant');
    expect(archivedInvariant?.kind === 'invariant' && archivedInvariant.invariant.displacedBy).toBeTruthy();
    expect(propagation(state).passed).toBe(true);
  });

  it('InvariantChecker fails when a stale value survives at L3 or L4', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: {
        entities: new Map([
          ['MySQL', { name: 'MySQL', type: 'technology', properties: {}, firstMention: 'm1', lastMention: 'm1' }],
        ]),
        edges: [],
      },
      l4_invariants: [{ key: 'use MySQL for persistence', value: 'must use MySQL', sourceMessage: 'm1', timestamp: 1 }],
      tombstones: [
        {
          supersededContent: 'MySQL',
          originalMessageId: 'm1',
          correctionMessageId: 'm3',
          reason: 'Actually, use Postgres instead of MySQL.',
          timestamp: 3,
          key: 'MySQL',
          correctedValue: 'Postgres',
        },
      ],
      totalTokenEstimate: 0,
    };

    const check = propagation(state);
    expect(check.passed).toBe(false);
    expect(check.message).toMatch(/L[34]/);
  });

  it('does not flag a value restated after the correction', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [{ originalMessageId: 'm9', compacted: 'MySQL still runs the legacy reports.', importance: 0.1, timestamp: 9 }],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [
        {
          supersededContent: 'MySQL',
          originalMessageId: 'm1',
          correctionMessageId: 'm3',
          reason: 'switch',
          timestamp: 3,
          correctedValue: 'Postgres',
        },
      ],
      totalTokenEstimate: 0,
    };
    expect(propagation(state).passed).toBe(true);
  });
});

describe('explicit correction API (SH-01, SH-02)', () => {
  it('engine.correct produces an explicit tombstone and archives stale entries at every level', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage(msg('The deploy target must be us-east-1 for every service.'));
    await engine.addMessage(msg('We are building a staging cluster in us-east-1.'));
    await engine.addMessage(msg('Unrelated: the retry budget is 3 attempts.'));
    await engine.recompact(CompactionLevel.L4_INVARIANTS);

    const tombstone = await engine.correct({ key: 'region', from: 'us-east-1', to: 'eu-west-1', sourceMessageId: 'ops-1' });
    expect(tombstone.confidence).toBe('explicit');
    expect(tombstone.id).toBeTruthy();

    const state = engine.getState();
    expect(state.tombstones).toContainEqual(tombstone);
    expect(state.l1_compacted.map((e) => e.compacted)).toEqual(['Unrelated: the retry budget is 3 attempts.']);
    expect(state.l4_invariants.some((i) => i.value.includes('us-east-1'))).toBe(false);
    expect(state.archive!.filter((a) => a.by === tombstone.id).length).toBeGreaterThanOrEqual(2);
    expect(frameText(engine)).toContain('[correction] "us-east-1" was corrected to "eu-west-1"');
    expect(propagation(state).passed).toBe(true);
  });

  it('is deterministic: the same correction twice yields one tombstone', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage(msg('We use Redis for sessions.'));
    const a = await engine.correct({ from: 'Redis', to: 'Valkey', sourceMessageId: 'x1' });
    const b = await engine.correct({ from: 'Redis', to: 'Valkey', sourceMessageId: 'x1' });
    expect(b.id).toBe(a.id);
    expect(engine.getState().tombstones).toHaveLength(1);
  });

  it('rejects pronoun, stopword and empty "from" values', async () => {
    const engine = new CompactionEngine();
    for (const from of ['it', 'this', 'that', '  ', 'the']) {
      await expect(engine.correct({ from, to: 'blue', sourceMessageId: 'x' })).rejects.toThrow(TypeError);
    }
    expect(engine.getState().tombstones).toEqual([]);
  });

  it('revertCorrection restores what the tombstone archived', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage(msg('We use Redis for sessions.'));
    const t = await engine.correct({ from: 'Redis', to: 'Valkey', sourceMessageId: 'x1' });
    expect(engine.getState().l1_compacted).toHaveLength(0);

    expect(await engine.revertCorrection(t.id!)).toBe(true);
    expect(engine.getState().l1_compacted.map((e) => e.compacted)).toEqual(['We use Redis for sessions.']);
    expect(engine.getState().tombstones).toEqual([]);
  });

  it('retracting the message that made a correction reverts it', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage(msg('We use Redis for sessions.'));
    const correction = msg('Actually, use Valkey instead of Redis.');
    await engine.addMessage(correction);
    expect(engine.getState().l1_compacted.map((e) => e.compacted)).toEqual([correction.content]);

    await engine.retract([correction.id]);
    expect(engine.getState().tombstones).toEqual([]);
    expect(engine.getState().l1_compacted.map((e) => e.compacted)).toEqual(['We use Redis for sessions.']);
  });

  it('applies an explicit correction to stale messages still in L0 when they compact later', async () => {
    const engine = new CompactionEngine({ memtableSize: 5 });
    await engine.addMessage(msg('Our cache layer is Memcached.'));
    await engine.correct({ from: 'Memcached', to: 'Redis', sourceMessageId: 'host-1' });
    await engine.flush();
    expect(engine.getState().l1_compacted).toEqual([]);
  });
});

describe('pronoun and generic corrections never delete history (SH-02)', () => {
  it('"change it to blue" creates no tombstone and keeps unrelated L1 facts', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage(msg('The login page is slow; it takes 4 seconds to render on mobile.'));
    await engine.addMessage(msg('Our SLA requires it to respond within 200ms at p99.'));
    await engine.addMessage(msg('The retry budget is 3 attempts and it backs off exponentially.'));
    await engine.addMessage(msg('The button is grey. Can you change it to blue.'));

    const state = engine.getState();
    expect(state.tombstones.some((t) => /^(it|this|that)$/i.test(t.supersededContent))).toBe(false);
    expect(state.l1_compacted).toHaveLength(4);
  });

  it('archives superseded L1 entries instead of deleting them', async () => {
    const state = await new RegexCompactor().compact(
      [msg('We decided to use MySQL for storage.'), msg('Switch MySQL to Postgres.')],
      CompactionLevel.L1_COMPACTED,
    );
    const tombstone = state.tombstones[0];
    expect(tombstone.confidence).toBe('inferred');
    const archived = state.archive!.filter((a) => a.kind === 'l1');
    expect(archived).toHaveLength(1);
    expect(archived[0].by).toBe(tombstone.id);
    expect(archived[0].kind === 'l1' && archived[0].entry.compacted).toBe('We decided to use MySQL for storage.');
  });
});

describe('over-eager extraction (SH-16)', () => {
  it('substring keywords ("await", "Factually") are not corrections', async () => {
    const state = await new RegexCompactor().compact(
      [msg('We await the fetch and then parse the JSON body.'), msg('Factually the cache hit rate is 92 percent.')],
      CompactionLevel.L1_COMPACTED,
    );
    expect(state.tombstones).toEqual([]);
  });

  it('never records a tombstone without a superseded value', async () => {
    const state = await new RegexCompactor().compact(
      [msg('We decided to use MySQL for storage.'), msg('Wait, let me think about the schema first.')],
      CompactionLevel.L1_COMPACTED,
    );
    expect(state.tombstones).toEqual([]);
    expect(state.l1_compacted).toHaveLength(2);
  });

  it('questions do not become invariants', async () => {
    const state = await new RegexCompactor().compact(
      [msg('Should we deploy on Friday?'), msg('Must the API support pagination?')],
      CompactionLevel.L1_COMPACTED,
    );
    expect(state.l4_invariants).toEqual([]);
  });

  it('a rejection-only decision gets a "Rejected:" topic, not "Decision: undefined"', async () => {
    const state = await new RegexCompactor().compact(
      [msg('We ruled out Kafka because it is too heavy.')],
      CompactionLevel.L1_COMPACTED,
    );
    const topics = state.l2_summaries.map((s) => s.topic);
    expect(topics).toContain('Rejected: Kafka');
    expect(topics.some((t) => t.includes('undefined'))).toBe(false);
  });

  it('exportProposalDrafts skips inferred (regex) corrections unless asked', async () => {
    const state = await new RegexCompactor().compact(
      [msg("Let's use MySQL."), msg('Actually, use Postgres instead of MySQL.')],
      CompactionLevel.L1_COMPACTED,
    );
    expect(state.tombstones).toHaveLength(1);
    const kinds = (lines: string[]) => lines.map((l) => JSON.parse(l).kind);
    expect(kinds(exportProposalDrafts(state, { author: 'johnny' }))).not.toContain('tb');
    expect(kinds(exportProposalDrafts(state, { author: 'johnny', includeInferred: true }))).toContain('tb');
  });
});

describe('a correction whose new value is part of the old one (SH-R4)', () => {
  it('still archives the statements of the old value', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage({ id: 'r1', role: 'user', content: 'We deploy release v2.1.0-beta to production on Friday.', timestamp: 1 });
    await engine.addMessage({ id: 'r2', role: 'user', content: 'The service must run v2.1.0-beta in prod.', timestamp: 2 });
    await engine.addMessage({ id: 'r3', role: 'user', content: 'Release v2.1.0-beta replaced v2.0.9 last week; v2.1.0 is next.', timestamp: 3 });
    const tombstone = await engine.correct({ from: 'v2.1.0-beta', to: 'v2.1.0', sourceMessageId: 'ext-1' });

    const state = engine.getState();
    expect(tombstone.originalMessageId).toBe('r2');
    expect(state.archive!.filter((a) => a.kind === 'l1').map((a) => a.kind === 'l1' && a.entry.originalMessageId)).toEqual(['r1', 'r2']);
    // A text that names both values is not stale
    expect(state.l1_compacted.map((e) => e.originalMessageId)).toEqual(['r3']);
    expect(state.l4_invariants.some((i) => i.value.includes('beta'))).toBe(false);
    expect(frameText(engine)).not.toContain('production on Friday');
  });

  it('the compactor finds the corrected statement the same way', async () => {
    const state = await new RegexCompactor().compact(
      [
        { id: 'p1', role: 'user', content: 'We run postgres 15 on the primary.', timestamp: 1 },
        { id: 'p2', role: 'user', content: 'Change postgres 15 to postgres.', timestamp: 2 },
      ],
      CompactionLevel.L1_COMPACTED,
    );
    expect(state.tombstones.map((t) => [t.supersededContent, t.correctedValue, t.originalMessageId])).toEqual([['postgres 15', 'postgres', 'p1']]);
    expect(state.l1_compacted.map((e) => e.originalMessageId)).toEqual(['p2']);
  });
});

describe('a correction takes effect where it was declared (SH-R5)', () => {
  it('a message added right after correct(), without an await, is not before it', async () => {
    const engine = new CompactionEngine({ memtableSize: 1 });
    await engine.addMessage({ id: 'c1', role: 'user', content: 'Deploy the API to us-east-1 tonight.', timestamp: 1 });
    const p = engine.correct({ from: 'us-east-1', to: 'us-west-2', sourceMessageId: 'ticket-7' });
    const q = engine.addMessage({ id: 'c2', role: 'user', content: 'Rollback done: the API is on us-east-1 again.', timestamp: 2 });
    await Promise.all([p, q]);
    await engine.addMessage({ id: 'c3', role: 'user', content: 'Logs are quiet.', timestamp: 3 });
    await engine.flush();

    const state = engine.getState();
    expect(state.archive!.filter((a) => a.kind === 'l1').map((a) => a.kind === 'l1' && a.entry.originalMessageId)).toEqual(['c1']);
    expect(state.l1_compacted.map((e) => e.originalMessageId)).toEqual(['c2', 'c3']);
  });
});

describe('reverting one of two corrections of a value (SH-R8)', () => {
  it('keeps archived what the remaining correction supersedes, under that correction', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage({ id: 'v1', role: 'user', content: 'Deploy the API to us-east-1 tonight.', timestamp: 1 });
    await engine.addMessage({ id: 'v2', role: 'user', content: 'Retries are capped at 3.', timestamp: 2 });
    const first = await engine.correct({ from: 'us-east-1', to: 'us-west-2', sourceMessageId: 'v2' });
    await engine.addMessage({ id: 'v3', role: 'user', content: 'Logs ship to the central bucket.', timestamp: 3 });
    const second = await engine.correct({ from: 'us-east-1', to: 'eu-west-1', sourceMessageId: 'v3' });

    expect(await engine.revertCorrection(first.id!)).toBe(true);
    const state = engine.getState();
    expect(state.tombstones.map((t) => t.id)).toEqual([second.id]);
    expect(state.l1_compacted.map((e) => e.compacted)).not.toContain('Deploy the API to us-east-1 tonight.');
    expect(state.archive!.filter((a) => a.kind === 'l1').map((a) => [a.by, a.kind === 'l1' && a.entry.originalMessageId])).toEqual([
      [second.id, 'v1'],
    ]);

    // Reverting the second too brings the statement back
    expect(await engine.revertCorrection(second.id!)).toBe(true);
    expect(engine.getState().l1_compacted.map((e) => e.originalMessageId)).toEqual(['v1', 'v2', 'v3']);
  });

  it('the remaining correction keeps its own cutoff: a later restatement it did not cover comes back', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    await engine.addMessage({ id: 'w1', role: 'user', content: 'Primary DB is Redis.', timestamp: 1 });
    const early = await engine.correct({ from: 'Redis', to: 'Valkey', sourceMessageId: 'w1' });
    await engine.addMessage({ id: 'w2', role: 'user', content: 'Cache tier: Redis cluster, still.', timestamp: 2 });
    const late = await engine.correct({ from: 'Redis', to: 'Dragonfly', sourceMessageId: 'w-ext' });
    expect(engine.getState().l1_compacted).toEqual([]);

    // w1 was the early correction's own message: only the late one superseded it
    expect(await engine.revertCorrection(late.id!)).toBe(true);
    expect(engine.getState().l1_compacted.map((e) => e.originalMessageId)).toEqual(['w1', 'w2']);
    expect(engine.getState().tombstones.map((t) => t.id)).toEqual([early.id]);
  });
});

describe('reverting a correction with decisions and graph items another correction also covers (SH-R8)', () => {
  it('keeps the L2 decision, L3 entity and L4 invariant superseded under the remaining correction', async () => {
    const state = await new RegexCompactor().compact(
      [
        { id: 'd1', role: 'user', content: "Let's use MySQL. The service must use MySQL for persistence.", timestamp: 1 },
        { id: 'd2', role: 'user', content: 'We are building MySQL replicas for reporting.', timestamp: 2 },
      ],
      CompactionLevel.L1_COMPACTED,
    );
    const first = { id: 'tomb_a', supersededContent: 'MySQL', correctedValue: 'Postgres', originalMessageId: 'd1', correctionMessageId: 'x1', reason: 'a', timestamp: 3 };
    const second = { ...first, id: 'tomb_b', correctedValue: 'SQLite', correctionMessageId: 'x2', reason: 'b', timestamp: 4 };
    state.tombstones.push(first, second);
    applyTombstone(state, first);
    expect(applyTombstone(state, second)).toBe(0);
    const decision = state.l2_summaries.concat(state.archive!.flatMap((a) => (a.kind === 'summary' ? [a.summary] : [])))
      .flatMap((s) => s.decisions)
      .find((d) => d.chosen === 'MySQL')!;
    expect(decision).toMatchObject({ superseded: true, tombstoneId: 'tomb_a', alsoBy: ['tomb_b'] });

    const archivedBefore = state.archive!.filter((a) => a.reason === 'superseded').length;
    expect(revertTombstone(state, 'tomb_a')).toBe(true);
    expect(state.archive!.filter((a) => a.reason === 'superseded')).toHaveLength(archivedBefore);
    expect(state.archive!.every((a) => a.reason !== 'superseded' || a.by === 'tomb_b')).toBe(true);
    expect(decision).toMatchObject({ superseded: true, tombstoneId: 'tomb_b' });
    expect(state.l4_invariants.some((i) => /mysql/i.test(i.value))).toBe(false);
    expect(state.l3_graph.entities.has('MySQL replicas')).toBe(false);
    const inv = state.archive!.find((a) => a.kind === 'invariant');
    expect(inv?.kind === 'invariant' && inv.invariant.displacedBy).toBe('tomb_b');

    // With the second gone too, everything is live again
    expect(revertTombstone(state, 'tomb_b')).toBe(true);
    expect(state.archive!.filter((a) => a.reason === 'superseded')).toEqual([]);
    expect(decision).toMatchObject({ superseded: false, tombstoneId: undefined });
    expect(state.l4_invariants.some((i) => /mysql/i.test(i.value))).toBe(true);
  });
});
