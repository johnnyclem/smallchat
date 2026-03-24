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

// ---------------------------------------------------------------------------
// Strict argument validation — prevents Type Confusion attacks
// ---------------------------------------------------------------------------

/**
 * A single type violation found during strict signature validation.
 */
export interface SignatureViolation {
  /** Parameter slot that was violated */
  parameterName: string;
  /** 0-based position */
  position: number;
  /** Human-readable description of the expected type */
  expected: string;
  /** Human-readable description of the received type */
  received: string;
  /** The kind of violation */
  kind: 'type_mismatch' | 'missing_required' | 'excess_argument' | 'isa_violation';
}

/**
 * Result of strict signature validation.
 */
export interface SignatureValidationResult {
  valid: boolean;
  violations: SignatureViolation[];
}

/**
 * Describe a type descriptor in human-readable form.
 */
function describeType(type: SCTypeDescriptor): string {
  switch (type.kind) {
    case 'primitive': return type.type;
    case 'object': return type.className;
    case 'union': return type.types.map(describeType).join(' | ');
    case 'any': return 'any';
  }
}

/**
 * Describe the runtime type of a value in human-readable form.
 */
function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof SCObject) return value.isa;
  return typeof value;
}

/**
 * Strictly validate an argument list against a method signature.
 *
 * Unlike `scoreSignatureMatch` (which returns a score for ranking overloads),
 * this function produces detailed violation reports suitable for blocking
 * dispatch and informing the caller exactly what went wrong.
 *
 * This is the core defence against "Type Confusion" attacks where an LLM
 * suggests arguments of the wrong type to trick an IMP into operating on
 * data it wasn't designed for.
 */
export function validateArgumentTypes(
  signature: SCMethodSignature,
  args: unknown[],
): SignatureValidationResult {
  const violations: SignatureViolation[] = [];

  // Check for excess arguments beyond the signature's arity
  if (args.length > signature.arity) {
    for (let i = signature.arity; i < args.length; i++) {
      violations.push({
        parameterName: `arg[${i}]`,
        position: i,
        expected: '(no parameter)',
        received: describeValueType(args[i]),
        kind: 'excess_argument',
      });
    }
  }

  for (let i = 0; i < signature.arity; i++) {
    const slot = signature.parameters[i];

    // Missing required argument
    if (i >= args.length || args[i] === undefined) {
      if (slot.required && slot.defaultValue === undefined) {
        violations.push({
          parameterName: slot.name,
          position: i,
          expected: describeType(slot.type),
          received: 'undefined',
          kind: 'missing_required',
        });
      }
      continue;
    }

    const value = args[i];
    const quality = matchType(value, slot.type);

    if (quality === 'none') {
      // Determine if this is specifically an isa hierarchy violation
      const isIsaViolation =
        slot.type.kind === 'object' && value instanceof SCObject;

      violations.push({
        parameterName: slot.name,
        position: i,
        expected: describeType(slot.type),
        received: describeValueType(value),
        kind: isIsaViolation ? 'isa_violation' : 'type_mismatch',
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Strictly validate named arguments against a method signature.
 *
 * Converts named args to positional form and validates, also checking
 * for unknown argument names that don't map to any parameter slot.
 */
export function validateNamedArgumentTypes(
  signature: SCMethodSignature,
  namedArgs: Record<string, unknown>,
): SignatureValidationResult {
  const violations: SignatureViolation[] = [];
  const knownNames = new Set(signature.parameters.map(p => p.name));

  // Check for unknown argument names (potential injection/confusion vector)
  for (const name of Object.keys(namedArgs)) {
    if (!knownNames.has(name)) {
      violations.push({
        parameterName: name,
        position: -1,
        expected: '(not a parameter)',
        received: describeValueType(namedArgs[name]),
        kind: 'excess_argument',
      });
    }
  }

  // Build positional array and validate types
  const positional: unknown[] = new Array(signature.arity);
  for (const slot of signature.parameters) {
    if (slot.name in namedArgs) {
      positional[slot.position] = namedArgs[slot.name];
    } else if (slot.defaultValue !== undefined) {
      positional[slot.position] = slot.defaultValue;
    }
    // else: leave undefined — validateArgumentTypes will catch missing required
  }

  const positionalResult = validateArgumentTypes(signature, positional);
  violations.push(...positionalResult.violations);

  return {
    valid: violations.length === 0,
    violations,
  };
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
