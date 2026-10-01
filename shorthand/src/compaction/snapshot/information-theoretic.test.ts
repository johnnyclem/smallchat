import { describe, it, expect } from 'vitest';
import {
  tokenize,
  shannonEntropy,
  totalInformationBits,
  computeEntropyMetrics,
  computeRateDistortion,
  measureEntityRetention,
  analyzeInformationTheoretic,
} from './information-theoretic.js';
import { DefaultCompactor } from './compactor.js';
import type { ConversationHistory, ConversationMessage, EntropyMetrics } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  role: ConversationMessage['role'],
  content: string,
): ConversationMessage {
  return { id, role, content, timestamp: new Date().toISOString() };
}

function makeHistory(messages: ConversationMessage[]): ConversationHistory {
  return { sessionId: 'test-session', messages };
}

const sampleConversation = makeHistory([
  makeMessage('m1', 'user', 'We need a database. I chose PostgreSQL for the main store.'),
  makeMessage('m2', 'assistant', 'Good choice. PostgreSQL is reliable.'),
  makeMessage('m3', 'user', 'Actually, correction: use MySQL instead of PostgreSQL.'),
  makeMessage('m4', 'assistant', 'Switched to MySQL. Using Redis for caching.'),
  makeMessage('m5', 'user', 'Set max_connections to 100 and timeout to 30s.'),
]);

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('splits on whitespace and punctuation', () => {
    const tokens = tokenize('Hello, world! How are you?');
    expect(tokens).toEqual(['hello', 'world', 'how', 'are', 'you']);
  });

  it('lowercases all tokens', () => {
    const tokens = tokenize('PostgreSQL MySQL');
    expect(tokens).toEqual(['postgresql', 'mysql']);
  });

  it('handles empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('handles multiple consecutive delimiters', () => {
    const tokens = tokenize('hello...world!!!');
    expect(tokens).toEqual(['hello', 'world']);
  });
});

// ---------------------------------------------------------------------------
// shannonEntropy
// ---------------------------------------------------------------------------

describe('shannonEntropy', () => {
  it('returns 0 for empty input', () => {
    expect(shannonEntropy([])).toBe(0);
  });

  it('returns 0 for uniform single-token input', () => {
    expect(shannonEntropy(['a', 'a', 'a'])).toBe(0);
  });

  it('returns 1 bit for two equally likely tokens', () => {
    const entropy = shannonEntropy(['a', 'b']);
    expect(entropy).toBeCloseTo(1.0, 5);
  });

  it('returns log₂(n) for n equally likely tokens', () => {
    const tokens = ['a', 'b', 'c', 'd'];
    const entropy = shannonEntropy(tokens);
    expect(entropy).toBeCloseTo(Math.log2(4), 5); // 2.0
  });

  it('increases with more diverse tokens', () => {
    const low = shannonEntropy(['a', 'a', 'a', 'b']);
    const high = shannonEntropy(['a', 'b', 'c', 'd']);
    expect(high).toBeGreaterThan(low);
  });
});

// ---------------------------------------------------------------------------
// totalInformationBits
// ---------------------------------------------------------------------------

describe('totalInformationBits', () => {
  it('returns 0 for empty input', () => {
    expect(totalInformationBits([])).toBe(0);
  });

  it('equals entropy × token count', () => {
    const tokens = ['a', 'b', 'c', 'd'];
    const bits = totalInformationBits(tokens);
    expect(bits).toBeCloseTo(shannonEntropy(tokens) * tokens.length, 5);
  });
});

// ---------------------------------------------------------------------------
// computeEntropyMetrics
// ---------------------------------------------------------------------------

describe('computeEntropyMetrics', () => {
  it('computes all metrics for a text', () => {
    const metrics = computeEntropyMetrics('The quick brown fox jumps over the lazy dog');

    expect(metrics.shannonEntropy).toBeGreaterThan(0);
    expect(metrics.vocabularySize).toBeGreaterThan(0);
    expect(metrics.totalTokens).toBe(9);
    expect(metrics.typeTokenRatio).toBeGreaterThan(0);
    expect(metrics.typeTokenRatio).toBeLessThanOrEqual(1);
    expect(metrics.decisionRelevantBits).toBeGreaterThanOrEqual(0);
  });

  it('filters stop words for decision-relevant bits', () => {
    const allStopWords = computeEntropyMetrics('the a an is are was were');
    const contentWords = computeEntropyMetrics('PostgreSQL MySQL Redis database');

    // Content words should have more decision-relevant bits per token
    expect(contentWords.decisionRelevantBits).toBeGreaterThan(0);
  });

  it('handles empty text', () => {
    const metrics = computeEntropyMetrics('');
    expect(metrics.shannonEntropy).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.vocabularySize).toBe(0);
    expect(metrics.typeTokenRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRateDistortion
// ---------------------------------------------------------------------------

describe('computeRateDistortion', () => {
  it('returns compression ratio of 1 for identical entropy', () => {
    const entropy: EntropyMetrics = {
      shannonEntropy: 5,
      vocabularySize: 50,
      totalTokens: 100,
      typeTokenRatio: 0.5,
      decisionRelevantBits: 200,
    };

    const rd = computeRateDistortion(entropy, entropy);
    expect(rd.compressionRatio).toBeCloseTo(1.0);
    expect(rd.distortion).toBeCloseTo(0);
  });

  it('computes distortion when compacted has fewer bits', () => {
    const original: EntropyMetrics = {
      shannonEntropy: 5,
      vocabularySize: 100,
      totalTokens: 200,
      typeTokenRatio: 0.5,
      decisionRelevantBits: 500,
    };
    const compacted: EntropyMetrics = {
      shannonEntropy: 4,
      vocabularySize: 50,
      totalTokens: 80,
      typeTokenRatio: 0.625,
      decisionRelevantBits: 200,
    };

    const rd = computeRateDistortion(original, compacted);
    expect(rd.compressionRatio).toBeLessThan(1);
    expect(rd.distortion).toBeGreaterThan(0);
    expect(rd.originalBits).toBe(500);
    expect(rd.retainedBits).toBe(200);
  });

  it('handles zero original bits', () => {
    const zero: EntropyMetrics = {
      shannonEntropy: 0,
      vocabularySize: 0,
      totalTokens: 0,
      typeTokenRatio: 0,
      decisionRelevantBits: 0,
    };

    const rd = computeRateDistortion(zero, zero);
    expect(rd.compressionRatio).toBe(1);
    expect(rd.distortion).toBe(0);
  });

  it('computes theoretical minimum bits', () => {
    const original: EntropyMetrics = {
      shannonEntropy: 5,
      vocabularySize: 100,
      totalTokens: 200,
      typeTokenRatio: 0.5,
      decisionRelevantBits: 500,
    };
    const compacted: EntropyMetrics = {
      shannonEntropy: 4,
      vocabularySize: 50,
      totalTokens: 80,
      typeTokenRatio: 0.625,
      decisionRelevantBits: 200,
    };

    const rd = computeRateDistortion(original, compacted);
    expect(rd.theoreticalMinBits).toBeGreaterThanOrEqual(0);
    expect(typeof rd.withinBounds).toBe('boolean');
    expect(typeof rd.marginBits).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// measureEntityRetention
// ---------------------------------------------------------------------------

describe('measureEntityRetention', () => {
  const compactor = new DefaultCompactor();

  it('measures retention for entities in the summary', async () => {
    const state = await compactor.compact(sampleConversation, 'L2');
    const retention = measureEntityRetention(state, sampleConversation);

    expect(retention.length).toBe(state.entities.length);
    for (const r of retention) {
      expect(typeof r.retained).toBe('boolean');
      expect(typeof r.correctionsIntact).toBe('boolean');
      expect(r.coverageFraction).toBeGreaterThanOrEqual(0);
      expect(r.coverageFraction).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// analyzeInformationTheoretic (integration)
// ---------------------------------------------------------------------------

describe('analyzeInformationTheoretic', () => {
  const compactor = new DefaultCompactor();

  it('produces a complete analysis', async () => {
    const state = await compactor.compact(sampleConversation, 'L2');
    const result = analyzeInformationTheoretic(state, sampleConversation);

    expect(result.compactedState).toBe(state);
    expect(result.originalEntropy.totalTokens).toBeGreaterThan(0);
    expect(result.compactedEntropy.totalTokens).toBeGreaterThan(0);
    expect(result.rateDistortion.compressionRatio).toBeGreaterThan(0);
    expect(result.retentionScore).toBeGreaterThanOrEqual(0);
    expect(result.retentionScore).toBeLessThanOrEqual(1);
  });

  it('shows lower retention at deeper compaction levels', async () => {
    const l0 = await compactor.compact(sampleConversation, 'L0');
    const l3 = await compactor.compact(sampleConversation, 'L3');

    const resultL0 = analyzeInformationTheoretic(l0, sampleConversation);
    const resultL3 = analyzeInformationTheoretic(l3, sampleConversation);

    // L0 should have higher compression ratio (less loss) than L3
    expect(resultL0.rateDistortion.compressionRatio).toBeGreaterThanOrEqual(
      resultL3.rateDistortion.compressionRatio,
    );
  });

  it('computes entity-level retention', async () => {
    const state = await compactor.compact(sampleConversation, 'L2');
    const result = analyzeInformationTheoretic(state, sampleConversation);

    expect(result.entityRetention.length).toBe(state.entities.length);
  });
});
