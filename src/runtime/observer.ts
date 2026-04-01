/**
 * Observation & Adaptation — Pillar 5 of smallchat 0.4.0.
 *
 * KVO-inspired layer that watches dispatch patterns and adapts in real-time.
 * Three feedback signals:
 *   1. Correction detection (zero cost) — caller re-dispatches to a different tool
 *   2. Schema rejection tracking (near-zero cost) — tool returns validation error
 *   3. Adaptive thresholds (session-scoped) — per-tool-class threshold tuning
 */

import type { TierThresholds } from '../core/confidence.js';
import { DEFAULT_THRESHOLDS } from '../core/confidence.js';

// ---------------------------------------------------------------------------
// Dispatch record — what the observer watches
// ---------------------------------------------------------------------------

export interface DispatchRecord {
  intent: string;
  tool: string;
  confidence: number;
  timestamp: number;
  /** Whether execution resulted in a schema validation error */
  schemaRejected?: boolean;
}

// ---------------------------------------------------------------------------
// Signal 1: Correction detection
// ---------------------------------------------------------------------------

export interface CorrectionSignal {
  wrongTool: string;
  wrongIntent: string;
  rightTool: string;
  rightIntent: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Signal 2: Schema rejection
// ---------------------------------------------------------------------------

export interface SchemaRejection {
  tool: string;
  intent: string;
  error: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Signal 3: Adaptive thresholds
// ---------------------------------------------------------------------------

export interface AdaptiveThreshold {
  toolClass: string;
  baseThreshold: number;
  currentThreshold: number;
  corrections: number;
  rejections: number;
  lastAdjusted: number;
}

// ---------------------------------------------------------------------------
// Negative example — stored to prevent repeat mis-dispatches
// ---------------------------------------------------------------------------

export interface NegativeExample {
  intent: string;
  wrongTool: string;
  correctTool?: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Observer configuration
// ---------------------------------------------------------------------------

export interface ObserverOptions {
  /** Window in ms to consider a re-dispatch as a correction (default: 30000) */
  correctionWindowMs?: number;
  /** Number of corrections before threshold is bumped (default: 3) */
  correctionThreshold?: number;
  /** Amount to increase threshold per adjustment (default: 0.03) */
  thresholdBumpAmount?: number;
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
  private adaptiveThresholds: Map<string, AdaptiveThreshold> = new Map();

  private readonly correctionWindowMs: number;
  private readonly correctionThreshold: number;
  private readonly thresholdBumpAmount: number;
  private readonly maxRecentDispatches: number;
  private readonly maxNegativeExamples: number;

  constructor(options?: ObserverOptions) {
    this.correctionWindowMs = options?.correctionWindowMs ?? 30_000;
    this.correctionThreshold = options?.correctionThreshold ?? 3;
    this.thresholdBumpAmount = options?.thresholdBumpAmount ?? 0.03;
    this.maxRecentDispatches = options?.maxRecentDispatches ?? 100;
    this.maxNegativeExamples = options?.maxNegativeExamples ?? 500;
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /**
   * Record a dispatch. Automatically detects correction signals.
   * Returns a correction signal if one was detected.
   */
  recordDispatch(record: DispatchRecord): CorrectionSignal | null {
    const correction = this.detectCorrection(record);

    this.recentDispatches.push(record);
    if (this.recentDispatches.length > this.maxRecentDispatches) {
      this.recentDispatches.shift();
    }

    if (correction) {
      this.corrections.push(correction);
      this.addNegativeExample({
        intent: correction.wrongIntent,
        wrongTool: correction.wrongTool,
        correctTool: correction.rightTool,
        timestamp: correction.timestamp,
      });
      this.maybeAdjustThreshold(correction.wrongTool);
    }

    return correction;
  }

  /**
   * Record a schema rejection — the tool executed but returned a validation error.
   */
  recordSchemaRejection(tool: string, intent: string, error: string): void {
    this.rejections.push({ tool, intent, error, timestamp: Date.now() });
    this.addNegativeExample({
      intent,
      wrongTool: tool,
      timestamp: Date.now(),
    });
    this.maybeAdjustThreshold(tool);
  }

  // -------------------------------------------------------------------------
  // Signal 1: Correction detection
  // -------------------------------------------------------------------------

  private detectCorrection(current: DispatchRecord): CorrectionSignal | null {
    if (this.recentDispatches.length === 0) return null;

    const previous = this.recentDispatches[this.recentDispatches.length - 1];
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
   * Check if an intent + tool combination is a known negative example.
   * Used by dispatch to skip known-bad matches.
   */
  isNegativeExample(intent: string, tool: string): boolean {
    return this.negativeExamples.some(
      ex => ex.intent === intent && ex.wrongTool === tool,
    );
  }

  /** Get all negative examples (for dream system integration) */
  getNegativeExamples(): ReadonlyArray<NegativeExample> {
    return this.negativeExamples;
  }

  // -------------------------------------------------------------------------
  // Signal 3: Adaptive thresholds
  // -------------------------------------------------------------------------

  private maybeAdjustThreshold(toolClass: string): void {
    let entry = this.adaptiveThresholds.get(toolClass);
    if (!entry) {
      entry = {
        toolClass,
        baseThreshold: DEFAULT_THRESHOLDS.medium,
        currentThreshold: DEFAULT_THRESHOLDS.medium,
        corrections: 0,
        rejections: 0,
        lastAdjusted: Date.now(),
      };
      this.adaptiveThresholds.set(toolClass, entry);
    }

    // Count recent signals for this tool class
    const recentCorrections = this.corrections.filter(
      c => c.wrongTool === toolClass,
    ).length;
    const recentRejections = this.rejections.filter(
      r => r.tool === toolClass,
    ).length;

    entry.corrections = recentCorrections;
    entry.rejections = recentRejections;

    const totalSignals = recentCorrections + recentRejections;
    if (totalSignals >= this.correctionThreshold) {
      // Bump threshold — make it harder for this tool to match
      entry.currentThreshold = Math.min(
        0.95,
        entry.currentThreshold + this.thresholdBumpAmount,
      );
      entry.lastAdjusted = Date.now();
    }
  }

  /**
   * Get the adapted tier thresholds for a specific tool class.
   * Returns default thresholds if no adaptation has occurred.
   */
  getAdaptedThresholds(toolClass: string): TierThresholds {
    const entry = this.adaptiveThresholds.get(toolClass);
    if (!entry) return { ...DEFAULT_THRESHOLDS };

    // Only adjust the medium threshold upward for problematic tools
    const delta = entry.currentThreshold - entry.baseThreshold;
    return {
      exact: DEFAULT_THRESHOLDS.exact,
      high: Math.min(0.95, DEFAULT_THRESHOLDS.high + delta),
      medium: entry.currentThreshold,
      low: DEFAULT_THRESHOLDS.low,
    };
  }

  /** Get all adaptive threshold entries (for diagnostics) */
  getAdaptiveThresholds(): ReadonlyMap<string, AdaptiveThreshold> {
    return this.adaptiveThresholds;
  }

  /** Get recent correction signals (for dream system integration) */
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
    this.adaptiveThresholds.clear();
  }
}
