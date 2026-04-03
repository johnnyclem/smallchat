/**
 * Unified Verification Harness
 *
 * Combines all three verification strategies into a single pipeline that
 * can be run against any compacted state. This is the entry point for
 * verifying compaction correctness.
 *
 * Usage:
 *   const harness = new VerificationHarness(config);
 *   const result = harness.verify(compactedState, originalHistory);
 *
 * The harness runs whichever strategies are enabled in the config and
 * produces a unified pass/fail result with a human-readable summary.
 */

import type {
  CompactedState,
  CompactionVerificationConfig,
  ConversationHistory,
  VerificationResult,
} from './types.js';
import { DEFAULT_VERIFICATION_CONFIG } from './types.js';
import { runRecallTest } from './recall-test.js';
import { checkInvariants, BUILTIN_INVARIANTS } from './invariant-check.js';
import { analyzeInformationTheoretic } from './information-theoretic.js';

export class VerificationHarness {
  private config: CompactionVerificationConfig;

  constructor(config: Partial<CompactionVerificationConfig> = {}) {
    this.config = { ...DEFAULT_VERIFICATION_CONFIG, ...config };
    if (config.strategies) {
      this.config.strategies = { ...DEFAULT_VERIFICATION_CONFIG.strategies, ...config.strategies };
    }
  }

  /**
   * Verify a compacted state against the original conversation.
   * Runs all enabled strategies and produces a unified result.
   */
  verify(
    compactedState: CompactedState,
    original: ConversationHistory,
  ): VerificationResult {
    const { strategies } = this.config;

    // Strategy 1: Round-trip recall testing
    const recallTest = strategies.recallTest
      ? runRecallTest(
          original,
          compactedState,
          undefined,
          undefined,
          this.config.questionsPerCategory,
        )
      : null;

    // Strategy 2: Invariant preservation
    const invariantCheck = strategies.invariantCheck
      ? checkInvariants(compactedState, original, BUILTIN_INVARIANTS)
      : null;

    // Strategy 3: Information-theoretic analysis
    const informationTheoretic = strategies.informationTheoretic
      ? analyzeInformationTheoretic(compactedState, original)
      : null;

    // Determine pass/fail
    const passes: boolean[] = [];

    if (recallTest) {
      passes.push(recallTest.recallScore >= this.config.minRecallScore);
    }
    if (invariantCheck) {
      const invariantPassed = this.config.warningsAreErrors
        ? invariantCheck.violations.length === 0
        : invariantCheck.passed;
      passes.push(invariantPassed);
    }
    if (informationTheoretic) {
      passes.push(informationTheoretic.retentionScore >= this.config.minRetentionScore);
    }

    const passed = passes.length > 0 ? passes.every(p => p) : true;

    // Generate summary
    const summaryLines: string[] = [
      `Verification of ${compactedState.level} compaction (round ${compactedState.roundNumber})`,
      `Original: ${compactedState.originalMessageCount} messages, ~${compactedState.originalTokenCount} tokens`,
      `Compacted: ~${compactedState.compactedTokenCount} tokens (${((compactedState.compactedTokenCount / compactedState.originalTokenCount) * 100).toFixed(1)}% of original)`,
      '',
    ];

    if (recallTest) {
      const status = recallTest.recallScore >= this.config.minRecallScore ? 'PASS' : 'FAIL';
      summaryLines.push(
        `Strategy 1 — Recall Test: ${status} (${(recallTest.recallScore * 100).toFixed(1)}% recall, threshold: ${(this.config.minRecallScore * 100).toFixed(1)}%)`,
      );
      summaryLines.push(
        `  Questions: ${recallTest.questions.length}, Correct: ${recallTest.answers.filter(a => a.correct).length}, Failed: ${recallTest.failures.length}`,
      );
      if (recallTest.failures.length > 0) {
        const failureModes = recallTest.failures
          .map(f => f.failureMode ?? 'unknown')
          .reduce((acc, m) => { acc[m] = (acc[m] ?? 0) + 1; return acc; }, {} as Record<string, number>);
        summaryLines.push(
          `  Failure modes: ${Object.entries(failureModes).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        );
      }
    }

    if (invariantCheck) {
      const status = (this.config.warningsAreErrors
        ? invariantCheck.violations.length === 0
        : invariantCheck.passed) ? 'PASS' : 'FAIL';
      summaryLines.push(
        `Strategy 2 — Invariant Check: ${status} (${invariantCheck.invariantsChecked.length} checked, ${invariantCheck.errorCount} errors, ${invariantCheck.warningCount} warnings)`,
      );
      for (const v of invariantCheck.violations) {
        summaryLines.push(`  [${v.severity.toUpperCase()}] ${v.invariantId}: ${v.message}`);
      }
    }

    if (informationTheoretic) {
      const status = informationTheoretic.retentionScore >= this.config.minRetentionScore ? 'PASS' : 'FAIL';
      summaryLines.push(
        `Strategy 3 — Information Theory: ${status} (retention: ${(informationTheoretic.retentionScore * 100).toFixed(1)}%, threshold: ${(this.config.minRetentionScore * 100).toFixed(1)}%)`,
      );
      summaryLines.push(
        `  Compression ratio: ${(informationTheoretic.rateDistortion.compressionRatio * 100).toFixed(1)}%`,
      );
      summaryLines.push(
        `  Rate-distortion: ${informationTheoretic.rateDistortion.withinBounds ? 'within' : 'BELOW'} theoretical bounds (margin: ${informationTheoretic.rateDistortion.marginBits.toFixed(1)} bits)`,
      );
      const retainedEntities = informationTheoretic.entityRetention.filter(e => e.retained).length;
      summaryLines.push(
        `  Entity retention: ${retainedEntities}/${informationTheoretic.entityRetention.length} entities retained`,
      );
    }

    summaryLines.push('');
    summaryLines.push(`Overall: ${passed ? 'PASS' : 'FAIL'}`);

    return {
      sessionId: compactedState.sessionId,
      compactedState,
      recallTest,
      invariantCheck,
      informationTheoretic,
      passed,
      summary: summaryLines.join('\n'),
      verifiedAt: new Date().toISOString(),
    };
  }
}
