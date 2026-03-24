import type { ToolIMP } from './types.js';
import type { SCMethodSignature, MatchQuality, SignatureViolation, SignatureValidationResult } from './sc-types.js';
import { scoreSignatureMatch, validateArgumentTypes, validateNamedArgumentTypes } from './sc-types.js';

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
    const argTypes = args.map(a => typeof a).join(', ');
    const candidateDetails = candidates
      .map(c => `  - ${c.originalToolName ?? c.signature.signatureKey}: ${c.signature.signatureKey}`)
      .join('\n');
    super(
      `Ambiguous overload for "${selectorCanonical}": ` +
      `${candidates.length} candidates match equally [${names}]\n` +
      `\nArgument types received: (${argTypes})\n` +
      `Matching candidates:\n${candidateDetails}\n` +
      `\nTo fix this:\n` +
      `  1. Make argument types more specific to distinguish overloads\n` +
      `  2. Use named arguments with runtime.intent('...').withArgs({...}) for explicit dispatch\n` +
      `  3. Remove one of the ambiguous overloads if they are duplicates`,
    );
    this.name = 'OverloadAmbiguityError';
    this.candidates = candidates;
    this.args = args;
  }
}

/**
 * SignatureValidationError — thrown when arguments fail strict type validation.
 *
 * This is the primary defence against Type Confusion attacks: an LLM may
 * suggest arguments that score well enough for overload *resolution* (e.g.
 * via 'any' slots) but violate the strict type contract of the winning
 * signature. This error fires AFTER resolution but BEFORE dispatch.
 */
export class SignatureValidationError extends Error {
  violations: SignatureViolation[];
  signature: SCMethodSignature;
  args: unknown[];

  constructor(
    selectorCanonical: string,
    signature: SCMethodSignature,
    violations: SignatureViolation[],
    args: unknown[],
  ) {
    const details = violations
      .map(v => `  - ${v.parameterName} (position ${v.position}): expected ${v.expected}, received ${v.received} [${v.kind}]`)
      .join('\n');

    super(
      `Signature validation failed for "${selectorCanonical}" ` +
      `(signature: ${signature.signatureKey}):\n${details}\n` +
      `\nThis may indicate a Type Confusion attack. ` +
      `The LLM-suggested arguments do not conform to the SCObject type hierarchy.\n` +
      `To fix this:\n` +
      `  1. Ensure arguments match the expected types exactly\n` +
      `  2. Use SCObject subclasses where object types are expected\n` +
      `  3. Do not pass primitives where SCObject instances are required`,
    );
    this.name = 'SignatureValidationError';
    this.violations = violations;
    this.signature = signature;
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

  /**
   * Resolve AND strictly validate — the hardened dispatch path.
   *
   * 1. Resolves the best-matching overload (same as `resolve`)
   * 2. Re-validates every argument against the winning signature's
   *    type descriptors using strict `validateArgumentTypes`
   * 3. Throws `SignatureValidationError` if any argument violates the
   *    SCObject type hierarchy
   *
   * This two-phase approach catches Type Confusion attacks: an attacker
   * might craft arguments that score > 0 in overload ranking (e.g.
   * through 'any' or 'union' slots) but should be rejected on closer
   * inspection.
   */
  validateAndResolve(args: unknown[]): OverloadResolutionResult | null {
    const result = this.resolve(args);
    if (!result) return null;

    const validation = validateArgumentTypes(result.signature, args);
    if (!validation.valid) {
      throw new SignatureValidationError(
        this.selectorCanonical,
        result.signature,
        validation.violations,
        args,
      );
    }

    return result;
  }

  /**
   * Named-argument variant of validateAndResolve.
   *
   * Resolves overloads via named args, then strictly validates every
   * argument against the winning signature's type hierarchy.
   */
  validateAndResolveNamed(
    namedArgs: Record<string, unknown>,
    signature?: SCMethodSignature,
  ): OverloadResolutionResult | null {
    const result = this.resolveNamed(namedArgs, signature);
    if (!result) return null;

    const validation = validateNamedArgumentTypes(result.signature, namedArgs);
    if (!validation.valid) {
      throw new SignatureValidationError(
        this.selectorCanonical,
        result.signature,
        validation.violations,
        Object.values(namedArgs),
      );
    }

    return result;
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
