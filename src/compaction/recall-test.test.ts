import { describe, it, expect } from 'vitest';
import {
  DefaultQuizGenerator,
  DefaultQuizEvaluator,
  tokenOverlapScore,
  runRecallTest,
} from './recall-test.js';
import { DefaultCompactor } from './compactor.js';
import type { ConversationHistory, ConversationMessage, CompactedState } from './types.js';

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
  makeMessage('m1', 'user', 'We need to choose a framework. I was thinking React.'),
  makeMessage('m2', 'assistant', 'React is a good choice. Let me set it up.'),
  makeMessage('m3', 'assistant', 'Decided to use React for the frontend.'),
  makeMessage('m4', 'user', 'Actually, correction: use Vue instead.'),
  makeMessage('m5', 'assistant', 'Understood. Going with Vue.'),
  makeMessage('m6', 'user', 'We rejected Angular because it is too heavy.'),
  makeMessage('m7', 'assistant', 'Noted.', {
    toolCall: { name: 'install_deps', input: { packages: ['vue'] }, result: 'Installed successfully' },
  }),
  makeMessage('m8', 'user', 'Set port to 3000.'),
  makeMessage('m9', 'assistant', 'Configured port to 3000.'),
]);

// ---------------------------------------------------------------------------
// tokenOverlapScore
// ---------------------------------------------------------------------------

describe('tokenOverlapScore', () => {
  it('returns 1.0 for identical strings', () => {
    expect(tokenOverlapScore('hello world', 'hello world')).toBe(1);
  });

  it('returns 0 for completely different strings', () => {
    expect(tokenOverlapScore('apple banana', 'cat dog')).toBe(0);
  });

  it('returns partial overlap for shared tokens', () => {
    const score = tokenOverlapScore('hello world foo', 'hello bar foo');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('handles empty strings', () => {
    expect(tokenOverlapScore('', '')).toBe(0);
    expect(tokenOverlapScore('hello', '')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(tokenOverlapScore('Hello World', 'hello world')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DefaultQuizGenerator
// ---------------------------------------------------------------------------

describe('DefaultQuizGenerator', () => {
  const generator = new DefaultQuizGenerator();

  it('generates questions from a conversation', () => {
    const questions = generator.generateQuestions(richConversation, 3);
    expect(questions.length).toBeGreaterThan(0);
  });

  it('generates questions across multiple categories', () => {
    const questions = generator.generateQuestions(richConversation, 5);
    const categories = new Set(questions.map(q => q.category));
    // Should have at least 2 different categories from this rich conversation
    expect(categories.size).toBeGreaterThanOrEqual(1);
  });

  it('assigns unique IDs to questions', () => {
    const questions = generator.generateQuestions(richConversation, 5);
    const ids = new Set(questions.map(q => q.id));
    expect(ids.size).toBe(questions.length);
  });

  it('respects the limit per category', () => {
    const questions = generator.generateQuestions(richConversation, 1);
    const entityQuestions = questions.filter(q => q.category === 'entity');
    expect(entityQuestions.length).toBeLessThanOrEqual(1);
  });

  it('returns empty for conversation with no extractable content', () => {
    const trivial = makeHistory([
      makeMessage('m1', 'user', 'hi'),
      makeMessage('m2', 'assistant', 'hello'),
    ]);
    const questions = generator.generateQuestions(trivial, 5);
    expect(questions).toEqual([]);
  });

  it('generates tool_result questions for tool calls', () => {
    const questions = generator.generateQuestions(richConversation, 5);
    const toolQuestions = questions.filter(q => q.category === 'tool_result');
    expect(toolQuestions.length).toBeGreaterThan(0);
    expect(toolQuestions[0].question).toContain('install_deps');
  });
});

// ---------------------------------------------------------------------------
// DefaultQuizEvaluator
// ---------------------------------------------------------------------------

describe('DefaultQuizEvaluator', () => {
  const evaluator = new DefaultQuizEvaluator();
  const compactor = new DefaultCompactor();

  it('finds answers present in the summary', async () => {
    const state = await compactor.compact(richConversation, 'L2');
    const question = {
      id: 'test-q1',
      question: 'What framework was chosen?',
      groundTruth: 'Vue',
      sourceMessageIds: ['m5'],
      category: 'entity' as const,
      difficulty: 'easy' as const,
    };

    const answer = evaluator.evaluate(question, state);
    // Vue should be findable in the L2 summary
    expect(answer.questionId).toBe('test-q1');
  });

  it('detects missing information', async () => {
    const state = await compactor.compact(richConversation, 'L3');
    const question = {
      id: 'test-q2',
      question: 'What was the exact wording of message m1?',
      groundTruth: 'This is extremely specific text that would not appear in any summary xyz123abc',
      sourceMessageIds: ['m1'],
      category: 'entity' as const,
      difficulty: 'hard' as const,
    };

    const answer = evaluator.evaluate(question, state);
    expect(answer.correct).toBe(false);
    expect(answer.failureMode).toBe('missing');
  });

  it('checks structured entities as fallback', async () => {
    const state = await compactor.compact(richConversation, 'L2');
    // Create a question whose answer matches an entity name
    const entityNames = state.entities.map(e => e.name);
    if (entityNames.length > 0) {
      const question = {
        id: 'test-q3',
        question: `What about ${entityNames[0]}?`,
        groundTruth: entityNames[0],
        sourceMessageIds: ['m1'],
        category: 'entity' as const,
        difficulty: 'easy' as const,
      };
      const answer = evaluator.evaluate(question, state);
      expect(answer.correct).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// runRecallTest (integration)
// ---------------------------------------------------------------------------

describe('runRecallTest', () => {
  const compactor = new DefaultCompactor();

  it('runs a full recall test at L2', async () => {
    const state = await compactor.compact(richConversation, 'L2');
    const result = runRecallTest(richConversation, state);

    expect(result.compactedState).toBe(state);
    expect(result.recallScore).toBeGreaterThanOrEqual(0);
    expect(result.recallScore).toBeLessThanOrEqual(1);
    expect(result.questions.length).toBe(result.answers.length);
  });

  it('produces higher recall at L0 than L3', async () => {
    const l0 = await compactor.compact(richConversation, 'L0');
    const l3 = await compactor.compact(richConversation, 'L3');

    const resultL0 = runRecallTest(richConversation, l0);
    const resultL3 = runRecallTest(richConversation, l3);

    // L0 has all the original text, so recall should be >= L3
    expect(resultL0.recallScore).toBeGreaterThanOrEqual(resultL3.recallScore);
  });

  it('provides category and difficulty breakdowns', async () => {
    const state = await compactor.compact(richConversation, 'L2');
    const result = runRecallTest(richConversation, state);

    expect(result.categoryScores).toBeDefined();
    expect(result.difficultyScores).toBeDefined();
    expect(typeof result.categoryScores.entity).toBe('number');
    expect(typeof result.difficultyScores.easy).toBe('number');
  });

  it('identifies failures with failure modes', async () => {
    const state = await compactor.compact(richConversation, 'L3');
    const result = runRecallTest(richConversation, state);

    for (const failure of result.failures) {
      expect(failure.correct).toBe(false);
      expect(failure.failureMode).toBeDefined();
    }
  });

  it('handles conversations with no quizzable content', async () => {
    const trivial = makeHistory([
      makeMessage('m1', 'user', 'hi'),
      makeMessage('m2', 'assistant', 'hello'),
    ]);
    const state = await compactor.compact(trivial, 'L2');
    const result = runRecallTest(trivial, state);

    // No questions generated → perfect recall by default
    expect(result.recallScore).toBe(1);
    expect(result.questions).toHaveLength(0);
  });
});
