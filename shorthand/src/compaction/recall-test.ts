/**
 * Strategy 1: Round-trip Recall Testing
 *
 * The practical, buildable-now verification strategy. Given a compacted state,
 * generate a quiz from the original conversation and test whether the compacted
 * state can answer it. This is essentially a recall metric — what percentage of
 * important facts survive compaction?
 *
 * The quiz covers six categories:
 *   - entity: Named things (databases, frameworks, config values)
 *   - decision: Choices made and alternatives rejected
 *   - correction: Information that was later updated/fixed
 *   - temporal: Order-of-events questions
 *   - tool_result: Outcomes of tool invocations
 *   - rejection: Things explicitly ruled out
 */

import type {
  CompactedState,
  ConversationHistory,
  ConversationMessage,
  QuizEvaluator,
  QuizGenerator,
  RecallAnswer,
  RecallQuestion,
  RecallTestResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Quiz generation
// ---------------------------------------------------------------------------

let questionIdCounter = 0;

function makeQuestionId(): string {
  return `q-${++questionIdCounter}`;
}

/** Generate entity questions: "What is X?", "What value was chosen for X?" */
function generateEntityQuestions(
  messages: ConversationMessage[],
  limit: number,
): RecallQuestion[] {
  const questions: RecallQuestion[] = [];

  // Find messages with key-value patterns
  const entityPattern = /(?:chose|selected|using|decided on|set|configured)\s+["']?([A-Za-z][\w.-]+)["']?/gi;

  for (const msg of messages) {
    if (questions.length >= limit) break;
    let match;
    while ((match = entityPattern.exec(msg.content)) !== null && questions.length < limit) {
      questions.push({
        id: makeQuestionId(),
        question: `What was chosen/selected regarding "${match[1]}"?`,
        groundTruth: match[0].trim(),
        sourceMessageIds: [msg.id],
        category: 'entity',
        difficulty: 'easy',
      });
    }
  }

  return questions;
}

/** Generate decision questions: "What was decided?", "Why was X rejected?" */
function generateDecisionQuestions(
  messages: ConversationMessage[],
  limit: number,
): RecallQuestion[] {
  const questions: RecallQuestion[] = [];
  const decisionPattern = /(?:decided to|going with|let's use|we'll use|choosing)\s+(.+?)(?:\.|$)/gim;
  const rejectionPattern = /(?:rejected|ruled out|won't use)\s+(.+?)(?:\s+because\s+(.+?))?(?:\.|$)/gim;

  for (const msg of messages) {
    if (questions.length >= limit) break;

    let match;
    while ((match = decisionPattern.exec(msg.content)) !== null && questions.length < limit) {
      questions.push({
        id: makeQuestionId(),
        question: `What decision was made in this conversation about "${match[1].trim().slice(0, 50)}"?`,
        groundTruth: match[1].trim(),
        sourceMessageIds: [msg.id],
        category: 'decision',
        difficulty: 'medium',
      });
    }

    while ((match = rejectionPattern.exec(msg.content)) !== null && questions.length < limit) {
      questions.push({
        id: makeQuestionId(),
        question: `Why was "${match[1].trim()}" rejected?`,
        groundTruth: match[2]?.trim() ?? `${match[1].trim()} was rejected`,
        sourceMessageIds: [msg.id],
        category: 'rejection',
        difficulty: 'medium',
      });
    }
  }

  return questions;
}

/** Generate correction questions: "What was X corrected to?" */
function generateCorrectionQuestions(
  messages: ConversationMessage[],
  limit: number,
): RecallQuestion[] {
  const questions: RecallQuestion[] = [];
  const correctionPattern = /(?:actually|correction|no,|wait,)\s+(?:it's|it is|use|the)\s+["']?([A-Za-z][\w.-]+)["']?/gi;

  for (const msg of messages) {
    if (questions.length >= limit) break;
    let match;
    while ((match = correctionPattern.exec(msg.content)) !== null && questions.length < limit) {
      questions.push({
        id: makeQuestionId(),
        question: `What correction was made regarding "${match[1]}"?`,
        groundTruth: match[0].trim(),
        sourceMessageIds: [msg.id],
        category: 'correction',
        difficulty: 'hard',
      });
    }
  }

  return questions;
}

/** Generate temporal questions: "What happened first/after X?" */
function generateTemporalQuestions(
  messages: ConversationMessage[],
  limit: number,
): RecallQuestion[] {
  const questions: RecallQuestion[] = [];

  // Pick pairs of user messages and ask about ordering
  const userMessages = messages.filter(m => m.role === 'user' && m.content.length > 20);

  for (let i = 0; i < userMessages.length - 1 && questions.length < limit; i++) {
    const first = userMessages[i];
    const second = userMessages[i + 1];

    const firstSummary = first.content.slice(0, 60).replace(/\n/g, ' ');
    const secondSummary = second.content.slice(0, 60).replace(/\n/g, ' ');

    questions.push({
      id: makeQuestionId(),
      question: `Which came first: "${firstSummary}..." or "${secondSummary}..."?`,
      groundTruth: `"${firstSummary}" came first`,
      sourceMessageIds: [first.id, second.id],
      category: 'temporal',
      difficulty: 'medium',
    });
  }

  return questions;
}

/** Generate tool result questions: "What was the result of running X?" */
function generateToolResultQuestions(
  messages: ConversationMessage[],
  limit: number,
): RecallQuestion[] {
  const questions: RecallQuestion[] = [];

  const toolMessages = messages.filter(m => m.toolCall);

  for (const msg of toolMessages) {
    if (questions.length >= limit) break;
    const tc = msg.toolCall!;
    questions.push({
      id: makeQuestionId(),
      question: `What was the result of running the "${tc.name}" tool?`,
      groundTruth: tc.isError
        ? `The tool "${tc.name}" failed with an error`
        : `The tool "${tc.name}" succeeded${tc.result ? `: ${String(tc.result).slice(0, 100)}` : ''}`,
      sourceMessageIds: [msg.id],
      category: 'tool_result',
      difficulty: 'easy',
    });
  }

  return questions;
}

// ---------------------------------------------------------------------------
// DefaultQuizGenerator
// ---------------------------------------------------------------------------

export class DefaultQuizGenerator implements QuizGenerator {
  generateQuestions(
    history: ConversationHistory,
    questionsPerCategory: number,
  ): RecallQuestion[] {
    const msgs = history.messages;
    // Reset counter for deterministic test IDs within a generation pass
    questionIdCounter = 0;

    return [
      ...generateEntityQuestions(msgs, questionsPerCategory),
      ...generateDecisionQuestions(msgs, questionsPerCategory),
      ...generateCorrectionQuestions(msgs, questionsPerCategory),
      ...generateTemporalQuestions(msgs, questionsPerCategory),
      ...generateToolResultQuestions(msgs, questionsPerCategory),
    ];
  }
}

// ---------------------------------------------------------------------------
// Quiz evaluation
// ---------------------------------------------------------------------------

/**
 * Normalize text for comparison: lowercase, collapse whitespace, strip quotes.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute a simple string similarity score (0–1) using token overlap.
 * Not perfect, but sufficient for automated recall checking.
 */
export function tokenOverlapScore(a: string, b: string): number {
  const aNorm = normalize(a);
  const bNorm = normalize(b);
  if (aNorm.length === 0 && bNorm.length === 0) return 0;

  const tokensA = new Set(aNorm.split(/\s+/).filter(t => t.length > 0));
  const tokensB = new Set(bNorm.split(/\s+/).filter(t => t.length > 0));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap++;
  }

  // Jaccard-like: overlap / union
  const union = new Set([...tokensA, ...tokensB]).size;
  return overlap / union;
}

/**
 * Check if the compacted state's summary contains the key information
 * needed to answer a question.
 */
function findAnswerInSummary(
  question: RecallQuestion,
  summary: string,
): { found: boolean; extractedAnswer: string; confidence: number } {
  const normalizedSummary = normalize(summary);
  const normalizedTruth = normalize(question.groundTruth);

  // Direct substring match
  if (normalizedSummary.includes(normalizedTruth)) {
    return { found: true, extractedAnswer: question.groundTruth, confidence: 1.0 };
  }

  // Token overlap
  const score = tokenOverlapScore(question.groundTruth, summary);
  if (score >= 0.5) {
    return { found: true, extractedAnswer: `Partial match (score: ${score.toFixed(2)})`, confidence: score };
  }

  // Check if key entities from the ground truth appear in the summary
  const keyTokens = normalize(question.groundTruth)
    .split(/\s+/)
    .filter(t => t.length > 3); // Skip short words

  const foundTokens = keyTokens.filter(t => normalizedSummary.includes(t));
  const entityOverlap = keyTokens.length > 0 ? foundTokens.length / keyTokens.length : 0;

  if (entityOverlap >= 0.6) {
    return { found: true, extractedAnswer: `Key terms present: ${foundTokens.join(', ')}`, confidence: entityOverlap * 0.8 };
  }

  return { found: false, extractedAnswer: '', confidence: 0 };
}

// ---------------------------------------------------------------------------
// DefaultQuizEvaluator
// ---------------------------------------------------------------------------

export class DefaultQuizEvaluator implements QuizEvaluator {
  evaluate(
    question: RecallQuestion,
    compactedState: CompactedState,
  ): RecallAnswer {
    const { found, extractedAnswer, confidence } = findAnswerInSummary(
      question,
      compactedState.summary,
    );

    if (found) {
      return {
        questionId: question.id,
        answer: extractedAnswer,
        correct: true,
        confidence,
      };
    }

    // Check entities and decisions as structured fallback
    const entityMatch = compactedState.entities.some(e => {
      const truthNorm = normalize(question.groundTruth);
      return normalize(e.name).includes(truthNorm) ||
        normalize(String(e.value)).includes(truthNorm) ||
        truthNorm.includes(normalize(e.name));
    });

    if (entityMatch) {
      return {
        questionId: question.id,
        answer: 'Found in structured entities',
        correct: true,
        confidence: 0.7,
      };
    }

    const decisionMatch = compactedState.decisions.some(d =>
      normalize(d.description).includes(normalize(question.groundTruth).slice(0, 30)),
    );

    if (decisionMatch) {
      return {
        questionId: question.id,
        answer: 'Found in structured decisions',
        correct: true,
        confidence: 0.7,
      };
    }

    // Determine failure mode
    let failureMode: RecallAnswer['failureMode'] = 'missing';
    if (question.category === 'correction') {
      // Check if the OLD value is present but the correction is not
      const hasTombstone = compactedState.tombstones.some(t =>
        normalize(t.supersededContent).includes(normalize(question.groundTruth).slice(0, 20)),
      );
      failureMode = hasTombstone ? 'partial' : 'outdated';
    }

    return {
      questionId: question.id,
      answer: '',
      correct: false,
      confidence: 0,
      failureMode,
    };
  }
}

// ---------------------------------------------------------------------------
// Run a full recall test
// ---------------------------------------------------------------------------

/** Execute a complete round-trip recall test. */
export function runRecallTest(
  history: ConversationHistory,
  compactedState: CompactedState,
  generator: QuizGenerator = new DefaultQuizGenerator(),
  evaluator: QuizEvaluator = new DefaultQuizEvaluator(),
  questionsPerCategory: number = 5,
): RecallTestResult {
  const questions = generator.generateQuestions(history, questionsPerCategory);
  const answers = questions.map(q => evaluator.evaluate(q, compactedState));

  const correctCount = answers.filter(a => a.correct).length;
  const recallScore = questions.length > 0 ? correctCount / questions.length : 1;

  // Category breakdown
  const categories: RecallQuestion['category'][] = [
    'entity', 'decision', 'correction', 'temporal', 'tool_result', 'rejection',
  ];
  const categoryScores: Record<string, number> = {};
  for (const cat of categories) {
    const catQuestions = questions.filter(q => q.category === cat);
    const catAnswers = answers.filter((a, i) => questions[i].category === cat);
    const catCorrect = catAnswers.filter(a => a.correct).length;
    categoryScores[cat] = catQuestions.length > 0 ? catCorrect / catQuestions.length : 1;
  }

  // Difficulty breakdown
  const difficulties: RecallQuestion['difficulty'][] = ['easy', 'medium', 'hard'];
  const difficultyScores: Record<string, number> = {};
  for (const diff of difficulties) {
    const diffQuestions = questions.filter(q => q.difficulty === diff);
    const diffAnswers = answers.filter((a, i) => questions[i].difficulty === diff);
    const diffCorrect = diffAnswers.filter(a => a.correct).length;
    difficultyScores[diff] = diffQuestions.length > 0 ? diffCorrect / diffQuestions.length : 1;
  }

  return {
    compactedState,
    questions,
    answers,
    recallScore,
    categoryScores: categoryScores as Record<RecallQuestion['category'], number>,
    difficultyScores: difficultyScores as Record<RecallQuestion['difficulty'], number>,
    failures: answers.filter(a => !a.correct),
  };
}
