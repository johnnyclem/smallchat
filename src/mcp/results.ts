/**
 * Shaping runtime results into MCP CallToolResults for `smallchat serve`.
 *
 * - An upstream MCP result passes through verbatim: every content block
 *   (text, image, audio, resource links, embedded resources),
 *   structuredContent, isError and the upstream's own _meta.
 * - Anything else that failed carries its reason as text, so a model can
 *   correct itself (invalid arguments list each violation).
 * - Every result carries a compact proof of what ran and why under
 *   _meta['dev.smallchat/resolution'] — never as non-standard top-level
 *   fields.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResult } from '../core/types.js';
import type { DecisionCode, ResolutionOutcome, ResolutionProof } from '../core/proof.js';
import type { ConfidenceTier } from '../core/confidence.js';
import { UPSTREAM_RESULT_KEY } from './upstream.js';

/** The _meta key smallchat's resolution record lives under. */
export const RESOLUTION_META_KEY = 'dev.smallchat/resolution';

/** What `_meta['dev.smallchat/resolution']` holds. */
export interface CompactResolution {
  /** Tool id resolution chose (null when nothing was chosen) */
  toolId: string | null;
  /** Tool id that actually executed (null when nothing ran) */
  ran: string | null;
  outcome: ResolutionOutcome;
  decision: DecisionCode;
  tier: ConfidenceTier;
  /** Canonical call digest (spec/call-digest) of what ran */
  callDigest: string | null;
  /** Digest of the full proof (see core/proof.ts) */
  proofDigest: string;
  /** contentHash of the artifact the server was loaded from */
  artifactHash: string | null;
}

/** The compact, digest-bound summary of a proof. */
export function compactResolution(proof: ResolutionProof): CompactResolution {
  return {
    toolId: proof.chosen,
    ran: proof.ran,
    outcome: proof.outcome,
    decision: proof.decision,
    tier: proof.tier,
    callDigest: proof.callDigest,
    proofDigest: proof.proofDigest,
    artifactHash: proof.artifactHash,
  };
}

/** Convert a runtime result to the CallToolResult a client receives. */
export function toCallToolResult(result: ToolResult): CallToolResult {
  const proof = result.metadata?.proof as ResolutionProof | undefined;
  const meta = proof ? { [RESOLUTION_META_KEY]: compactResolution(proof) } : undefined;

  const upstream = result.metadata?.[UPSTREAM_RESULT_KEY] as CallToolResult | undefined;
  if (upstream) {
    return {
      ...upstream,
      content: upstream.content ?? [],
      ...(upstream.isError ? { isError: true } : {}),
      ...(meta || upstream._meta ? { _meta: { ...upstream._meta, ...meta } } : {}),
    };
  }

  const out: CallToolResult = {
    content: [{ type: 'text', text: result.isError ? errorText(result) : valueText(result.content) }],
  };
  if (result.isError) out.isError = true;
  else if (isPlainObject(result.content)) out.structuredContent = result.content;
  if (meta) out._meta = meta;
  return out;
}

/** A tool-level error result with a plain-text reason. */
export function errorResult(text: string, meta?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true, ...(meta ? { _meta: meta } : {}) };
}

function errorText(result: ToolResult): string {
  const content = result.content;
  if (typeof content === 'string' && content.length > 0) return content;
  if (isPlainObject(content)) {
    const { error, errors, ...rest } = content as { error?: unknown; errors?: unknown } & Record<string, unknown>;
    const lines: string[] = [];
    if (typeof error === 'string') lines.push(error);
    if (Array.isArray(errors)) lines.push(...errors.map(e => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`));
    if (lines.length > 0) {
      if (Object.keys(rest).length > 0) lines.push(JSON.stringify(rest));
      return lines.join('\n');
    }
  }
  const reason = result.metadata?.error;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (content !== null && content !== undefined) return valueText(content);
  return 'The tool failed without giving a reason.';
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
