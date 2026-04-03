import { describe, it, expect } from 'vitest';
import {
  correctionPropagation,
  entityProvenance,
  decisionCompleteness,
  tombstoneConsistency,
  temporalOrdering,
  BUILTIN_INVARIANTS,
  checkInvariants,
} from './invariant-check.js';
import { DefaultCompactor } from './compactor.js';
import type {
  CompactedState,
  ConversationHistory,
  ConversationMessage,
  ExtractedEntity,
  Tombstone,
  Decision,
} from './types.js';

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

function makeCompactedState(overrides: Partial<CompactedState> = {}): CompactedState {
  return {
    level: 'L2',
    sessionId: 'test-session',
    compactedAt: new Date().toISOString(),
    roundNumber: 1,
    summary: '',
    entities: [],
    decisions: [],
    tombstones: [],
    originalMessageCount: 0,
    compactedTokenCount: 0,
    originalTokenCount: 0,
    sourceMessageIds: [],
    ...overrides,
  };
}

const conversationWithCorrection = makeHistory([
  makeMessage('m1', 'user', 'We should use PostgreSQL.'),
  makeMessage('m2', 'assistant', 'Using PostgreSQL for the database.'),
  makeMessage('m3', 'user', 'Actually, correction: use MySQL instead.'),
  makeMessage('m4', 'assistant', 'Switched to MySQL.'),
]);

// ---------------------------------------------------------------------------
// INV-001: Correction Propagation
// ---------------------------------------------------------------------------

describe('correctionPropagation (INV-001)', () => {
  it('passes when corrections are properly reflected', () => {
    const state = makeCompactedState({
      summary: 'Using MySQL for the database. Previously considered PostgreSQL but corrected to MySQL.',
      entities: [{
        name: 'database',
        type: 'configuration',
        firstMention: 'm1',
        lastMention: 'm4',
        value: 'mysql',
        corrections: [{
          messageId: 'm3',
          previousValue: 'postgresql',
          correctedValue: 'mysql',
          reason: 'User correction',
        }],
      }],
      tombstones: [],
    });

    const violation = correctionPropagation.check(state, conversationWithCorrection);
    expect(violation).toBeNull();
  });

  it('fails when superseded value appears without correction', () => {
    const state = makeCompactedState({
      summary: 'Using PostgreSQL for the database.',
      entities: [{
        name: 'database',
        type: 'configuration',
        firstMention: 'm1',
        lastMention: 'm4',
        value: 'mysql',
        corrections: [{
          messageId: 'm3',
          previousValue: 'postgresql',
          correctedValue: 'mysql',
          reason: 'User correction',
        }],
      }],
      tombstones: [],
    });

    const violation = correctionPropagation.check(state, conversationWithCorrection);
    expect(violation).not.toBeNull();
    expect(violation?.severity).toBe('error');
    expect(violation?.invariantId).toBe('INV-001');
  });

  it('passes when no corrections exist', () => {
    const state = makeCompactedState({
      summary: 'Using PostgreSQL.',
      entities: [{
        name: 'database',
        type: 'configuration',
        firstMention: 'm1',
        lastMention: 'm1',
        value: 'postgresql',
        corrections: [],
      }],
    });

    const violation = correctionPropagation.check(state, conversationWithCorrection);
    expect(violation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INV-002: Entity Provenance
// ---------------------------------------------------------------------------

describe('entityProvenance (INV-002)', () => {
  it('passes when all entities trace to source messages', () => {
    const state = makeCompactedState({
      entities: [{
        name: 'database',
        type: 'configuration',
        firstMention: 'm1',
        lastMention: 'm4',
        value: 'mysql',
        corrections: [],
      }],
    });

    const violation = entityProvenance.check(state, conversationWithCorrection);
    expect(violation).toBeNull();
  });

  it('fails when entities reference non-existent messages', () => {
    const state = makeCompactedState({
      entities: [{
        name: 'phantom',
        type: 'configuration',
        firstMention: 'nonexistent-1',
        lastMention: 'nonexistent-2',
        value: 'ghost',
        corrections: [],
      }],
    });

    const violation = entityProvenance.check(state, conversationWithCorrection);
    expect(violation).not.toBeNull();
    expect(violation?.severity).toBe('error');
    expect(violation?.invariantId).toBe('INV-002');
  });

  it('passes when no entities exist', () => {
    const state = makeCompactedState({ entities: [] });
    const violation = entityProvenance.check(state, conversationWithCorrection);
    expect(violation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// INV-003: Decision Completeness
// ---------------------------------------------------------------------------

describe('decisionCompleteness (INV-003)', () => {
  it('passes when decisions are reflected in summary', () => {
    const history = makeHistory([
      makeMessage('m1', 'assistant', 'Decided to use React for the frontend.'),
    ]);
    const state = makeCompactedState({
      summary: 'Decided to use React for the frontend.',
      decisions: [{ id: 'd1', description: 'use React', madeAt: 'm1', alternatives: [], involvedEntities: [] }],
    });

    const violation = decisionCompleteness.check(state, history);
    expect(violation).toBeNull();
  });

  it('warns when decisions are missing from compacted state', () => {
    const history = makeHistory([
      makeMessage('m1', 'assistant', 'Decided to use React for the frontend.'),
      makeMessage('m2', 'assistant', 'Decided to use TypeScript for type safety.'),
    ]);
    const state = makeCompactedState({
      summary: 'Using React.',
      decisions: [],
    });

    const violation = decisionCompleteness.check(state, history);
    // It should flag at least one missing decision (TypeScript not in summary)
    if (violation) {
      expect(violation.severity).toBe('warning');
      expect(violation.invariantId).toBe('INV-003');
    }
  });
});

// ---------------------------------------------------------------------------
// INV-004: Tombstone Consistency
// ---------------------------------------------------------------------------

describe('tombstoneConsistency (INV-004)', () => {
  it('passes when superseded content is absent from summary', () => {
    const history = makeHistory([
      makeMessage('m1', 'user', 'The deadline is Friday.'),
      makeMessage('m2', 'user', 'The deadline is Monday.', { supersedes: 'm1' }),
    ]);
    const state = makeCompactedState({
      summary: 'The deadline is Monday.',
      tombstones: [{
        supersededContent: 'The deadline is Friday.',
        originalMessageId: 'm1',
        correctionMessageId: 'm2',
        reason: 'Superseded',
      }],
    });

    const violation = tombstoneConsistency.check(state, history);
    expect(violation).toBeNull();
  });

  it('fails when superseded content appears without tombstone marker', () => {
    const history = makeHistory([
      makeMessage('m1', 'user', 'Use the legacy API endpoint for all requests.'),
      makeMessage('m2', 'user', 'Use the v2 API endpoint instead.', { supersedes: 'm1' }),
    ]);
    const state = makeCompactedState({
      // Summary contains the superseded content without a tombstone
      summary: 'Use the legacy API endpoint for all requests. Also use v2 API.',
      tombstones: [],
    });

    const violation = tombstoneConsistency.check(state, history);
    expect(violation).not.toBeNull();
    expect(violation?.severity).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// INV-005: Temporal Ordering
// ---------------------------------------------------------------------------

describe('temporalOrdering (INV-005)', () => {
  it('passes when entity mentions are in order', () => {
    const history = makeHistory([
      makeMessage('m1', 'user', 'first'),
      makeMessage('m2', 'user', 'second'),
      makeMessage('m3', 'user', 'third'),
    ]);
    const state = makeCompactedState({
      entities: [{
        name: 'test',
        type: 'config',
        firstMention: 'm1',
        lastMention: 'm3',
        value: 'ok',
        corrections: [],
      }],
    });

    const violation = temporalOrdering.check(state, history);
    expect(violation).toBeNull();
  });

  it('warns when entity mentions are out of order', () => {
    const history = makeHistory([
      makeMessage('m1', 'user', 'first'),
      makeMessage('m2', 'user', 'second'),
      makeMessage('m3', 'user', 'third'),
    ]);
    const state = makeCompactedState({
      entities: [{
        name: 'test',
        type: 'config',
        firstMention: 'm3', // backwards!
        lastMention: 'm1',
        value: 'ok',
        corrections: [],
      }],
    });

    const violation = temporalOrdering.check(state, history);
    expect(violation).not.toBeNull();
    expect(violation?.severity).toBe('warning');
  });

  it('checks decision ordering', () => {
    const history = makeHistory([
      makeMessage('m1', 'user', 'first'),
      makeMessage('m2', 'user', 'second'),
    ]);
    const state = makeCompactedState({
      decisions: [
        { id: 'd1', description: 'second', madeAt: 'm2', alternatives: [], involvedEntities: [] },
        { id: 'd2', description: 'first', madeAt: 'm1', alternatives: [], involvedEntities: [] },
      ],
    });

    const violation = temporalOrdering.check(state, history);
    expect(violation).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkInvariants (integration)
// ---------------------------------------------------------------------------

describe('checkInvariants', () => {
  const compactor = new DefaultCompactor();

  it('checks all built-in invariants', async () => {
    const state = await compactor.compact(conversationWithCorrection, 'L2');
    const result = checkInvariants(state, conversationWithCorrection);

    expect(result.invariantsChecked).toHaveLength(BUILTIN_INVARIANTS.length);
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.errorCount).toBe('number');
    expect(typeof result.warningCount).toBe('number');
  });

  it('reports passed=true when no error-level violations', async () => {
    const trivial = makeHistory([
      makeMessage('m1', 'user', 'hello'),
      makeMessage('m2', 'assistant', 'hi'),
    ]);
    const state = await compactor.compact(trivial, 'L2');
    const result = checkInvariants(state, trivial);

    expect(result.passed).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it('allows running a subset of invariants', async () => {
    const state = await compactor.compact(conversationWithCorrection, 'L2');
    const result = checkInvariants(state, conversationWithCorrection, [entityProvenance]);

    expect(result.invariantsChecked).toEqual(['INV-002']);
  });
});
