import { describe, it, expect } from 'vitest';
import { evaluateDispatchPolicy, isDestructive } from './policy.js';
import type { DispatchPolicyOptions, PolicyInput } from './policy.js';
import { DEFAULT_THRESHOLDS } from '../core/confidence.js';

const options: DispatchPolicyOptions = {
  thresholds: { ...DEFAULT_THRESHOLDS },
  requireLLMForSubHighDispatch: true,
  treatUnannotatedAsDestructive: false,
};

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    mode: 'intent',
    toolId: 'p/t',
    imp: { annotations: undefined },
    source: 'vector',
    score: 0.9,
    similarity: 0.9,
    llmApproved: false,
    pins: [],
    ...overrides,
  };
}

describe('isDestructive', () => {
  it('follows the MCP annotation semantics', () => {
    expect(isDestructive({ readOnlyHint: true, destructiveHint: true }, options)).toBe(false);
    expect(isDestructive({ destructiveHint: true }, options)).toBe(true);
    expect(isDestructive({ readOnlyHint: false, destructiveHint: false }, options)).toBe(false);
    expect(isDestructive({ readOnlyHint: false }, options)).toBe(true);
    expect(isDestructive(undefined, options)).toBe(false);
    expect(isDestructive({}, { treatUnannotatedAsDestructive: true })).toBe(true);
  });
});

describe('evaluateDispatchPolicy', () => {
  it('always allows a dispatch by exact id', () => {
    const v = evaluateDispatchPolicy(input({ mode: 'id', imp: { annotations: { destructiveHint: true } }, score: 1, similarity: null }), options);
    expect(v).toMatchObject({ allow: true, code: 'allow' });
  });

  it('allows HIGH and EXACT ordinary tools', () => {
    expect(evaluateDispatchPolicy(input({ score: 0.86 }), options).allow).toBe(true);
    expect(evaluateDispatchPolicy(input({ score: 0.99 }), options).allow).toBe(true);
  });

  it('requires LLM approval below HIGH unless the guard is off', () => {
    expect(evaluateDispatchPolicy(input({ score: 0.8 }), options).code).toBe('needs-llm-verifier');
    expect(evaluateDispatchPolicy(input({ score: 0.65 }), options).code).toBe('needs-llm-verifier');
    expect(evaluateDispatchPolicy(input({ score: 0.65, llmApproved: true }), options).allow).toBe(true);
    expect(evaluateDispatchPolicy(input({ score: 0.65 }), { ...options, requireLLMForSubHighDispatch: false }).allow).toBe(true);
  });

  it('never allows a score below LOW', () => {
    const v = evaluateDispatchPolicy(input({ score: 0.5, llmApproved: true }), { ...options, requireLLMForSubHighDispatch: false });
    expect(v.code).toBe('below-threshold');
  });

  it('requires EXACT own-embedding similarity or a pinned phrase for destructive tools', () => {
    const destructive = { annotations: { destructiveHint: true } };
    expect(evaluateDispatchPolicy(input({ imp: destructive, score: 0.9, similarity: 0.9, llmApproved: true }), options).code).toBe('destructive-needs-exact');
    expect(evaluateDispatchPolicy(input({ imp: destructive, score: 0.98, similarity: null, source: 'cache' }), options).code).toBe('destructive-needs-exact');
    expect(evaluateDispatchPolicy(input({ imp: destructive, score: 0.98, similarity: 0.9, source: 'semantic-map-similar' }), options).code).toBe('destructive-needs-exact');
    expect(evaluateDispatchPolicy(input({ imp: destructive, score: 0.97, similarity: 0.97 }), options).allow).toBe(true);
    expect(evaluateDispatchPolicy(input({ imp: destructive, score: 1, similarity: null, source: 'pin' }), options).allow).toBe(true);
  });

  it('refuses a tool whose pin the intent does not satisfy, before any other rule', () => {
    const exact = evaluateDispatchPolicy(input({ score: 1, pins: [{ canonical: 'p.t', policy: 'exact', satisfied: false }] }), options);
    expect(exact.code).toBe('pin-exact-required');
    const elevated = evaluateDispatchPolicy(
      input({ score: 1, pins: [{ canonical: 'p.t', policy: 'elevated', satisfied: false, similarity: 0.96, requiredThreshold: 0.98 }] }),
      options,
    );
    expect(elevated.code).toBe('pin-elevated-required');
    expect(elevated.reason).toContain('0.960');
  });
});
