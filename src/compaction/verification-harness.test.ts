import { describe, it, expect } from 'vitest';
import { VerificationHarness } from './verification-harness.js';
import { DefaultCompactor } from './compactor.js';
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
  return { id, role, content, timestamp: new Date().toISOString(), ...overrides };
}

function makeHistory(messages: ConversationMessage[]): ConversationHistory {
  return { sessionId: 'test-session', messages };
}

const richConversation: ConversationHistory = makeHistory([
  makeMessage('m1', 'user', 'We need to choose a database. I was thinking PostgreSQL.'),
  makeMessage('m2', 'assistant', 'PostgreSQL is solid. Let me look into the setup.'),
  makeMessage('m3', 'assistant', 'Decided to use PostgreSQL for the main store.'),
  makeMessage('m4', 'user', 'Actually, correction: use MySQL instead.'),
  makeMessage('m5', 'assistant', 'Switched to MySQL.'),
  makeMessage('m6', 'user', 'We rejected MongoDB because it does not support transactions well.'),
  makeMessage('m7', 'assistant', 'Going with Redis for caching.', {
    toolCall: { name: 'install_package', input: { pkg: 'redis' }, result: 'Installed redis@7.0' },
  }),
  makeMessage('m8', 'user', 'Set max_connections to 200.'),
  makeMessage('m9', 'assistant', 'Configured max_connections to 200. All set.'),
]);

const trivialConversation: ConversationHistory = makeHistory([
  makeMessage('m1', 'user', 'Hello'),
  makeMessage('m2', 'assistant', 'Hi there, how can I help?'),
]);

// ---------------------------------------------------------------------------
// VerificationHarness
// ---------------------------------------------------------------------------

describe('VerificationHarness', () => {
  const compactor = new DefaultCompactor();

  it('runs all three strategies by default', async () => {
    const harness = new VerificationHarness();
    const state = await compactor.compact(richConversation, 'L2');
    const result = harness.verify(state, richConversation);

    expect(result.recallTest).not.toBeNull();
    expect(result.invariantCheck).not.toBeNull();
    expect(result.informationTheoretic).not.toBeNull();
    expect(typeof result.passed).toBe('boolean');
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.sessionId).toBe('test-session');
  });

  it('respects strategy selection', async () => {
    const harness = new VerificationHarness({
      strategies: {
        recallTest: true,
        invariantCheck: false,
        informationTheoretic: false,
      },
    });
    const state = await compactor.compact(richConversation, 'L2');
    const result = harness.verify(state, richConversation);

    expect(result.recallTest).not.toBeNull();
    expect(result.invariantCheck).toBeNull();
    expect(result.informationTheoretic).toBeNull();
  });

  it('passes for trivial conversations', async () => {
    const harness = new VerificationHarness();
    const state = await compactor.compact(trivialConversation, 'L2');
    const result = harness.verify(state, trivialConversation);

    expect(result.passed).toBe(true);
  });

  it('produces a human-readable summary', async () => {
    const harness = new VerificationHarness();
    const state = await compactor.compact(richConversation, 'L2');
    const result = harness.verify(state, richConversation);

    expect(result.summary).toContain('Verification of L2 compaction');
    expect(result.summary).toContain('Strategy 1');
    expect(result.summary).toContain('Strategy 2');
    expect(result.summary).toContain('Strategy 3');
    expect(result.summary).toContain('Overall:');
  });

  it('reports token compression in summary', async () => {
    const harness = new VerificationHarness();
    const state = await compactor.compact(richConversation, 'L2');
    const result = harness.verify(state, richConversation);

    expect(result.summary).toContain('tokens');
    expect(result.summary).toContain('% of original');
  });

  it('verifies L0 compaction passes with high scores', async () => {
    const harness = new VerificationHarness();
    const state = await compactor.compact(richConversation, 'L0');
    const result = harness.verify(state, richConversation);

    // L0 is identity — should always pass
    if (result.invariantCheck) {
      expect(result.invariantCheck.passed).toBe(true);
    }
  });

  it('supports custom thresholds', async () => {
    // Very strict thresholds
    const strict = new VerificationHarness({
      minRecallScore: 0.99,
      minRetentionScore: 0.99,
    });
    const state = await compactor.compact(richConversation, 'L3');
    const result = strict.verify(state, richConversation);

    // L3 is aggressive compression — likely fails strict thresholds
    expect(result.summary).toContain('threshold: 99.0%');
  });

  it('supports warningsAreErrors mode', async () => {
    const strictInvariants = new VerificationHarness({
      warningsAreErrors: true,
      strategies: { recallTest: false, invariantCheck: true, informationTheoretic: false },
    });
    const state = await compactor.compact(richConversation, 'L2');
    const result = strictInvariants.verify(state, richConversation);

    if (result.invariantCheck && result.invariantCheck.warningCount > 0) {
      expect(result.passed).toBe(false);
    }
  });

  it('includes verifiedAt timestamp', async () => {
    const harness = new VerificationHarness();
    const state = await compactor.compact(richConversation, 'L2');
    const result = harness.verify(state, richConversation);

    expect(result.verifiedAt).toBeDefined();
    expect(new Date(result.verifiedAt).getTime()).not.toBeNaN();
  });

  it('verifies across compaction levels L0→L3', async () => {
    const harness = new VerificationHarness({ minRecallScore: 0, minRetentionScore: 0 });
    const levels = ['L0', 'L1', 'L2', 'L3'] as const;

    for (const level of levels) {
      const state = await compactor.compact(richConversation, level);
      const result = harness.verify(state, richConversation);

      expect(result.compactedState.level).toBe(level);
      expect(result.summary).toContain(`Verification of ${level}`);
    }
  });

  it('verifies re-compacted states', async () => {
    const harness = new VerificationHarness({ minRecallScore: 0, minRetentionScore: 0 });
    const l1 = await compactor.compact(richConversation, 'L1');
    const l3 = await compactor.recompact(l1, 'L3');
    const result = harness.verify(l3, richConversation);

    expect(result.compactedState.roundNumber).toBe(2);
    expect(result.summary).toContain('round 2');
  });
});
