import { SCObject, isSubclass } from './sc-object.js';

/**
 * SCTypeDescriptor — describes what type a parameter slot accepts.
 *
 * Bridges JSON Schema primitive types with SCObject class types,
 * enabling the overload system to resolve the correct IMP based
 * on argument types at dispatch time.
 */

export type SCPrimitiveType = 'string' | 'number' | 'boolean' | 'null';

export type SCTypeDescriptor =
  | { kind: 'primitive'; type: SCPrimitiveType }
  | { kind: 'object'; className: string }    // Matches a specific SCObject subclass
  | { kind: 'union'; types: SCTypeDescriptor[] }  // Matches any of the listed types
  | { kind: 'any' };                          // id — accepts anything

/**
 * SCParameterSlot — defines a single positional parameter in a function signature.
 */
export interface SCParameterSlot {
  /** Parameter name (for documentation and named-argument fallback) */
  name: string;
  /** Positional index (0-based) */
  position: number;
  /** Accepted type(s) */
  type: SCTypeDescriptor;
  /** Whether this parameter is required */
  required: boolean;
  /** Default value if not provided */
  defaultValue?: unknown;
}

/**
 * SCMethodSignature — a specific function signature (combination of parameter types).
 *
 * Multiple signatures can be registered for the same selector, forming overloads.
 * The signature key (e.g. "string:SCData:number") enables fast lookup.
 */
export interface SCMethodSignature {
  /** Ordered parameter slots */
  parameters: SCParameterSlot[];
  /** Number of parameters */
  arity: number;
  /** Compact type key for fast matching, e.g. "string:SCData:number" */
  signatureKey: string;
}

/** Match quality from overload resolution, ordered from best to worst */
export type MatchQuality = 'exact' | 'superclass' | 'union' | 'any' | 'none';

const MATCH_QUALITY_RANK: Record<MatchQuality, number> = {
  exact: 4,
  superclass: 3,
  union: 2,
  any: 1,
  none: 0,
};

/**
 * Build a signature key from parameter types.
 * e.g. [primitive:string, object:SCData, primitive:number] → "string:SCData:number"
 */
export function buildSignatureKey(params: SCParameterSlot[]): string {
  return params
    .map(p => typeDescriptorToKey(p.type))
    .join(':') || 'void';
}

function typeDescriptorToKey(type: SCTypeDescriptor): string {
  switch (type.kind) {
    case 'primitive': return type.type;
    case 'object': return type.className;
    case 'union': return `(${type.types.map(typeDescriptorToKey).join('|')})`;
    case 'any': return 'id';
  }
}

/**
 * Create an SCMethodSignature from parameter slot definitions.
 */
export function createSignature(params: SCParameterSlot[]): SCMethodSignature {
  return {
    parameters: params,
    arity: params.length,
    signatureKey: buildSignatureKey(params),
  };
}

/**
 * Create a parameter slot (convenience builder).
 */
export function param(
  name: string,
  position: number,
  type: SCTypeDescriptor,
  required = true,
  defaultValue?: unknown,
): SCParameterSlot {
  return { name, position, type, required, defaultValue };
}

// Convenience type constructors
export const SCType = {
  string: (): SCTypeDescriptor => ({ kind: 'primitive', type: 'string' }),
  number: (): SCTypeDescriptor => ({ kind: 'primitive', type: 'number' }),
  boolean: (): SCTypeDescriptor => ({ kind: 'primitive', type: 'boolean' }),
  null: (): SCTypeDescriptor => ({ kind: 'primitive', type: 'null' }),
  object: (className: string): SCTypeDescriptor => ({ kind: 'object', className }),
  union: (...types: SCTypeDescriptor[]): SCTypeDescriptor => ({ kind: 'union', types }),
  any: (): SCTypeDescriptor => ({ kind: 'any' }),
} as const;

/**
 * Check if a runtime value matches a type descriptor.
 * Returns the quality of the match.
 */
export function matchType(value: unknown, type: SCTypeDescriptor): MatchQuality {
  switch (type.kind) {
    case 'any':
      return 'any';

    case 'primitive':
      if (value === null && type.type === 'null') return 'exact';
      if (typeof value === type.type) return 'exact';
      return 'none';

    case 'object': {
      if (!(value instanceof SCObject)) return 'none';
      if (value.isa === type.className) return 'exact';
      if (isSubclass(value.isa, type.className)) return 'superclass';
      return 'none';
    }

    case 'union': {
      let best: MatchQuality = 'none';
      for (const subType of type.types) {
        const quality = matchType(value, subType);
        if (MATCH_QUALITY_RANK[quality] > MATCH_QUALITY_RANK[best]) {
          best = quality;
        }
        // Promote to 'union' quality at best (since we matched via a union)
        if (best !== 'none' && MATCH_QUALITY_RANK[best] > MATCH_QUALITY_RANK['union']) {
          best = 'union';
        }
      }
      return best === 'none' ? 'none' : 'union';
    }
  }
}

/**
 * Score a full argument list against a signature.
 * Returns total quality score (higher is better) or -1 if no match.
 */
export function scoreSignatureMatch(
  signature: SCMethodSignature,
  args: unknown[],
): number {
  // Check arity: required params must be satisfied
  const requiredCount = signature.parameters.filter(p => p.required).length;
  if (args.length < requiredCount) return -1;
  if (args.length > signature.arity) return -1;

  let totalScore = 0;

  for (let i = 0; i < signature.arity; i++) {
    const slot = signature.parameters[i];
    if (i >= args.length) {
      // Missing optional arg — ok if not required
      if (slot.required) return -1;
      continue;
    }

    const quality = matchType(args[i], slot.type);
    if (quality === 'none') return -1;

    totalScore += MATCH_QUALITY_RANK[quality];
  }

  return totalScore;
}

/**
 * Infer an SCTypeDescriptor from a runtime value.
 */
export function inferType(value: unknown): SCTypeDescriptor {
  if (value === null) return SCType.null();
  if (typeof value === 'string') return SCType.string();
  if (typeof value === 'number') return SCType.number();
  if (typeof value === 'boolean') return SCType.boolean();
  if (value instanceof SCObject) return SCType.object(value.isa);
  return SCType.any();
}
