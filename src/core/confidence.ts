/**
 * Confidence-Tiered Dispatch — Pillar 1 of smallchat 0.4.0.
 *
 * Every dispatch returns a confidence tier that determines runtime behavior:
 *   EXACT  (>= 0.95) — dispatch immediately, cache aggressively
 *   HIGH   (>= 0.85) — dispatch, log for review
 *   MEDIUM (>= 0.75) — dispatch with verification (Pillar 2)
 *   LOW    (>= 0.60) — trigger decomposition (Pillar 3)
 *   NONE   (< 0.60)  — trigger refinement protocol (Pillar 4)
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

// ---------------------------------------------------------------------------
// Resolution proof — a serializable trace of why a tool was chosen
// ---------------------------------------------------------------------------

export interface ResolutionProof {
  intent: string;
  steps: ProofStep[];
  elapsed: number;
  tier: ConfidenceTier;
  /** Final resolved tool name, or null if unresolved */
  resolvedTool: string | null;
}

export interface ProofStep {
  stage: 'cache' | 'intent_pin' | 'vector_search' | 'overload'
       | 'verification' | 'decomposition' | 'refinement'
       | 'protocol' | 'forwarding' | 'fallback';
  input: unknown;
  output: unknown;
  elapsed: number;
  decision: string;
}

/** Create a new empty proof trace */
export function createProof(intent: string): ResolutionProof {
  return {
    intent,
    steps: [],
    elapsed: 0,
    tier: 'none',
    resolvedTool: null,
  };
}

/** Add a step to a proof trace */
export function addProofStep(
  proof: ResolutionProof,
  step: Omit<ProofStep, 'elapsed'>,
  elapsed: number,
): void {
  proof.steps.push({ ...step, elapsed });
  proof.elapsed += elapsed;
}
