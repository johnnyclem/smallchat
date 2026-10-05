/**
 * Dispatch policy — the one rule set that decides whether a resolved tool
 * may run without the caller choosing it explicitly.
 *
 * It is evaluated on every path that can lead to execution: dispatch by
 * id, pinned phrases, learned (semantic-map) resolutions, cache hits,
 * vector and overload candidates, protocol conformance, and each
 * sub-intent of a decomposition (which is dispatched through the same
 * pipeline). A path that is denied does not fall back to some other way
 * of running the tool; the outcome is needs-disambiguation and the caller
 * picks a tool id.
 *
 * Rules, in order:
 *   1. Dispatch by exact tool id is always allowed (the caller named it).
 *   2. Intent pins: an 'exact' pin only accepts its pinned phrase (the pin
 *      canonical or an alias, compared after Unicode NFKC, case and
 *      whitespace normalization); an 'elevated' pin only accepts a cosine
 *      similarity, computed from this intent's own embedding, at or above
 *      its threshold.
 *   3. Destructive tools (see isDestructive) run only from a pinned phrase
 *      or an EXACT-tier similarity computed from this intent's own
 *      embedding — never from a cache hit, a learned preference or a
 *      boosted score.
 *   4. Below HIGH (MEDIUM/LOW), a candidate runs only if an LLM verifier
 *      or the shortlist judge (core/judge.ts) approved it for this intent,
 *      unless requireLLMForSubHighDispatch is turned off.
 *   5. Below LOW, nothing runs.
 */

import type { ToolAnnotations, ToolIMP } from '../core/types.js';
import { computeTier } from '../core/confidence.js';
import type { ConfidenceTier, TierThresholds } from '../core/confidence.js';
import type { CandidateSource } from '../core/proof.js';
import type { IntentPinPolicy } from '../core/intent-pin.js';

export interface DispatchPolicyOptions {
  thresholds: TierThresholds;
  /** Rule 4. Default true. */
  requireLLMForSubHighDispatch: boolean;
  /**
   * Treat tools that declare no annotations at all as destructive. Default
   * false. (MCP's own default for an unannotated tool is "may be
   * destructive"; turn this on to apply it.)
   */
  treatUnannotatedAsDestructive: boolean;
}

/** How a pin applies to one candidate. */
export interface PinState {
  canonical: string;
  policy: IntentPinPolicy;
  /** Whether the pin's condition holds for this intent */
  satisfied: boolean;
  /** For 'elevated': the similarity that was checked, and the bar */
  similarity?: number | null;
  requiredThreshold?: number;
}

export interface PolicyInput {
  /** 'id': the caller named the tool; 'intent': resolution chose it */
  mode: 'id' | 'intent';
  toolId: string;
  imp: Pick<ToolIMP, 'annotations'>;
  source: CandidateSource;
  /** Score the candidate was ranked by */
  score: number;
  /** Similarity from this intent's own embedding, or null when not vector-derived */
  similarity: number | null;
  /** Whether an LLM verifier, or the shortlist judge, approved this tool for this intent */
  llmApproved: boolean;
  /** Pins that apply to this tool (empty when none) */
  pins: PinState[];
}

export type PolicyCode =
  | 'allow'
  | 'pin-exact-required'
  | 'pin-elevated-required'
  | 'destructive-needs-exact'
  | 'needs-llm-verifier'
  | 'below-threshold';

export interface PolicyVerdict {
  allow: boolean;
  code: PolicyCode;
  /** One sentence, suitable for a proof step or an error shown to a model */
  reason: string;
  /** The tier the verdict was computed at */
  tier: ConfidenceTier;
}

/**
 * Whether a tool counts as destructive. A read-only tool never is; an
 * explicit destructiveHint wins; a tool that says it is not read-only but
 * omits destructiveHint is destructive (the MCP default for that case);
 * a tool with neither hint follows `treatUnannotatedAsDestructive`.
 */
export function isDestructive(
  annotations: ToolAnnotations | undefined,
  options: Pick<DispatchPolicyOptions, 'treatUnannotatedAsDestructive'>,
): boolean {
  if (annotations?.readOnlyHint === true) return false;
  if (typeof annotations?.destructiveHint === 'boolean') return annotations.destructiveHint;
  if (annotations?.readOnlyHint === false) return true;
  return options.treatUnannotatedAsDestructive;
}

/** Apply the dispatch policy (see module doc) to one candidate. */
export function evaluateDispatchPolicy(input: PolicyInput, options: DispatchPolicyOptions): PolicyVerdict {
  const tier = computeTier(input.score, options.thresholds);

  if (input.mode === 'id') {
    return { allow: true, code: 'allow', reason: `${input.toolId} was named by exact tool id`, tier: 'exact' };
  }

  for (const pin of input.pins) {
    if (pin.satisfied) continue;
    if (pin.policy === 'exact') {
      return {
        allow: false,
        code: 'pin-exact-required',
        reason: `${input.toolId} is pinned 'exact' (${pin.canonical}): only its pinned phrases dispatch to it`,
        tier,
      };
    }
    const seen = pin.similarity === null || pin.similarity === undefined ? 'no own-embedding similarity' : `similarity ${pin.similarity.toFixed(3)}`;
    return {
      allow: false,
      code: 'pin-elevated-required',
      reason: `${input.toolId} is pinned 'elevated' (${pin.canonical}): needs similarity >= ${pin.requiredThreshold}, got ${seen}`,
      tier,
    };
  }

  if (isDestructive(input.imp.annotations, options)) {
    const exactPhrase = input.source === 'pin';
    const exactSimilarity = input.similarity !== null && computeTier(input.similarity, options.thresholds) === 'exact';
    if (!exactPhrase && !exactSimilarity) {
      const seen = input.similarity === null ? `a ${input.source} match` : `similarity ${input.similarity.toFixed(3)}`;
      return {
        allow: false,
        code: 'destructive-needs-exact',
        reason: `${input.toolId} is destructive: it runs only by exact tool id, a pinned phrase, or EXACT similarity (>= ${options.thresholds.exact}); got ${seen}`,
        tier,
      };
    }
  }

  if (tier === 'none') {
    return {
      allow: false,
      code: 'below-threshold',
      reason: `${input.toolId} scored ${input.score.toFixed(3)}, below the LOW threshold (${options.thresholds.low})`,
      tier,
    };
  }

  if ((tier === 'medium' || tier === 'low') && options.requireLLMForSubHighDispatch && !input.llmApproved) {
    return {
      allow: false,
      code: 'needs-llm-verifier',
      reason: `${input.toolId} scored ${input.score.toFixed(3)} (${tier}); below HIGH a tool runs only after an LLM verifier approves it`,
      tier,
    };
  }

  return { allow: true, code: 'allow', reason: `${input.toolId} allowed at ${tier} (${input.score.toFixed(3)})`, tier };
}
