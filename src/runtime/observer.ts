/**
 * Observation & feedback — Pillar 5.
 *
 * Records what dispatch did and holds the negative examples dispatch
 * consults ("for this intent, never this tool"). Negative examples come
 * from explicit feedback (`feedback()`, ToolRuntime.feedback): a caller
 * that knows a dispatch was wrong says so, naming the intent and the tool.
 *
 * Implicit correction detection — treating a switch to a different tool
 * within a short window as proof the first tool was wrong — is off by
 * default (`implicitCorrections`). Ordinary multi-step workflows (search →
 * open, list → get) switch tools all the time, and treating each switch as
 * a correction blacklisted the correct tool. Caller-side argument errors
 * are recorded for diagnostics but are never negative examples: the tool
 * was not wrong, the arguments were.
 */

import { intentKey } from '../core/selector-table.js';

// ---------------------------------------------------------------------------
// Dispatch record — what the observer watches
// ---------------------------------------------------------------------------

export interface DispatchRecord {
  intent: string;
  /** Canonical tool id `<providerId>/<toolName>` that ran */
  tool: string;
  confidence: number;
  timestamp: number;
  /** Whether execution resulted in a schema validation error */
  schemaRejected?: boolean;
  /** The caller the dispatch was made for, if it identified itself */
  principal?: string;
}

// ---------------------------------------------------------------------------
// Signal 1: Correction detection (opt-in)
// ---------------------------------------------------------------------------

export interface CorrectionSignal {
  wrongTool: string;
  wrongIntent: string;
  rightTool: string;
  rightIntent: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Signal 2: Schema rejection (diagnostics only)
// ---------------------------------------------------------------------------

export interface SchemaRejection {
  tool: string;
  intent: string;
  error: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Negative example — stored to prevent repeat mis-dispatches
// ---------------------------------------------------------------------------

export interface NegativeExample {
  /** intentKey() of the intent the tool was wrong for */
  intent: string;
  /** Canonical tool id that must not be chosen for it */
  wrongTool: string;
  /** Canonical tool id that was right, when the caller said */
  correctTool?: string;
  /** Applies only to this principal's dispatches; absent = everyone's */
  principal?: string;
  /** Where the example came from */
  source: 'feedback' | 'implicit-correction';
  timestamp: number;
}

/** Explicit feedback about one intent → tool decision. */
export interface DispatchFeedback {
  /** The intent as it was dispatched (normalized with intentKey) */
  intent: string;
  /** Canonical tool id the feedback is about */
  toolId: string;
  /**
   * false: the tool was wrong for this intent (it becomes a negative
   * example). true: it was right (clears any negative example for it).
   */
  correct: boolean;
  /** The tool that should have been chosen, when known */
  expectedToolId?: string;
  /** Scope the feedback to one caller; omit to apply it to every caller */
  principal?: string;
}

// ---------------------------------------------------------------------------
// Observer configuration
// ---------------------------------------------------------------------------

export interface ObserverOptions {
  /**
   * Infer corrections: when a dispatch picks a different tool within
   * correctionWindowMs of the previous one, record the previous (intent,
   * tool) as a negative example. Default false — negative examples then
   * come only from explicit feedback.
   */
  implicitCorrections?: boolean;
  /** Window in ms to consider a re-dispatch as a correction (default: 30000) */
  correctionWindowMs?: number;
  /** Maximum recent dispatches to track (default: 100) */
  maxRecentDispatches?: number;
  /** Maximum negative examples to store (default: 500) */
  maxNegativeExamples?: number;
}

// ---------------------------------------------------------------------------
// DispatchObserver
// ---------------------------------------------------------------------------

export class DispatchObserver {
  private recentDispatches: DispatchRecord[] = [];
  private corrections: CorrectionSignal[] = [];
  private rejections: SchemaRejection[] = [];
  private negativeExamples: NegativeExample[] = [];

  readonly implicitCorrections: boolean;
  private readonly correctionWindowMs: number;
  private readonly maxRecentDispatches: number;
  private readonly maxNegativeExamples: number;

  constructor(options?: ObserverOptions) {
    this.implicitCorrections = options?.implicitCorrections ?? false;
    this.correctionWindowMs = options?.correctionWindowMs ?? 30_000;
    this.maxRecentDispatches = options?.maxRecentDispatches ?? 100;
    this.maxNegativeExamples = options?.maxNegativeExamples ?? 500;
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Record a dispatch. With implicitCorrections on, returns the correction
   * signal it inferred (and records the negative example); otherwise null.
   */
  recordDispatch(record: DispatchRecord): CorrectionSignal | null {
    const correction = this.implicitCorrections ? this.detectCorrection(record) : null;

    this.recentDispatches.push(record);
    if (this.recentDispatches.length > this.maxRecentDispatches) {
      this.recentDispatches.shift();
    }

    if (correction) {
      this.corrections.push(correction);
      this.addNegativeExample({
        intent: intentKey(correction.wrongIntent),
        wrongTool: correction.wrongTool,
        correctTool: correction.rightTool,
        ...(record.principal !== undefined ? { principal: record.principal } : {}),
        source: 'implicit-correction',
        timestamp: correction.timestamp,
      });
    }

    return correction;
  }

  /**
   * Record that a call was rejected because its arguments were invalid.
   * Diagnostics only: the caller's arguments were wrong, not the tool, so
   * this never creates a negative example.
   */
  recordSchemaRejection(tool: string, intent: string, error: string): void {
    this.rejections.push({ tool, intent, error, timestamp: Date.now() });
    if (this.rejections.length > this.maxRecentDispatches) this.rejections.shift();
  }

  /**
   * Explicit feedback. `correct: false` records (intent, toolId) as a
   * negative example — dispatch will not choose that tool for that intent
   * again (for `principal` only, when given). `correct: true` removes any
   * negative example for the pair.
   */
  feedback(input: DispatchFeedback): void {
    const key = intentKey(input.intent);
    const samePair = (ex: NegativeExample): boolean =>
      ex.intent === key && ex.wrongTool === input.toolId && ex.principal === input.principal;
    this.negativeExamples = this.negativeExamples.filter(ex => !samePair(ex));
    if (input.correct) return;
    this.addNegativeExample({
      intent: key,
      wrongTool: input.toolId,
      ...(input.expectedToolId !== undefined ? { correctTool: input.expectedToolId } : {}),
      ...(input.principal !== undefined ? { principal: input.principal } : {}),
      source: 'feedback',
      timestamp: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Signal 1: Correction detection
  // -------------------------------------------------------------------------

  private detectCorrection(current: DispatchRecord): CorrectionSignal | null {
    if (this.recentDispatches.length === 0) return null;

    const previous = this.recentDispatches[this.recentDispatches.length - 1];
    // Only a caller's own dispatches can correct each other
    if (previous.principal !== current.principal) return null;
    // Same tool = not a correction
    if (current.tool === previous.tool) return null;
    // Too old = not a correction
    if (current.timestamp - previous.timestamp > this.correctionWindowMs) return null;

    return {
      wrongTool: previous.tool,
      wrongIntent: previous.intent,
      rightTool: current.tool,
      rightIntent: current.intent,
      timestamp: current.timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // Negative examples
  // -------------------------------------------------------------------------

  private addNegativeExample(example: NegativeExample): void {
    this.negativeExamples.push(example);
    if (this.negativeExamples.length > this.maxNegativeExamples) {
      this.negativeExamples.shift();
    }
  }

  /**
   * Whether (intent, tool) is a negative example for this caller: one
   * recorded for everyone, or for this principal. `intent` is the raw
   * intent text (normalized here with intentKey).
   */
  isNegativeExample(intent: string, toolId: string, principal?: string): boolean {
    if (this.negativeExamples.length === 0) return false;
    const key = intentKey(intent);
    return this.negativeExamples.some(
      ex => ex.intent === key && ex.wrongTool === toolId
        && (ex.principal === undefined || ex.principal === principal),
    );
  }

  /** Get all negative examples (for dream system integration) */
  getNegativeExamples(): ReadonlyArray<NegativeExample> {
    return this.negativeExamples;
  }

  /** Get inferred correction signals (implicitCorrections only) */
  getCorrections(): ReadonlyArray<CorrectionSignal> {
    return this.corrections;
  }

  /** Get recent schema rejections */
  getRejections(): ReadonlyArray<SchemaRejection> {
    return this.rejections;
  }

  /** Reset all observation state */
  reset(): void {
    this.recentDispatches = [];
    this.corrections = [];
    this.rejections = [];
    this.negativeExamples = [];
  }
}
