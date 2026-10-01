/**
 * Conformance with spec/ranking/vectors.json (smallchat.rank.v1): score
 * quantization, candidate order and tiers that every suite implementation
 * (TypeScript, smallchat-swift) must reproduce.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareRanked, computeTier, quantizeScore } from './confidence.js';

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../spec/ranking/vectors.json', import.meta.url)), 'utf8'),
) as {
  quantize: Array<{ input: number; expected: number }>;
  rank: Array<{ name: string; candidates: Array<{ toolId: string; score: number }>; expected: string[] }>;
  tier: Array<{ score: number; expected: string }>;
};

describe('spec/ranking golden vectors', () => {
  it.each(vectors.quantize)('quantizeScore($input) = $expected', ({ input, expected }) => {
    expect(quantizeScore(input)).toBe(expected);
  });

  it.each(vectors.rank)('rank: $name', ({ candidates, expected }) => {
    expect([...candidates].sort(compareRanked).map(c => c.toolId)).toEqual(expected);
    expect([...candidates].reverse().sort(compareRanked).map(c => c.toolId)).toEqual(expected);
  });

  it.each(vectors.tier)('tier of $score is $expected', ({ score, expected }) => {
    expect(computeTier(quantizeScore(score))).toBe(expected);
  });
});
