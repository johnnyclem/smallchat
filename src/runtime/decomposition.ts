/**
 * Intent Decomposition — Pillar 3 of smallchat 0.4.0.
 *
 * `doesNotUnderstand:` — when confidence is LOW, decompose a complex intent
 * into sub-intents and dispatch each one through the normal pipeline.
 *
 * The Smalltalk parallel: a message cascade — one message becomes many.
 */

import type { ToolResult, ToolIMP } from '../core/types.js';
import type { LLMClient, SubIntent, ToolSummary } from '../core/llm-client.js';

// ---------------------------------------------------------------------------
// Decomposition result
// ---------------------------------------------------------------------------

export interface DecompositionResult {
  original: string;
  subIntents: SubIntent[];
  strategy: 'sequential' | 'parallel' | 'conditional';
  /** Whether decomposition was successful */
  decomposed: boolean;
}

// ---------------------------------------------------------------------------
// Decomposition options
// ---------------------------------------------------------------------------

export interface DecompositionOptions {
  /** Maximum decomposition depth to prevent infinite chains (default: 3) */
  maxDepth?: number;
  /** Current depth (used internally for recursive decomposition) */
  currentDepth?: number;
}

// ---------------------------------------------------------------------------
// Decomposition engine
// ---------------------------------------------------------------------------

/**
 * Decompose a complex intent into sub-intents using available tools.
 *
 * Called when confidence is LOW (0.60-0.75). If no LLM client is available,
 * returns a non-decomposed result so dispatch can fall through to the
 * forwarding chain.
 */
export async function decompose(
  intent: string,
  availableTools: ToolSummary[],
  llmClient?: LLMClient,
  options?: DecompositionOptions,
): Promise<DecompositionResult> {
  const maxDepth = options?.maxDepth ?? 3;
  const currentDepth = options?.currentDepth ?? 0;

  // Guard: depth limit
  if (currentDepth >= maxDepth) {
    return {
      original: intent,
      subIntents: [],
      strategy: 'sequential',
      decomposed: false,
    };
  }

  // Requires LLM client
  if (!llmClient?.decompose) {
    return {
      original: intent,
      subIntents: [],
      strategy: 'sequential',
      decomposed: false,
    };
  }

  const response = await llmClient.decompose({ intent, availableTools });

  if (!response.subIntents || response.subIntents.length === 0) {
    return {
      original: intent,
      subIntents: [],
      strategy: 'sequential',
      decomposed: false,
    };
  }

  return {
    original: intent,
    subIntents: response.subIntents,
    strategy: response.strategy,
    decomposed: true,
  };
}

/**
 * Execute a decomposed intent's sub-intents via a dispatch function.
 *
 * The dispatcher callback is injected so this module doesn't depend on
 * DispatchContext directly — keeping it testable and avoiding circular deps.
 */
export async function executeDecomposition(
  result: DecompositionResult,
  dispatcher: (intent: string, args?: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!result.decomposed || result.subIntents.length === 0) {
    return {
      content: { error: 'Could not decompose intent', original: result.original },
      isError: true,
    };
  }

  const results: Map<string, ToolResult> = new Map();

  if (result.strategy === 'parallel') {
    // Execute all sub-intents in parallel (no dependencies)
    const promises = result.subIntents.map(async (sub) => {
      const subResult = await dispatcher(sub.intent, sub.args);
      return { intent: sub.intent, result: subResult };
    });
    const settled = await Promise.all(promises);
    for (const { intent, result } of settled) {
      results.set(intent, result);
    }
  } else {
    // Sequential execution with dependency resolution
    for (const sub of result.subIntents) {
      // Check dependencies are satisfied
      if (sub.dependsOn) {
        const unmet = sub.dependsOn.filter(dep => !results.has(dep));
        if (unmet.length > 0) {
          results.set(sub.intent, {
            content: { error: `Unmet dependencies: ${unmet.join(', ')}` },
            isError: true,
          });
          continue;
        }
      }
      const subResult = await dispatcher(sub.intent, sub.args);
      results.set(sub.intent, subResult);
    }
  }

  // Assemble the results
  const allResults = Array.from(results.entries()).map(([intent, result]) => ({
    intent,
    ...result,
  }));
  const hasErrors = allResults.some(r => r.isError);

  return {
    content: {
      decomposed: true,
      original: result.original,
      strategy: result.strategy,
      results: allResults,
    },
    isError: hasErrors,
    metadata: {
      decomposed: true,
      subIntentCount: result.subIntents.length,
      strategy: result.strategy,
    },
  };
}
