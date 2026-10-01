/**
 * RecallTester — round-trip recall testing framework.
 *
 * Generates quiz questions from the full conversation history, then
 * evaluates whether what the model will see — a context frame, or the live
 * levels of a compacted state — retains enough information to answer them.
 *
 * Quiz categories:
 * - Entity recall: "What database was chosen?"
 * - Decision recall: "What was rejected and why?"
 * - Correction recall: "What was the original value before the correction?"
 * - Temporal recall: "What was decided before vs. after message N?"
 */

import type {
  CompactedState,
  ContextFrame,
  ConversationMessage,
  Tombstone,
  VerificationResult,
} from '../types.js';
import { supersededMatcher } from '../compaction/matching.js';

export interface RecallQuestion {
  category: 'entity' | 'decision' | 'correction' | 'temporal';
  question: string;
  /** The ground-truth answer, extracted from the full conversation. */
  expectedAnswer: string;
  /** Message IDs relevant to this question. */
  sourceMessages: string[];
}

export class RecallTester {
  /**
   * Generate quiz questions from the full conversation history.
   * In v0.1.0, this uses heuristic extraction (same patterns as RegexCompactor).
   */
  generateQuestions(messages: ConversationMessage[]): RecallQuestion[] {
    const questions: RecallQuestion[] = [];

    for (const msg of messages) {
      // Entity questions from technology mentions
      const techPattern = /(?:chose|use|using|selected|going with|picked)\s+(\w+(?:\s+\w+)?)/gi;
      let m: RegExpExecArray | null;
      while ((m = techPattern.exec(msg.content)) !== null) {
        questions.push({
          category: 'entity',
          question: `What technology/approach was selected for: ${m[1]}?`,
          expectedAnswer: m[1].trim(),
          sourceMessages: [msg.id],
        });
      }

      // Correction questions
      const correctionPattern = /(?:actually|wait|correction|instead|scratch that)\s*[,:]?\s*(?:use|go with|switch to|change to)\s+(.+?)(?:\.|$)/gi;
      while ((m = correctionPattern.exec(msg.content)) !== null) {
        questions.push({
          category: 'correction',
          question: `What was the correction made regarding: ${m[1]}?`,
          expectedAnswer: m[1].trim(),
          sourceMessages: [msg.id],
        });
      }

      // Decision questions from rejection patterns
      const rejectPattern = /(?:rejected|ruled out|won't use)\s+(.+?)(?:\s+because\s+(.+?))?(?:\.|$)/gi;
      while ((m = rejectPattern.exec(msg.content)) !== null) {
        questions.push({
          category: 'decision',
          question: `What was rejected and why: ${m[1]}?`,
          expectedAnswer: `${m[1].trim()}${m[2] ? ` because ${m[2].trim()}` : ''}`,
          sourceMessages: [msg.id],
        });
      }
    }

    return questions;
  }

  /**
   * Evaluate recall: can the answer to each question be found in what the
   * downstream model would see?
   *
   * - Given a `ContextFrame` (from `buildContextFrame(budget)`), only the
   *   frame's text counts — budget truncation shows up as lost recall.
   *   Correction lines are left out: they name the superseded value, which
   *   is not recall of the current one.
   * - Given a `CompactedState`, the live levels L0–L4 count — not tombstone
   *   text and not the archive.
   *
   * A question whose expected answer is a value a correction superseded is
   * not scored (reported as `recall:superseded`): the compactor is right to
   * have dropped it. Tombstones come from the state, or from
   * `options.tombstones` for a frame.
   *
   * Matching is plain string matching on the answer's key terms (words of
   * three or more characters).
   */
  evaluateRecall(
    questions: RecallQuestion[],
    target: CompactedState | ContextFrame,
    options: { tombstones?: Tombstone[] } = {},
  ): VerificationResult {
    if (questions.length === 0) {
      return {
        passed: true,
        checks: [{ name: 'recall', passed: true, message: 'No questions generated' }],
        recallScore: 1.0,
      };
    }

    const isFrame = 'sections' in target;
    const corpus = (isFrame ? this.flattenFrame(target) : this.flattenState(target)).toLowerCase();
    const tombstones = options.tombstones ?? (isFrame ? [] : target.tombstones);
    const superseded = tombstones.filter((t) => t.supersededContent).map((t) => supersededMatcher(t));

    let recalled = 0;
    let scored = 0;
    const checks = questions.map((q) => {
      if (superseded.some((statesOnlyOld) => statesOnlyOld(q.expectedAnswer))) {
        return {
          name: 'recall:superseded',
          passed: true,
          message: `Skipped (superseded by a correction): ${q.question} (was: ${q.expectedAnswer})`,
        };
      }
      scored++;
      const answer = q.expectedAnswer.toLowerCase();
      // Check if the key terms from the expected answer appear in the corpus
      const keyTerms = answer.split(/\s+/).filter((t) => t.length > 2);
      const found = keyTerms.length > 0 && keyTerms.every((term) => corpus.includes(term));

      if (found) recalled++;

      return {
        name: `recall:${q.category}`,
        passed: found,
        message: found
          ? `Recalled: ${q.question}`
          : `Missing: ${q.question} (expected: ${q.expectedAnswer})`,
      };
    });

    const recallScore = scored > 0 ? recalled / scored : 1.0;

    return {
      passed: recallScore >= 0.9,
      checks,
      recallScore,
    };
  }

  private flattenFrame(frame: ContextFrame): string {
    return frame.sections
      .filter((s) => s.kind !== 'correction')
      .map((s) => s.content)
      .join('\n');
  }

  private flattenState(state: CompactedState): string {
    const parts: string[] = [];

    // L0
    for (const msg of state.l0_messages) {
      parts.push(msg.content);
    }

    // L1
    for (const entry of state.l1_compacted) {
      parts.push(entry.compacted);
    }

    // L2 — a decision summary whose decisions were all superseded is history
    for (const summary of state.l2_summaries) {
      const live = summary.decisions.filter((d) => !d.superseded);
      if (summary.decisions.length > 0 && live.length === 0) continue;
      parts.push(summary.summary);
      for (const decision of live) {
        parts.push(decision.description);
        parts.push(decision.chosen);
        for (const alt of decision.alternatives) {
          parts.push(alt.option);
          parts.push(alt.reason);
        }
      }
    }

    // L3
    for (const [, entity] of state.l3_graph.entities) {
      parts.push(entity.name);
      parts.push(JSON.stringify(entity.properties));
    }

    // L4
    for (const inv of state.l4_invariants) {
      parts.push(inv.key);
      parts.push(inv.value);
    }

    // Tombstones are deliberately left out: their text names the
    // superseded value, which must not count as recall.

    return parts.join(' ');
  }
}
