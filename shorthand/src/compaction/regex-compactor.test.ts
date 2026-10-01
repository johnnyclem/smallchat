import { describe, it, expect } from 'vitest';
import { RegexCompactor } from './regex-compactor.js';
import type { ConversationMessage, CompactedState } from '../types.js';
import { CompactionLevel } from '../types.js';

function msg(id: string, role: 'user' | 'assistant', content: string, ts = Date.now()): ConversationMessage {
  return { id, role, content, timestamp: ts };
}

describe('RegexCompactor', () => {
  const compactor = new RegexCompactor();

  it('has tier "regex"', () => {
    expect(compactor.tier).toBe('regex');
  });

  it('extracts decisions from messages', async () => {
    const messages = [
      msg('1', 'user', "Let's go with PostgreSQL for the database."),
      msg('2', 'assistant', 'Sounds good, PostgreSQL it is.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.l2_summaries.length).toBeGreaterThan(0);
    const decisionSummary = state.l2_summaries.find((s) => s.topic.includes('PostgreSQL'));
    expect(decisionSummary).toBeDefined();
    expect(decisionSummary!.decisions[0].chosen).toBe('PostgreSQL for the database');
  });

  it('creates tombstones for corrections', async () => {
    const messages = [
      msg('1', 'user', "Let's use PostgreSQL.", 1000),
      msg('2', 'user', 'Actually, switch PostgreSQL to SQLite.', 2000),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.tombstones.length).toBeGreaterThan(0);
    const tombstone = state.tombstones.find((t) => t.correctedValue === 'SQLite');
    expect(tombstone).toBeDefined();
    expect(tombstone!.reason).toContain('switch PostgreSQL to SQLite');
  });

  it('extracts constraints as L4 invariants', async () => {
    const messages = [
      msg('1', 'user', 'The API must support pagination.'),
      msg('2', 'user', 'We must not exceed 100 items per page.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.l4_invariants.length).toBe(2);
  });

  it('filters out noise messages', async () => {
    const messages = [
      msg('1', 'user', 'ok'),
      msg('2', 'user', 'thanks'),
      msg('3', 'user', "Let's use React for the frontend."),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    // Only the substantive message should produce L1 entries
    expect(state.l1_compacted.length).toBe(1);
    expect(state.l1_compacted[0].originalMessageId).toBe('3');
  });

  it('handles code blocks by indexing, not summarizing', async () => {
    const messages = [
      msg('1', 'user', 'Here is the code:\n```typescript\nconst x = 42;\n```\nPlease review.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    // The code stays verbatim in L1 and is indexed in the span store
    expect(state.l1_compacted[0].compacted).toBe(messages[0].content);
    expect(Object.values(state.spans!).map((s) => s.text)).toEqual(['```typescript\nconst x = 42;\n```']);
  });

  it('computes token estimates', async () => {
    const messages = [
      msg('1', 'user', 'We chose JWT with RS256 for authentication.'),
      msg('2', 'assistant', 'Good choice. I will implement JWT with RS256.'),
    ];

    const state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);

    expect(state.totalTokenEstimate).toBeGreaterThan(0);
  });

  it('recompact promotes to deeper levels', async () => {
    const messages = [
      msg('1', 'user', "Let's use React.", 1000),
      msg('2', 'user', 'We chose PostgreSQL over MySQL.', 2000),
      msg('3', 'user', 'The app must support offline mode.', 3000),
    ];

    let state = await compactor.compact(messages, CompactionLevel.L1_COMPACTED);
    state = await compactor.recompact(state, CompactionLevel.L3_GRAPH);

    expect(state.l3_graph.entities.size).toBeGreaterThan(0);
  });

  it('extracts from/to for "X, not Y" corrections', async () => {
    const state = await compactor.compact(
      [msg('1', 'user', "Actually, we're using Postgres, not MySQL.")],
      CompactionLevel.L1_COMPACTED,
    );

    const tombstone = state.tombstones.find((t) => t.supersededContent === 'MySQL');
    expect(tombstone).toBeDefined();
    expect(tombstone!.correctedValue).toBe('Postgres');
  });

  it('extracts from/to for "instead of" / "rather than" corrections', async () => {
    const state = await compactor.compact(
      [
        msg('1', 'user', 'Correction: Redis instead of Memcached.'),
        msg('2', 'user', 'Actually, use pnpm rather than npm.'),
      ],
      CompactionLevel.L1_COMPACTED,
    );

    const pairs = state.tombstones.map((t) => [t.supersededContent, t.correctedValue]);
    expect(pairs).toContainEqual(['Memcached', 'Redis']);
    expect(pairs).toContainEqual(['npm', 'pnpm']);
  });

  it('extracts "use X instead of Y" without a correction keyword', async () => {
    const state = await compactor.compact(
      [
        msg('1', 'user', 'Use Postgres instead of MySQL.'),
        msg('2', 'user', 'Switch to pnpm rather than npm.'),
      ],
      CompactionLevel.L1_COMPACTED,
    );

    const pairs = state.tombstones.map((t) => [t.supersededContent, t.correctedValue]);
    expect(pairs).toContainEqual(['MySQL', 'Postgres']);
    expect(pairs).toContainEqual(['npm', 'pnpm']);
    expect(state.tombstones.every((t) => t.supersededContent !== '' && !/^of\b/i.test(t.correctedValue ?? ''))).toBe(true);
  });

  it('records one tombstone when several patterns match the same correction', async () => {
    const state = await compactor.compact(
      [msg('1', 'user', 'Actually, use Postgres instead of MySQL.')],
      CompactionLevel.L1_COMPACTED,
    );

    expect(state.tombstones.map((t) => [t.supersededContent, t.correctedValue])).toEqual([['MySQL', 'Postgres']]);
  });

  it('drops decision summaries a correction superseded', async () => {
    const compacted = await compactor.compact(
      [
        msg('1', 'user', "Let's use MySQL for storage."),
        msg('2', 'user', "Actually, we're using Postgres, not MySQL."),
      ],
      CompactionLevel.L1_COMPACTED,
    );
    const state = await compactor.recompact(compacted, CompactionLevel.L3_GRAPH);

    const stale = state.l2_summaries.filter((s) => /mysql/i.test(s.summary) && !/postgres/i.test(s.summary));
    expect(stale).toEqual([]);
    expect(state.l3_graph.entities.has('MySQL for storage')).toBe(false);
  });

  it('treats punctuated and "lol"-prefixed acks as noise', async () => {
    const acks = ['Thanks!', 'thanks!!', 'ok!', 'great!', 'lol ok, great', 'haha thanks.'];
    const state = await compactor.compact(
      [
        ...acks.map((a, i) => msg(`ack${i}`, 'user', a)),
        msg('real1', 'user', 'use Postgres'),
        msg('real2', 'user', 'ok, use Postgres'),
      ],
      CompactionLevel.L1_COMPACTED,
    );

    expect(state.l1_compacted.map((e) => e.originalMessageId)).toEqual(['real1', 'real2']);
  });

  it('prunes L1 entries superseded by a correction', async () => {
    const state = await compactor.compact(
      [
        msg('1', 'user', 'We decided to use MySQL for storage.', 1000),
        msg('2', 'assistant', 'Got it, LOG_BUDGET = 30.', 2000),
        msg('3', 'user', 'Compare MySQL and Postgres performance later.', 3000),
        msg('4', 'user', 'Switch MySQL to Postgres.', 4000),
        msg('5', 'user', 'Change the log budget to 100.', 5000),
      ],
      CompactionLevel.L1_COMPACTED,
    );

    const ids = state.l1_compacted.map((e) => e.originalMessageId);
    // Stale MySQL and LOG_BUDGET lines are gone; the line that already
    // names the corrected value and both corrections themselves stay
    expect(ids).toEqual(['3', '4', '5']);
    expect(state.tombstones.find((t) => t.key === 'MySQL')!.originalMessageId).toBe('1');
  });

  it('accepts ISO 8601 message timestamps and stores epoch milliseconds', async () => {
    const state = await compactor.compact(
      [
        { id: '1', role: 'user', content: "Let's use PostgreSQL.", timestamp: '2026-03-01T10:00:00.000Z' },
        { id: '2', role: 'user', content: 'Actually, switch PostgreSQL to SQLite.', timestamp: '2026-03-01T10:05:00.000Z' },
      ],
      CompactionLevel.L1_COMPACTED,
    );

    const tombstone = state.tombstones.find((t) => t.correctedValue === 'SQLite');
    expect(tombstone?.timestamp).toBe(Date.parse('2026-03-01T10:05:00.000Z'));
  });
});

describe('RegexCompactor fidelity (SH-06, SH-07, SH-08)', () => {
  const compactor = new RegexCompactor();

  it('keeps hedges, negations and modal words verbatim in L1 (SH-06)', async () => {
    const inputs = [
      "It's not just the cache, the primary DB is down too.",
      'I think the outage was caused by the DNS change, but maybe not.',
      'The migration is probably safe to run tonight.',
    ];
    const state = await compactor.compact(
      inputs.map((c, i) => msg(`h${i}`, 'user', c)),
      CompactionLevel.L1_COMPACTED,
    );
    expect(state.l1_compacted.map((e) => e.compacted)).toEqual(inputs);
  });

  it('keeps code blocks verbatim and indexes them in a content-addressed span store (SH-07)', async () => {
    const code = '```\nlocation /api { proxy_pass http://10.0.4.17:8443; proxy_read_timeout 97s; }\n```';
    const state = await compactor.compact(
      [msg('c1', 'user', `Here is the working nginx config:\n${code}`)],
      CompactionLevel.L1_COMPACTED,
    );

    const entry = state.l1_compacted[0];
    expect(entry.compacted).toContain('proxy_pass http://10.0.4.17:8443');
    expect(entry.compacted).not.toContain('[code block]');
    expect(entry.spanIds).toHaveLength(1);
    const span = state.spans![entry.spanIds![0]];
    expect(span.text).toBe(code);
    expect(span.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(span.sourceMessageId).toBe('c1');
  });

  it('keeps short answers to a question from the other role (SH-08)', async () => {
    const state = await compactor.compact(
      [
        msg('q1', 'assistant', 'Which port should the API listen on?'),
        msg('a1', 'user', '8080'),
        msg('q2', 'assistant', 'Should we deploy to prod on Friday?'),
        msg('a2', 'user', 'No.'),
      ],
      CompactionLevel.L1_COMPACTED,
    );

    const text = state.l1_compacted.map((e) => e.compacted).join('\n');
    expect(text).toContain('8080');
    expect(text).toMatch(/Friday\?[^\n]*No\./);
    const folded = state.l1_compacted.find((e) => e.originalMessageId === 'q2');
    expect(folded?.foldedMessageIds).toEqual(['a2']);
  });

  it('keeps short non-ack messages such as version numbers (SH-08)', async () => {
    const state = await compactor.compact([msg('v', 'user', 'v2')], CompactionLevel.L1_COMPACTED);
    expect(state.l1_compacted.map((e) => e.compacted)).toEqual(['v2']);
  });
});

describe('RegexCompactor recompaction (SH-20)', () => {
  const compactor = new RegexCompactor();

  it('is idempotent and drains summarized L1 entries into the archive', async () => {
    let state = await compactor.compact(
      Array.from({ length: 10 }, (_, i) => msg(`r${i}`, 'user', `We chose library${i} over lib${i}old for module${i}.`, i)),
      CompactionLevel.L1_COMPACTED,
    );
    state = await compactor.recompact(state, CompactionLevel.L2_SUMMARIES);
    const l2After1 = state.l2_summaries.length;
    const l1After1 = state.l1_compacted.length;
    state = await compactor.recompact(state, CompactionLevel.L2_SUMMARIES);
    expect(state.l2_summaries.length).toBe(l2After1);
    expect(state.l1_compacted.length).toBe(l1After1);
    expect(l1After1).toBeLessThan(10);
    expect(state.archive!.filter((a) => a.kind === 'l1' && a.reason === 'summarized').length).toBe(10 - l1After1);

    state = await compactor.recompact(state, CompactionLevel.L3_GRAPH);
    const edges = state.l3_graph.edges.length;
    expect(edges).toBeGreaterThan(0);
    state = await compactor.recompact(state, CompactionLevel.L3_GRAPH);
    expect(state.l3_graph.edges.length).toBe(edges);
  });
});

describe('RegexCompactor extraction cost (SH-21)', () => {
  // Bound: a 256 KB unterminated message is processed in well under a
  // second (it took ~10 s for 219 KB with the unbounded lazy patterns).
  it('processes a 256 KB unpunctuated message in linear time', async () => {
    const compactor = new RegexCompactor();
    const time = async (chars: number) => {
      const content = 'we use '.repeat(Math.ceil(chars / 7)).slice(0, chars);
      const start = performance.now();
      await compactor.compact([msg('big', 'tool' as 'user', content)], CompactionLevel.L1_COMPACTED);
      return performance.now() - start;
    };
    await time(4_096); // warm up the regex engine
    const small = await time(64 * 1024);
    const large = await time(256 * 1024);
    expect(large).toBeLessThan(1_000);
    // 4x the input may not cost more than ~8x the time (quadratic would be 16x)
    expect(large).toBeLessThan(Math.max(small * 8, 150));
  });
});

describe('extraction keeps versions, decimals, addresses and file names whole (SH-R3)', () => {
  const run = (...contents: string[]) =>
    new RegexCompactor().compact(
      contents.map((c, i) => msg(`m${i + 1}`, 'user', c, 1000 * (i + 1))),
      CompactionLevel.L1_COMPACTED,
    );

  it('in constraints (L4 invariants)', async () => {
    const state = await run('The API must listen on 10.0.0.5 only.', 'Builds must target ES2022 and Node 22.4.1.');
    expect(state.l4_invariants.map((i) => i.key)).toEqual(['listen on 10.0.0.5 only', 'target ES2022 and Node 22.4.1']);
    expect(state.l4_invariants[0].value).toBe('must listen on 10.0.0.5 only.');
  });

  it('in decisions (L2)', async () => {
    const state = await run("Let's use Python 3.12 for the worker.", 'We decided on config.prod.yaml over config.yaml.');
    expect(state.l2_summaries.map((s) => s.topic)).toEqual(['Decision: Python 3.12 for the worker', 'Decision: config.prod.yaml']);
    expect(state.l2_summaries[1].decisions[0].alternatives).toEqual([{ option: 'config.yaml', reason: '' }]);
  });

  it('in corrections, so a correction never archives a statement about another value', async () => {
    const state = await run('Node 20 is the CI floor for the docs site.', 'Switch the timeout from 2.5s to 4.0s.', 'Use Node 22.4 instead of Node 20.11.');
    expect(state.tombstones.map((t) => [t.supersededContent, t.correctedValue])).toEqual([
      ['the timeout from 2.5s', '4.0s'],
      ['Node 20.11', 'Node 22.4'],
    ]);
    expect(state.archive ?? []).toEqual([]);
    expect(state.l1_compacted.map((e) => e.originalMessageId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('a value is matched as a whole token: 20 is not 20.11, and 10.0.0 is not 10.0.0.5', async () => {
    const state = await run('We pin Node 20.11 in the lockfile.', 'The VPC range starts at 10.0.0.5 today.', 'Use Node 22 instead of Node 20.', 'Use 10.0.1 instead of 10.0.0.');
    expect(state.archive ?? []).toEqual([]);
    expect(state.tombstones.map((t) => t.originalMessageId)).toEqual(['m3', 'm4']);
  });
});
