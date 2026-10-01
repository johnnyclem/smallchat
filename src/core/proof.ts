/**
 * Resolution proof — a structured, replayable record of why a tool was (or
 * was not) chosen, and which tool actually ran.
 *
 * Everything that determines a decision is recorded: the candidate table
 * with scores and tiers, the thresholds and guards in force, the embedder
 * fingerprint and artifact hash, the decision code, and the canonical call
 * digest of what executed. Raw arguments are never recorded (the call
 * digest binds them without revealing them).
 *
 * `proofDigest` is sha256hex(UTF8("smallchat.proof.v1") || 0x00 ||
 * UTF8(JCS(proof without "timings" and "proofDigest"))), so two runs that
 * made the same decision from the same inputs have the same digest even
 * though their wall-clock timings differ.
 */

import { DEFAULT_THRESHOLDS } from './confidence.js';
import type { ConfidenceTier, TierThresholds } from './confidence.js';
import type { EmbedderFingerprint } from './types.js';
import { canonicalJson } from './jcs.js';
import { domainDigest } from './sha256.js';

/** Domain-separation prefix of the proof digest. */
export const PROOF_DIGEST_DOMAIN = 'smallchat.proof.v1';

/**
 * What resolution concluded.
 * - resolved: exactly one tool is chosen and may execute.
 * - needs-disambiguation: there are candidates, but policy or verification
 *   refuses to pick one on its own; the caller chooses (by tool id).
 * - unresolved: nothing plausible matched.
 */
export type ResolutionOutcome = 'resolved' | 'needs-disambiguation' | 'unresolved';

/** Where a candidate came from. */
export type CandidateSource =
  | 'exact-id'
  | 'pin'
  | 'semantic-map-exact'
  | 'semantic-map-similar'
  | 'cache'
  | 'vector'
  | 'overload'
  | 'protocol';

/** The rule that settled the outcome. */
export type DecisionCode =
  /** Addressed by canonical tool id (dispatchById) */
  | 'exact-id'
  /** The intent is a pinned phrase (pin canonical or alias) */
  | 'pin-exact'
  /** This exact intent was taught through a resolved refinement */
  | 'learned-exact'
  /** A cached resolution of this intent */
  | 'cache'
  /** Top-ranked candidate at EXACT/HIGH tier */
  | 'ranked'
  /** Sub-HIGH candidate approved by the LLM verifier */
  | 'llm-verified'
  /** Sub-HIGH candidate passed schema/keyword verification (requireLLMForSubHighDispatch off) */
  | 'verified'
  /** LOW-tier or unmatched intent split into sub-intents, each dispatched separately */
  | 'decomposed'
  /** Sub-HIGH candidate without LLM approval */
  | 'needs-llm-verifier'
  /** Every candidate failed verification */
  | 'verification-failed'
  /** Destructive tool below EXACT tier */
  | 'destructive-needs-exact'
  /** Tool pinned 'exact' and the intent is not one of its pinned phrases */
  | 'pin-exact-required'
  /** Tool pinned 'elevated' and the intent's own similarity is below the pin threshold */
  | 'pin-elevated-required'
  /** Best candidate is below the LOW threshold */
  | 'below-threshold'
  /** Nothing scored above the search floor */
  | 'no-candidates'
  /** dispatchById with an id that is not registered (or is ambiguous) */
  | 'unknown-tool';

export type ProofStage =
  | 'exact_id'
  | 'intent_pin'
  | 'semantic_map'
  | 'cache'
  | 'vector_search'
  | 'overload'
  | 'protocol'
  | 'verification'
  | 'policy'
  | 'decomposition'
  | 'refinement'
  | 'validation';

/** One row of the candidate table. */
export interface ProofCandidate {
  /** Canonical tool id `<providerId>/<toolName>` */
  toolId: string;
  /** Selector canonical the candidate matched through */
  selector: string;
  /** Score the decision used (vector similarity, possibly boosted by a learned preference) */
  score: number;
  /**
   * Cosine similarity between this intent's own embedding and the selector,
   * or null when the candidate did not come from a vector comparison
   * (exact id, pinned phrase, cache, learned-exact, protocol, injected).
   */
  similarity: number | null;
  tier: ConfidenceTier;
  source: CandidateSource;
  /** Set when the candidate was ruled out, to the rule that excluded it */
  excluded?: string;
}

export interface ProofStep {
  stage: ProofStage;
  /** What happened at this stage, for humans */
  decision: string;
  /** The facts behind it, as JSON (never raw arguments) */
  detail?: Record<string, unknown>;
}

/** Guards in force when the decision was made. */
export interface ProofGuards {
  requireLLMForSubHighDispatch: boolean;
  strict: boolean;
  /** Whether an LLM verifier (LLMClient.microCheck) was configured */
  llmVerifier: boolean;
  treatUnannotatedAsDestructive: boolean;
}

export interface ResolutionProof {
  version: 1;
  /** The intent resolved, or null for a dispatch by tool id */
  intent: string | null;
  outcome: ResolutionOutcome;
  decision: DecisionCode;
  tier: ConfidenceTier;
  /** Tool id resolution chose, or null */
  chosen: string | null;
  /** Score of the chosen candidate, or null */
  confidence: number | null;
  /** Tool id that actually executed, or null when nothing ran */
  ran: string | null;
  /** Canonical call digest (spec/call-digest) of the executed call, or null */
  callDigest: string | null;
  /** Proof digest of the resolution this dispatch-by-id acted on, when the caller linked one */
  resolutionDigest: string | null;
  /** Every candidate considered, best first; excluded ones last */
  candidates: ProofCandidate[];
  thresholds: TierThresholds;
  guards: ProofGuards;
  /** Fingerprint of the embedder intents were embedded with (null: none declared / by id) */
  embedder: EmbedderFingerprint | null;
  /** contentHash of the artifact the runtime was loaded from, when known */
  artifactHash: string | null;
  steps: ProofStep[];
  /** Wall-clock milliseconds (performance.now); excluded from proofDigest */
  timings: { totalMs: number; stepsMs: number[] };
  /** Digest of everything above except timings; see module doc */
  proofDigest: string;
}

/** What a proof records about the runtime it was produced by. */
export interface ProofContext {
  thresholds: TierThresholds;
  guards: ProofGuards;
  embedder: EmbedderFingerprint | null;
  artifactHash: string | null;
}

const DEFAULT_GUARDS: ProofGuards = {
  requireLLMForSubHighDispatch: true,
  strict: false,
  llmVerifier: false,
  treatUnannotatedAsDestructive: false,
};

/** Create an empty proof (outcome unresolved, nothing chosen or run). */
export function createProof(intent: string | null, context: Partial<ProofContext> = {}): ResolutionProof {
  return {
    version: 1,
    intent,
    outcome: 'unresolved',
    decision: 'no-candidates',
    tier: 'none',
    chosen: null,
    confidence: null,
    ran: null,
    callDigest: null,
    resolutionDigest: null,
    candidates: [],
    thresholds: { ...(context.thresholds ?? DEFAULT_THRESHOLDS) },
    guards: { ...DEFAULT_GUARDS, ...context.guards },
    embedder: context.embedder ?? null,
    artifactHash: context.artifactHash ?? null,
    steps: [],
    timings: { totalMs: 0, stepsMs: [] },
    proofDigest: '',
  };
}

/** Append a step; its elapsed time goes to `timings`, outside the digest. */
export function addProofStep(proof: ResolutionProof, step: ProofStep, elapsedMs = 0): void {
  proof.steps.push(step);
  proof.timings.stepsMs.push(elapsedMs);
  proof.timings.totalMs += elapsedMs;
}

/** The digest of a proof's decision content (see module doc). */
export function computeProofDigest(proof: ResolutionProof): string {
  const { timings: _timings, proofDigest: _digest, ...body } = proof;
  return domainDigest(PROOF_DIGEST_DOMAIN, canonicalJson(body));
}

/** Recompute and store `proofDigest`. Call after the last change to a proof. */
export function finalizeProof(proof: ResolutionProof): ResolutionProof {
  proof.proofDigest = computeProofDigest(proof);
  return proof;
}

/** A monotonic millisecond clock (performance.now), for proof timings. */
export function proofClock(): number {
  return performance.now();
}
