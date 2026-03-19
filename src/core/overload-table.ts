import type { ToolIMP } from './types.js';
import type { SCMethodSignature, MatchQuality } from './sc-types.js';
import { scoreSignatureMatch } from './sc-types.js';

/**
 * OverloadTable — maps a selector to multiple method signatures.
 *
 * Like C++ or Objective-C method families: the same selector (message name)
 * can dispatch to different IMPs depending on the number and types of
 * arguments passed. This enables:
 *
 *   1. Developer-designed overloads — same tool name, different param lists
 *   2. Compiler-generated semantic overloads — similar tools grouped under
 *      one canonical selector, each becoming a distinct overload
 *
 * Resolution priority:
 *   - Exact type match > superclass match > union match > any (id)
 *   - Higher arity match preferred when scores are equal
 *   - Ambiguous matches (equal score, same arity) reported as errors
 */

export interface OverloadEntry {
  signature: SCMethodSignature;
  imp: ToolIMP;
  /** Original tool name (useful when overloads come from semantic grouping) */
  originalToolName?: string;
  /** Whether this overload was compiler-generated from semantic similarity */
  isSemanticOverload: boolean;
}

export interface OverloadResolutionResult {
  imp: ToolIMP;
  signature: SCMethodSignature;
  matchQuality: MatchQuality;
  entry: OverloadEntry;
}

export class OverloadAmbiguityError extends Error {
  candidates: OverloadEntry[];
  args: unknown[];

  constructor(selectorCanonical: string, candidates: OverloadEntry[], args: unknown[]) {
    const names = candidates
      .map(c => c.originalToolName ?? c.signature.signatureKey)
      .join(', ');
    super(
      `Ambiguous overload for "${selectorCanonical}": ` +
      `${candidates.length} candidates match equally [${names}]`,
    );
    this.name = 'OverloadAmbiguityError';
    this.candidates = candidates;
    this.args = args;
  }
}

export class OverloadTable {
  readonly selectorCanonical: string;
  private entries: OverloadEntry[] = [];

  constructor(selectorCanonical: string) {
    this.selectorCanonical = selectorCanonical;
  }

  /** Register an overload for this selector */
  register(
    signature: SCMethodSignature,
    imp: ToolIMP,
    options?: { originalToolName?: string; isSemanticOverload?: boolean },
  ): void {
    // Check for duplicate signature key
    const existing = this.entries.find(
      e => e.signature.signatureKey === signature.signatureKey,
    );
    if (existing) {
      throw new Error(
        `Duplicate overload for "${this.selectorCanonical}" ` +
        `with signature "${signature.signatureKey}"`,
      );
    }

    this.entries.push({
      signature,
      imp,
      originalToolName: options?.originalToolName,
      isSemanticOverload: options?.isSemanticOverload ?? false,
    });
  }

  /**
   * Resolve the best matching overload for the given arguments.
   *
   * Arguments are passed as a positional array. Named arguments
   * (Record<string, unknown>) should be converted to positional
   * form before calling this method.
   */
  resolve(args: unknown[]): OverloadResolutionResult | null {
    let bestScore = -1;
    let bestEntries: OverloadEntry[] = [];

    for (const entry of this.entries) {
      const score = scoreSignatureMatch(entry.signature, args);
      if (score < 0) continue;

      if (score > bestScore) {
        bestScore = score;
        bestEntries = [entry];
      } else if (score === bestScore) {
        bestEntries.push(entry);
      }
    }

    if (bestEntries.length === 0) return null;

    if (bestEntries.length > 1) {
      // Tiebreak: prefer higher arity (more specific match)
      bestEntries.sort((a, b) => b.signature.arity - a.signature.arity);
      if (bestEntries[0].signature.arity === bestEntries[1].signature.arity) {
        // Prefer developer-defined over semantic overloads
        const devDefined = bestEntries.filter(e => !e.isSemanticOverload);
        if (devDefined.length === 1) {
          bestEntries = devDefined;
        } else {
          throw new OverloadAmbiguityError(this.selectorCanonical, bestEntries, args);
        }
      }
    }

    const winner = bestEntries[0];
    const matchQuality = this.deriveMatchQuality(bestScore, winner.signature.arity);

    return {
      imp: winner.imp,
      signature: winner.signature,
      matchQuality,
      entry: winner,
    };
  }

  /** Resolve using named arguments by mapping them to positional form */
  resolveNamed(
    namedArgs: Record<string, unknown>,
    signature?: SCMethodSignature,
  ): OverloadResolutionResult | null {
    // If no specific signature, try all overloads with name-to-position mapping
    if (!signature) {
      let bestResult: OverloadResolutionResult | null = null;
      let bestScore = -1;

      for (const entry of this.entries) {
        const positional = namedToPositional(namedArgs, entry.signature);
        const score = scoreSignatureMatch(entry.signature, positional);
        if (score > bestScore) {
          bestScore = score;
          const quality = this.deriveMatchQuality(score, entry.signature.arity);
          bestResult = {
            imp: entry.imp,
            signature: entry.signature,
            matchQuality: quality,
            entry,
          };
        }
      }

      return bestResult;
    }

    const positional = namedToPositional(namedArgs, signature);
    return this.resolve(positional);
  }

  /** Get all registered overloads */
  allOverloads(): readonly OverloadEntry[] {
    return this.entries;
  }

  /** Number of registered overloads */
  get size(): number {
    return this.entries.length;
  }

  /** Check if a specific signature is registered */
  hasSignature(signatureKey: string): boolean {
    return this.entries.some(e => e.signature.signatureKey === signatureKey);
  }

  private deriveMatchQuality(score: number, arity: number): MatchQuality {
    if (arity === 0) return 'exact';
    const avg = score / arity;
    if (avg >= 4) return 'exact';
    if (avg >= 3) return 'superclass';
    if (avg >= 2) return 'union';
    return 'any';
  }
}

/**
 * Convert named arguments to positional form using a signature's parameter names.
 */
function namedToPositional(
  namedArgs: Record<string, unknown>,
  signature: SCMethodSignature,
): unknown[] {
  const positional: unknown[] = new Array(signature.arity);

  for (const slot of signature.parameters) {
    if (slot.name in namedArgs) {
      positional[slot.position] = namedArgs[slot.name];
    } else if (slot.defaultValue !== undefined) {
      positional[slot.position] = slot.defaultValue;
    } else if (!slot.required) {
      positional[slot.position] = undefined;
    }
  }

  return positional;
}
