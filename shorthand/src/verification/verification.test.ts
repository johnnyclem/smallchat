import { describe, it, expect } from 'vitest';
import { InvariantChecker } from './invariant-checker.js';
import { RecallTester } from './recall-tester.js';
import { RegexCompactor } from '../compaction/regex-compactor.js';
import { CompactionEngine } from '../compaction/compaction-engine.js';
import type { CompactedState, ContextFrame, ConversationMessage } from '../types.js';
import { CompactionLevel } from '../types.js';

function msg(id: string, role: 'user' | 'assistant', content: string, ts = Date.now()): ConversationMessage {
  return { id, role, content, timestamp: ts };
}

describe('InvariantChecker', () => {
  const checker = new InvariantChecker();

  it('passes on a clean state', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };

    const result = checker.verify(state);
    expect(result.passed).toBe(true);
  });

  it('passes when entities have provenance', async () => {
    const compactor = new RegexCompactor();
    const messages = [
      msg('1', 'user', "Let's build a REST API using Express."),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);
    const result = checker.verify(state);

    const provenanceCheck = result.checks.find((c) => c.name === 'entity-provenance');
    expect(provenanceCheck?.passed).toBe(true);
  });

  it('reports temporal ordering issues', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: {
        entities: new Map([
          ['test', { name: 'test', type: 'component', properties: {}, firstMention: '', lastMention: '1' }],
        ]),
        edges: [],
      },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };

    const result = checker.verify(state);
    const temporalCheck = result.checks.find((c) => c.name === 'temporal-ordering');
    expect(temporalCheck?.passed).toBe(false);
  });
});

describe('RecallTester', () => {
  const tester = new RecallTester();

  it('generates questions from conversation', () => {
    const messages = [
      msg('1', 'user', "Let's use PostgreSQL for the database."),
      msg('2', 'user', 'We rejected MySQL because of licensing concerns.'),
    ];

    const questions = tester.generateQuestions(messages);
    expect(questions.length).toBeGreaterThan(0);
  });

  it('evaluates recall against compacted state', async () => {
    const compactor = new RegexCompactor();
    const messages = [
      msg('1', 'user', "We chose PostgreSQL for the database.", 1000),
      msg('2', 'user', 'We rejected MySQL because of licensing.', 2000),
      msg('3', 'user', 'Actually, switch to SQLite instead.', 3000),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);
    const questions = tester.generateQuestions(messages);
    const result = tester.evaluateRecall(questions, state);

    expect(result.recallScore).toBeDefined();
    expect(result.recallScore!).toBeGreaterThanOrEqual(0);
    expect(result.recallScore!).toBeLessThanOrEqual(1);
  });

  it('returns perfect recall when no questions generated', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
    };

    const result = tester.evaluateRecall([], state);
    expect(result.passed).toBe(true);
    expect(result.recallScore).toBe(1.0);
  });
});

describe('InvariantChecker is level-complete and frame-aware (SH-25)', () => {
  const checker = new InvariantChecker();
  const tombstone = {
    supersededContent: 'MySQL',
    originalMessageId: 'm1',
    correctionMessageId: 'm3',
    reason: 'Actually, use Postgres instead of MySQL.',
    timestamp: 3,
    correctedValue: 'Postgres',
  };
  const clean = (): CompactedState => ({
    l0_messages: [],
    l1_compacted: [{ originalMessageId: 'm3', compacted: 'Actually, use Postgres instead of MySQL.', importance: 0.4, timestamp: 3 }],
    l2_summaries: [],
    l3_graph: { entities: new Map(), edges: [] },
    l4_invariants: [],
    tombstones: [tombstone],
    totalTokenEstimate: 0,
  });

  it('flags a stale line in the rendered frame even when the state is clean', () => {
    const state = clean();
    expect(checker.verify(state).passed).toBe(true);

    const frame: ContextFrame = {
      tokenBudget: 100,
      tokenUsage: 20,
      omitted: {},
      sections: [
        {
          kind: 'history',
          level: CompactionLevel.L1_COMPACTED,
          content: 'We store orders in MySQL.',
          tokenEstimate: 7,
          omitted: 0,
          items: [{ text: 'We store orders in MySQL.', sources: ['m1'] }],
        },
      ],
    };
    const result = checker.verify(state, { frame });
    const check = result.checks.find((c) => c.name === 'frame-staleness')!;
    expect(check.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('checks real temporal ordering, not just field presence', () => {
    const state = clean();
    state.l1_compacted.push(
      { originalMessageId: 'm1', compacted: 'first', importance: 0.1, timestamp: 1 },
      { originalMessageId: 'm5', compacted: 'fifth', importance: 0.1, timestamp: 5 },
    );
    state.l3_graph.entities.set('Kafka', { name: 'Kafka', type: 'technology', properties: {}, firstMention: 'm5', lastMention: 'm1' });
    const check = checker.verify(state).checks.find((c) => c.name === 'temporal-ordering')!;
    expect(check.passed).toBe(false);
    expect(check.message).toMatch(/Kafka/);
  });
});

describe('RecallTester scores what the model sees (SH-25)', () => {
  const tester = new RecallTester();

  it('does not credit a superseded value that survives only in tombstone text', () => {
    const state: CompactedState = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [
        {
          supersededContent: 'MySQL',
          originalMessageId: 'm1',
          correctionMessageId: 'm2',
          reason: 'Actually, use Postgres instead of MySQL.',
          timestamp: 2,
          correctedValue: 'Postgres',
        },
      ],
      totalTokenEstimate: 0,
    };
    const questions = [
      { category: 'entity' as const, question: 'db?', expectedAnswer: 'MySQL', sourceMessages: ['m1'] },
      { category: 'entity' as const, question: 'cache?', expectedAnswer: 'Redis', sourceMessages: ['m0'] },
    ];
    const result = tester.evaluateRecall(questions, state);
    expect(result.recallScore).toBe(0);
    expect(result.checks.find((c) => c.message.includes('MySQL'))!.name).toBe('recall:superseded');
  });

  it('evaluates a context frame, so budget truncation lowers recall', async () => {
    const engine = new CompactionEngine({ memtableSize: 0 });
    const messages = Array.from({ length: 12 }, (_, i) =>
      msg(`f${i}`, 'user', `We selected Library${i}x for subsystem number ${i} after a long evaluation.`, i + 1));
    await engine.addMessages(messages);
    const questions = tester.generateQuestions(messages);
    expect(questions.length).toBeGreaterThan(0);

    const full = tester.evaluateRecall(questions, engine.getState());
    const tight = tester.evaluateRecall(questions, engine.buildContextFrame(60));
    expect(full.recallScore).toBe(1);
    expect(tight.recallScore!).toBeLessThan(0.5);
  });
});
