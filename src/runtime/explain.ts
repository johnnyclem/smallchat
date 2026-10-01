/**
 * Explain — why a resolution came out the way it did, for operators
 * (`smallchat explain <artifact> <intent>`, `runtime.explain(intent)`).
 *
 * Adds to the resolution's proof, for every candidate: its rank, the
 * tool's MCP annotations, whether it counts as destructive or pinned, and
 * the dispatch policy's verdict on running it without the caller naming it
 * (runtime/policy.ts — the same function every dispatch path applies).
 * A verdict assumes no LLM approval except for the candidate an LLM
 * verifier actually approved. Nothing executes.
 */

import type { ToolAnnotations, ToolSelector } from '../core/types.js';
import type { ProofCandidate, ProofGuards, ProofStep } from '../core/proof.js';
import type { TierThresholds } from '../core/confidence.js';
import { quantizeScore } from '../core/confidence.js';
import { cosineSimilarity } from '../core/vector-math.js';
import type { EmbedderFingerprint } from '../core/types.js';
import { evaluateDispatchPolicy, isDestructive } from './policy.js';
import type { PolicyVerdict } from './policy.js';
import type { DispatchContext, Resolution } from './dispatch.js';

/** One row of the candidate table. */
export interface ExplainedCandidate extends ProofCandidate {
  /** 1-based rank among eligible candidates; null for excluded ones */
  rank: number | null;
  /** Whether resolution chose this candidate */
  chosen: boolean;
  annotations: ToolAnnotations | null;
  destructive: boolean;
  pinned: boolean;
  /** Policy verdict on running it without the caller choosing; null when excluded */
  verdict: PolicyVerdict | null;
}

export interface Explanation {
  intent: string;
  outcome: Resolution['outcome'];
  decision: Resolution['proof']['decision'];
  tier: Resolution['tier'];
  chosen: string | null;
  reason: string | null;
  candidates: ExplainedCandidate[];
  thresholds: TierThresholds;
  guards: ProofGuards;
  embedder: EmbedderFingerprint | null;
  artifactHash: string | null;
  steps: ProofStep[];
  proofDigest: string;
  resolution: Resolution;
}

/** Explain a resolution made by `context` (see module doc). */
export async function explainResolution(context: DispatchContext, resolution: Resolution): Promise<Explanation> {
  const { proof } = resolution;
  let ownVector: Float32Array | null = null;
  const ownSimilarity = async (selector: ToolSelector): Promise<number> => {
    ownVector ??= await context.embedder.embed(resolution.intent);
    return quantizeScore(cosineSimilarity(ownVector, selector.vector));
  };

  const eligible = new Set(resolution.candidates.map(c => c.toolId));
  let rank = 0;
  const candidates: ExplainedCandidate[] = [];
  for (const c of proof.candidates) {
    const tool = context.getTool(c.toolId);
    const annotations = tool?.imp.annotations ?? null;
    const destructive = isDestructive(annotations ?? undefined, context.policyOptions);
    const pinned = context.isPinnedTool(c.toolId);
    const isEligible = c.excluded === undefined && eligible.has(c.toolId);
    let verdict: PolicyVerdict | null = null;
    if (isEligible && tool) {
      const pins = await context.pinStatesFor(c.toolId, resolution.intent, ownSimilarity);
      const llmApproved = proof.chosen === c.toolId && proof.decision === 'llm-verified';
      verdict = evaluateDispatchPolicy(
        { mode: 'intent', toolId: c.toolId, imp: tool.imp, source: c.source, score: c.score, similarity: c.similarity, llmApproved, pins },
        context.policyOptions,
      );
    }
    candidates.push({
      ...c,
      rank: isEligible ? ++rank : null,
      chosen: proof.chosen === c.toolId,
      annotations,
      destructive,
      pinned,
      verdict,
    });
  }

  return {
    intent: resolution.intent,
    outcome: resolution.outcome,
    decision: proof.decision,
    tier: resolution.tier,
    chosen: resolution.chosen ?? null,
    reason: resolution.reason ?? null,
    candidates,
    thresholds: proof.thresholds,
    guards: proof.guards,
    embedder: proof.embedder,
    artifactHash: proof.artifactHash,
    steps: proof.steps,
    proofDigest: proof.proofDigest,
    resolution,
  };
}

/** Human-readable explanation (what `smallchat explain` prints). */
export function formatExplanation(e: Explanation): string {
  const lines: string[] = [];
  const t = e.thresholds;
  lines.push(`Intent:      ${JSON.stringify(e.intent)}`);
  lines.push(`Artifact:    ${e.artifactHash ?? '(unknown)'}`);
  if (e.embedder) {
    lines.push(`Embedder:    ${e.embedder.kind} ${e.embedder.model} (${e.embedder.dims} dims${e.embedder.modelSha256 ? `, sha256 ${e.embedder.modelSha256.slice(0, 12)}…` : ''})`);
  }
  lines.push(`Thresholds:  EXACT ${t.exact}  HIGH ${t.high}  MEDIUM ${t.medium}  LOW ${t.low}`);
  lines.push(`Guards:      LLM verifier ${e.guards.llmVerifier ? 'configured' : 'none'}` +
    `${e.guards.requireLLMForSubHighDispatch ? ' (required below HIGH)' : ''}` +
    `, strict ${e.guards.strict ? 'on' : 'off'}` +
    `${e.guards.treatUnannotatedAsDestructive ? ', unannotated tools count as destructive' : ''}`);
  lines.push('');
  lines.push(`Outcome:     ${e.outcome}  (decision ${e.decision}, tier ${e.tier.toUpperCase()})`);
  if (e.chosen) lines.push(`Chosen:      ${e.chosen}`);
  if (e.reason) lines.push(`Reason:      ${e.reason}`);
  lines.push('');

  if (e.candidates.length === 0) {
    lines.push('No candidates scored at or above the LOW threshold.');
    const options = e.resolution.refinement?.options ?? [];
    if (options.length > 0) {
      lines.push('Nearest tools (offered as options, not candidates):');
      for (const o of options) lines.push(`  ${o.toolId ?? o.label}  ${o.confidence.toFixed(4)}`);
    }
  } else {
    const rows = e.candidates.map(c => [
      c.rank === null ? '-' : String(c.rank),
      `${c.chosen ? '*' : ' '}${c.toolId}`,
      c.score.toFixed(4),
      c.similarity === null ? '—' : c.similarity.toFixed(4),
      c.tier.toUpperCase(),
      c.source,
      annotationText(c),
      c.excluded ? `excluded: ${c.excluded}` : c.verdict ? c.verdict.code : '—',
    ]);
    const header = ['#', ' tool', 'score', 'sim', 'tier', 'source', 'hints', 'policy'];
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
    const fmt = (r: string[]) => `  ${r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ')}`;
    lines.push(fmt(header));
    for (const r of rows) lines.push(fmt(r));
    lines.push('');
    lines.push('Policy verdicts (running each candidate without the caller naming it):');
    for (const c of e.candidates) {
      if (c.verdict) lines.push(`  ${c.toolId}: ${c.verdict.allow ? 'allowed' : 'refused'} — ${c.verdict.reason}`);
    }
  }

  lines.push('');
  lines.push('Steps:');
  for (const step of e.steps) lines.push(`  ${step.stage.padEnd(14)} ${step.decision}`);
  lines.push('');
  lines.push(`Proof digest: ${e.proofDigest}`);
  return lines.join('\n');
}

function annotationText(c: ExplainedCandidate): string {
  const parts: string[] = [];
  if (c.annotations?.readOnlyHint) parts.push('read-only');
  if (c.destructive) parts.push('destructive');
  if (c.annotations?.idempotentHint) parts.push('idempotent');
  if (c.pinned) parts.push('pinned');
  return parts.length > 0 ? parts.join(',') : '—';
}
