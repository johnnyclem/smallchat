/**
 * Confidence-Tiered Dispatch — Pillar 1.
 *
 * Every resolution has a confidence tier that determines runtime behavior
 * (the dispatch policy in runtime/policy.ts has the full rules):
 *   EXACT  (>= 0.95) — dispatch immediately, cache aggressively
 *   HIGH   (>= 0.85) — dispatch
 *   MEDIUM (>= 0.75) — dispatch only after verification approves it (an LLM
 *                      verifier or the shortlist judge, unless
 *                      requireLLMForSubHighDispatch is off)
 *   LOW    (>= 0.60) — decomposition when dispatching, else as MEDIUM
 *   NONE   (< 0.60)  — never dispatched; refinement protocol (Pillar 4)
 * Destructive tools additionally need EXACT similarity or an exact tool id.
 */

// ---------------------------------------------------------------------------
// Confidence tier
// ---------------------------------------------------------------------------

export type ConfidenceTier = 'exact' | 'high' | 'medium' | 'low' | 'none';

/** Tier thresholds (RuntimeOptions.thresholds overrides the defaults) */
export interface TierThresholds {
  exact: number;
  high: number;
  medium: number;
  low: number;
}

export const DEFAULT_THRESHOLDS: Readonly<TierThresholds> = Object.freeze({
  exact: 0.95,
  high: 0.85,
  medium: 0.75,
  low: 0.60,
});

/**
 * A dispatch result is marked `metadata.ambiguous` when more than one
 * candidate remained and the chosen score is at or under this. A flag for
 * callers only: it decides nothing (the shortlist judge has its own rule,
 * core/judge.ts).
 */
export const AMBIGUOUS_CONFIDENCE = 0.9;

/**
 * Scores are compared at this resolution. Similarities from different
 * vector backends (float32 SQLite, float64 in-memory) or platforms can
 * differ in the last few bits; quantizing every score before it is ranked
 * or compared with a threshold keeps those differences from changing an
 * outcome. Equal quantized scores are ordered by canonical tool id.
 */
export const SCORE_QUANTUM = 1e-4;

/** A score rounded to SCORE_QUANTUM (4 decimal places), clamped to [0, 1]. */
export function quantizeScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(1, Math.max(0, Math.round(score * 1e4) / 1e4));
}

/**
 * The deterministic candidate order: higher quantized score first, then
 * canonical tool id (UTF-16 code unit order). Returns a negative number
 * when `a` ranks before `b`.
 */
export function compareRanked(
  a: { score: number; toolId: string },
  b: { score: number; toolId: string },
): number {
  const byScore = quantizeScore(b.score) - quantizeScore(a.score);
  if (byScore !== 0) return byScore;
  return a.toolId < b.toolId ? -1 : a.toolId > b.toolId ? 1 : 0;
}

/** Compute the confidence tier from a similarity score */
export function computeTier(confidence: number, thresholds: TierThresholds = DEFAULT_THRESHOLDS): ConfidenceTier {
  if (confidence >= thresholds.exact) return 'exact';
  if (confidence >= thresholds.high) return 'high';
  if (confidence >= thresholds.medium) return 'medium';
  if (confidence >= thresholds.low) return 'low';
  return 'none';
}

/** Whether a tier should trigger pre-flight verification */
export function requiresVerification(tier: ConfidenceTier): boolean {
  return tier === 'medium';
}

/** Whether a tier should trigger intent decomposition */
export function requiresDecomposition(tier: ConfidenceTier): boolean {
  return tier === 'low';
}

/** Whether a tier should trigger refinement protocol */
export function requiresRefinement(tier: ConfidenceTier): boolean {
  return tier === 'none';
}

// The resolution proof (a structured record of each decision) lives in
// ./proof.ts.
