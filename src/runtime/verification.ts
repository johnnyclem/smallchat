/**
 * Pre-Flight Verification — Pillar 2 of smallchat 0.4.0.
 *
 * `respondsToSelector:` — a lightweight gate between resolution and execution.
 * Runs three progressive verification strategies:
 *   1. Schema validation (microseconds) — do the args fit the tool's input schema?
 *   2. Keyword overlap (microseconds) — do entities in the intent appear in the tool?
 *   3. LLM micro-check (optional, ~100ms) — ask a fast model for confirmation
 */

import type { ToolIMP, ToolSchema, ArgumentSpec } from '../core/types.js';
import type { LLMClient } from '../core/llm-client.js';

// ---------------------------------------------------------------------------
// Verification result
// ---------------------------------------------------------------------------

export interface VerificationResult {
  pass: boolean;
  schemaMatch: boolean;
  descriptionOverlap: number;
  llmConfirmed?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Verification options
// ---------------------------------------------------------------------------

export interface VerificationOptions {
  /** Skip the LLM micro-check even if a client is available */
  skipLLMCheck?: boolean;
  /** Minimum keyword overlap score to pass (0-1, default 0.15) */
  minOverlap?: number;
}

// ---------------------------------------------------------------------------
// Verification engine
// ---------------------------------------------------------------------------

/**
 * Verify that a resolved tool actually matches the caller's intent.
 *
 * Called for MEDIUM-confidence dispatches, or all dispatches in --strict mode.
 */
export async function verify(
  imp: ToolIMP,
  intent: string,
  args: Record<string, unknown>,
  llmClient?: LLMClient,
  options?: VerificationOptions,
): Promise<VerificationResult> {
  const schema = imp.schema ?? await imp.schemaLoader();
  const minOverlap = options?.minOverlap ?? 0.15;

  // Strategy 1: Schema validation — do the args fit?
  const schemaMatch = validateArgsAgainstSchema(args, schema);
  if (!schemaMatch) {
    return {
      pass: false,
      schemaMatch: false,
      descriptionOverlap: 0,
      reason: `Arguments do not match tool "${imp.toolName}" schema — required parameters missing or type mismatch`,
    };
  }

  // Strategy 2: Keyword overlap — entity intersection between intent and tool
  const overlap = computeKeywordOverlap(intent, schema);
  if (overlap < minOverlap) {
    return {
      pass: false,
      schemaMatch: true,
      descriptionOverlap: overlap,
      reason: `Low keyword overlap (${(overlap * 100).toFixed(0)}%) between intent "${intent}" and tool "${imp.toolName}": "${schema.description}"`,
    };
  }

  // Strategy 3: LLM micro-check — optional, only when strategies 1-2 pass but are borderline
  if (!options?.skipLLMCheck && llmClient?.microCheck && overlap < 0.5) {
    const confirmed = await llmClient.microCheck({
      intent,
      toolName: imp.toolName,
      toolDescription: schema.description,
    });

    return {
      pass: confirmed,
      schemaMatch: true,
      descriptionOverlap: overlap,
      llmConfirmed: confirmed,
      reason: confirmed
        ? undefined
        : `LLM micro-check rejected: tool "${imp.toolName}" does not match intent "${intent}"`,
    };
  }

  return {
    pass: true,
    schemaMatch: true,
    descriptionOverlap: overlap,
  };
}

// ---------------------------------------------------------------------------
// Strategy 1: Schema validation
// ---------------------------------------------------------------------------

/**
 * Check whether the provided args satisfy the tool's required parameters.
 * This is a structural check — not type validation (that's handled by constraints).
 */
function validateArgsAgainstSchema(
  args: Record<string, unknown>,
  schema: ToolSchema,
): boolean {
  const required = schema.arguments.filter(a => a.required);
  for (const arg of required) {
    if (!(arg.name in args)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Strategy 2: Keyword overlap
// ---------------------------------------------------------------------------

/**
 * Compute entity/keyword overlap between intent text and tool metadata.
 * Returns a score between 0 and 1.
 */
export function computeKeywordOverlap(intent: string, schema: ToolSchema): number {
  const intentTokens = tokenize(intent);
  if (intentTokens.size === 0) return 0;

  // Build the tool's keyword set from name, description, and parameter names
  const toolText = [
    schema.name,
    schema.description,
    ...schema.arguments.map(a => a.name),
    ...schema.arguments.map(a => a.description),
  ].join(' ');
  const toolTokens = tokenize(toolText);

  if (toolTokens.size === 0) return 0;

  // Jaccard-like overlap: |intersection| / |intentTokens|
  let matches = 0;
  for (const token of intentTokens) {
    if (toolTokens.has(token)) matches++;
  }

  return matches / intentTokens.size;
}

/** Tokenize text into a set of lowercase keywords, removing stopwords */
function tokenize(text: string): Set<string> {
  const stopwords = new Set([
    'a', 'an', 'the', 'my', 'your', 'is', 'are', 'to', 'for', 'of', 'with',
    'and', 'or', 'in', 'on', 'at', 'by', 'do', 'this', 'that', 'it', 'i',
    'me', 'we', 'you', 'he', 'she', 'they', 'please', 'can', 'will',
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/[\s_-]+/)
    .filter(w => w.length > 1 && !stopwords.has(w));

  return new Set(words);
}
