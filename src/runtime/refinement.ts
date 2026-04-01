/**
 * Refinement Protocol — Pillar 4 of smallchat 0.4.0.
 *
 * `forwardInvocation:` — when confidence is NONE (< 0.60), turn dispatch
 * into a dialogue. Ask a structured question to narrow the intent until
 * resolution succeeds.
 *
 * Surfaces as a `tool_refinement_needed` result type in MCP.
 */

import type { ToolResult, ToolRefinementNeeded, SelectorMatch } from '../core/types.js';
import type { LLMClient, RefinementOption, ToolSummary } from '../core/llm-client.js';

// ---------------------------------------------------------------------------
// Refinement result
// ---------------------------------------------------------------------------

export interface RefinementResult {
  /** Whether the runtime produced refinement options */
  refined: boolean;
  /** The structured refinement to present to the caller */
  refinement?: ToolRefinementNeeded;
}

// ---------------------------------------------------------------------------
// Refinement engine
// ---------------------------------------------------------------------------

/**
 * Generate refinement options for an unresolvable intent.
 *
 * Two strategies, from cheapest to most expensive:
 *   1. Heuristic: build options from nearest vector matches
 *   2. LLM-powered: ask the LLM to suggest rewrites
 */
export async function refine(
  intent: string,
  nearestMatches: SelectorMatch[],
  availableTools: ToolSummary[],
  llmClient?: LLMClient,
): Promise<RefinementResult> {
  // Try LLM-powered refinement first (if available)
  if (llmClient?.refine) {
    const response = await llmClient.refine({
      intent,
      nearestTools: availableTools.slice(0, 10),
    });

    if (response.options.length > 0) {
      return {
        refined: true,
        refinement: {
          type: 'tool_refinement_needed',
          originalIntent: intent,
          question: response.question,
          options: response.options,
          narrowedIntents: response.narrowedIntents,
        },
      };
    }
  }

  // Fallback: heuristic refinement from nearest vector matches
  if (nearestMatches.length > 0) {
    const options = nearestMatches.slice(0, 5).map(match => ({
      label: formatSelectorLabel(match.id),
      intent: match.id.replace(/:/g, ' '),
      confidence: 1 - match.distance,
    }));

    return {
      refined: true,
      refinement: {
        type: 'tool_refinement_needed',
        originalIntent: intent,
        question: `I couldn't find an exact match for "${intent}". Did you mean one of these?`,
        options,
        narrowedIntents: options.map(o => o.intent),
      },
    };
  }

  return { refined: false };
}

/**
 * Build a ToolResult wrapping a refinement response.
 * MCP-aware clients see the `refinement` field; others see a helpful message.
 */
export function buildRefinementResult(refinement: ToolRefinementNeeded): ToolResult {
  return {
    content: {
      message: refinement.question,
      options: refinement.options.map(o => o.label),
      hint: 'Re-dispatch with one of the suggested intents for a more precise match.',
    },
    isError: false,
    refinement,
    metadata: {
      refinement: true,
      optionCount: refinement.options.length,
    },
  };
}

/** Format a colon-separated selector ID into a human-readable label */
function formatSelectorLabel(selectorId: string): string {
  // "vendor.github.search_code" → "Search code (github)"
  const parts = selectorId.split('.');
  const toolPart = parts[parts.length - 1] ?? selectorId;
  const providerPart = parts.length > 1 ? parts[parts.length - 2] : undefined;

  const label = toolPart
    .replace(/[_:]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  return providerPart ? `${label} (${providerPart})` : label;
}
