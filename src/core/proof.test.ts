import { describe, it, expect } from 'vitest';
import { createProof, addProofStep, finalizeProof, computeProofDigest, PROOF_DIGEST_DOMAIN } from './proof.js';
import { DEFAULT_THRESHOLDS } from './confidence.js';
import { canonicalJson } from './jcs.js';
import { domainDigest } from './sha256.js';

describe('createProof', () => {
  it('starts unresolved, with nothing chosen or run, and default thresholds and guards', () => {
    const proof = createProof('book a flight');
    expect(proof).toMatchObject({
      version: 1,
      intent: 'book a flight',
      outcome: 'unresolved',
      tier: 'none',
      chosen: null,
      ran: null,
      callDigest: null,
      candidates: [],
      steps: [],
      thresholds: DEFAULT_THRESHOLDS,
      guards: { requireLLMForSubHighDispatch: true, strict: false },
      embedder: null,
      artifactHash: null,
    });
  });
});

describe('addProofStep', () => {
  it('appends steps in order and keeps their timings outside the steps', () => {
    const proof = createProof('multi');
    addProofStep(proof, { stage: 'cache', decision: 'miss' }, 1);
    addProofStep(proof, { stage: 'verification', decision: 'pass', detail: { toolId: 'p/t' } }, 2);

    expect(proof.steps).toEqual([
      { stage: 'cache', decision: 'miss' },
      { stage: 'verification', decision: 'pass', detail: { toolId: 'p/t' } },
    ]);
    expect(proof.timings).toEqual({ totalMs: 3, stepsMs: [1, 2] });
  });
});

describe('proofDigest', () => {
  it('is the domain-separated sha256 of the canonical proof without timings', () => {
    const proof = createProof('x');
    addProofStep(proof, { stage: 'cache', decision: 'miss' }, 7);
    finalizeProof(proof);

    const { timings: _t, proofDigest: _d, ...body } = proof;
    expect(proof.proofDigest).toBe(domainDigest(PROOF_DIGEST_DOMAIN, canonicalJson(body)));
    expect(proof.proofDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not change with timings, and changes with any decision content', () => {
    const a = createProof('x');
    addProofStep(a, { stage: 'cache', decision: 'miss' }, 1);
    const b = createProof('x');
    addProofStep(b, { stage: 'cache', decision: 'miss' }, 999);
    expect(computeProofDigest(a)).toBe(computeProofDigest(b));

    b.ran = 'p/t';
    expect(computeProofDigest(b)).not.toBe(computeProofDigest(a));
  });
});
