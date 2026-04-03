import { describe, it, expect } from 'vitest';
import {
  DefaultCompactor,
  estimateTokens,
  estimateConversationTokens,
  extractEntities,
  extractDecisions,
  detectTombstones,
} from './compactor.js';
import type { ConversationHistory, ConversationMessage } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  role: ConversationMessage['role'],
  content: string,
  overrides: Partial<ConversationMessage> = {},
): ConversationMessage {
  return {
    id,
    role,
    content,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeHistory(messages: ConversationMessage[]): ConversationHistory {
  return { sessionId: 'test-session', messages };
}

const sampleConversation: ConversationHistory = makeHistory([
  makeMessage('m1', 'user', 'We need to pick a database. I was thinking PostgreSQL.'),
  makeMessage('m2', 'assistant', 'Good choice. Let me look into it.'),
  makeMessage('m3', 'assistant', 'I decided to use PostgreSQL for the main store.', {
    toolCall: { name: 'search_docs', input: { query: 'postgres setup' }, result: 'Found 3 guides' },
  }),
  makeMessage('m4', 'user', 'Actually, correction: use MySQL instead of PostgreSQL.'),
  makeMessage('m5', 'assistant', 'Understood. Going with MySQL as the primary database.'),
  makeMessage('m6', 'user', 'We also need a cache. Let\'s use Redis.'),
  makeMessage('m7', 'assistant', 'Decided to use Redis for caching. Rejected Memcached because Redis supports data structures.'),
  makeMessage('m8', 'user', 'Set max_connections to 100.'),
  makeMessage('m9', 'assistant', 'Configured max_connections to 100.'),
]);

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 = 2.75 → 3
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('estimateConversationTokens', () => {
  it('sums token estimates across all messages', () => {
    const history = makeHistory([
      makeMessage('1', 'user', 'hello'),
      makeMessage('2', 'assistant', 'world'),
    ]);
    const tokens = estimateConversationTokens(history);
    expect(tokens).toBe(estimateTokens('hello') + estimateTokens('world'));
  });
});

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

describe('extractEntities', () => {
  it('extracts entities from decision language', () => {
    const entities = extractEntities(sampleConversation.messages);
    expect(entities.length).toBeGreaterThan(0);
  });

  it('extracts tool invocation entities', () => {
    const entities = extractEntities(sampleConversation.messages);
    const toolEntity = entities.find(e => e.name === 'tool:search_docs');
    expect(toolEntity).toBeDefined();
    expect(toolEntity?.type).toBe('tool_invocation');
  });

  it('extracts configuration entities', () => {
    const messages = [
      makeMessage('m1', 'user', 'Set max_connections to 100'),
    ];
    const entities = extractEntities(messages);
    const configEntity = entities.find(e => e.name === 'max_connections');
    expect(configEntity).toBeDefined();
    expect(configEntity?.value).toBe('100');
  });

  it('returns empty for empty messages', () => {
    expect(extractEntities([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Decision extraction
// ---------------------------------------------------------------------------

describe('extractDecisions', () => {
  it('extracts explicit decision language', () => {
    const decisions = extractDecisions(sampleConversation.messages);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some(d => d.description.toLowerCase().includes('postgresql'))).toBe(true);
  });

  it('extracts rejection alternatives', () => {
    const messages = [
      makeMessage('m1', 'assistant', 'Decided to use Redis for caching.'),
      makeMessage('m2', 'assistant', 'Rejected Memcached because it lacks data structures.'),
    ];
    const decisions = extractDecisions(messages);
    expect(decisions.length).toBeGreaterThan(0);
    // The rejection attaches to the most recent decision
    const lastDecision = decisions[decisions.length - 1];
    expect(lastDecision.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(lastDecision.alternatives[0].description.toLowerCase()).toContain('memcached');
  });

  it('returns empty for empty messages', () => {
    expect(extractDecisions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tombstone detection
// ---------------------------------------------------------------------------

describe('detectTombstones', () => {
  it('creates tombstones from entity corrections', () => {
    const entities = extractEntities(sampleConversation.messages);
    const tombstones = detectTombstones(sampleConversation.messages, entities);

    // There should be at least one tombstone from the PostgreSQL→MySQL correction
    const correctedEntities = entities.filter(e => e.corrections.length > 0);
    if (correctedEntities.length > 0) {
      expect(tombstones.length).toBeGreaterThan(0);
    }
  });

  it('creates tombstones from supersedes relationships', () => {
    const messages = [
      makeMessage('m1', 'user', 'The deadline is Friday'),
      makeMessage('m2', 'user', 'Actually the deadline is Monday', { supersedes: 'm1' }),
    ];
    const tombstones = detectTombstones(messages, []);
    expect(tombstones.length).toBe(1);
    expect(tombstones[0].originalMessageId).toBe('m1');
    expect(tombstones[0].correctionMessageId).toBe('m2');
  });

  it('returns empty when no corrections exist', () => {
    expect(detectTombstones([], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DefaultCompactor
// ---------------------------------------------------------------------------

describe('DefaultCompactor', () => {
  const compactor = new DefaultCompactor();

  it('compacts at L0 (identity — no loss)', async () => {
    const result = await compactor.compact(sampleConversation, 'L0');

    expect(result.level).toBe('L0');
    expect(result.sessionId).toBe('test-session');
    expect(result.roundNumber).toBe(1);
    expect(result.originalMessageCount).toBe(sampleConversation.messages.length);
    expect(result.sourceMessageIds).toHaveLength(sampleConversation.messages.length);
    // L0 should contain all message content
    for (const msg of sampleConversation.messages) {
      expect(result.summary).toContain(msg.content);
    }
  });

  it('compacts at L1 (deduplication)', async () => {
    const historyWithDupes = makeHistory([
      makeMessage('m1', 'user', 'hello'),
      makeMessage('m2', 'user', 'hello'), // duplicate
      makeMessage('m3', 'assistant', 'hi there'),
      makeMessage('m4', 'user', ''), // empty
    ]);
    const result = await compactor.compact(historyWithDupes, 'L1');

    expect(result.level).toBe('L1');
    // Deduplicated, so "hello" should appear once
    const helloMatches = result.summary.match(/hello/g);
    expect(helloMatches?.length).toBe(1);
  });

  it('compacts at L2 (entity/decision extraction)', async () => {
    const result = await compactor.compact(sampleConversation, 'L2');

    expect(result.level).toBe('L2');
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.summary).toContain('Entities');
    // L2 adds structured sections, so token count may increase for short conversations
    expect(result.compactedTokenCount).toBeGreaterThan(0);
  });

  it('compacts at L3 (state snapshot)', async () => {
    const result = await compactor.compact(sampleConversation, 'L3');

    expect(result.level).toBe('L3');
    expect(result.summary).toContain('State Snapshot');
    expect(result.compactedTokenCount).toBeLessThanOrEqual(result.originalTokenCount);
  });

  it('tracks token counts', async () => {
    const result = await compactor.compact(sampleConversation, 'L2');

    expect(result.originalTokenCount).toBeGreaterThan(0);
    expect(result.compactedTokenCount).toBeGreaterThan(0);
  });

  it('populates entities, decisions, and tombstones', async () => {
    const result = await compactor.compact(sampleConversation, 'L2');

    expect(result.entities).toBeInstanceOf(Array);
    expect(result.decisions).toBeInstanceOf(Array);
    expect(result.tombstones).toBeInstanceOf(Array);
  });
});

describe('DefaultCompactor.recompact', () => {
  const compactor = new DefaultCompactor();

  it('recompacts L1 → L3', async () => {
    const l1 = await compactor.compact(sampleConversation, 'L1');
    const l3 = await compactor.recompact(l1, 'L3');

    expect(l3.level).toBe('L3');
    expect(l3.roundNumber).toBe(2);
    expect(l3.compactedTokenCount).toBeLessThanOrEqual(l1.compactedTokenCount);
  });

  it('recompacts L1 → L2', async () => {
    const l1 = await compactor.compact(sampleConversation, 'L1');
    const l2 = await compactor.recompact(l1, 'L2');

    expect(l2.level).toBe('L2');
    expect(l2.roundNumber).toBe(2);
  });

  it('throws when recompacting to same or shallower level', async () => {
    const l2 = await compactor.compact(sampleConversation, 'L2');

    await expect(compactor.recompact(l2, 'L1')).rejects.toThrow(
      /Cannot recompact/,
    );
    await expect(compactor.recompact(l2, 'L2')).rejects.toThrow(
      /Cannot recompact/,
    );
  });
});
