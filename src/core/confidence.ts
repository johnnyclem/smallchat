/**
 * Confidence-Tiered Dispatch — Pillar 1.
 *
 * Every resolution has a confidence tier that determines runtime behavior
 * (the dispatch policy in runtime/policy.ts has the full rules):
 *   EXACT  (>= 0.95) — dispatch immediately, cache aggressively
 *   HIGH   (>= 0.85) — dispatch
 *   MEDIUM (>= 0.75) — dispatch only after verification approves it (an LLM
 *                      verifier, unless requireLLMForSubHighDispatch is off)
 *   LOW    (>= 0.60) — decomposition when dispatching, else as MEDIUM
 *   NONE   (< 0.60)  — never dispatched; refinement protocol (Pillar 4)
 * Destructive tools additionally need EXACT similarity or an exact tool id.
 */

// ---------------------------------------------------------------------------
// Confidence tier
// ---------------------------------------------------------------------------

export type ConfidenceTier = 'exact' | 'high' | 'medium' | 'low' | 'none';

/** Default tier thresholds — can be overridden per-tool-class by adaptive thresholds */
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
