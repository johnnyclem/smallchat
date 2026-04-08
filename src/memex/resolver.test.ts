import { describe, it, expect } from 'vitest';
import { computeTier, DEFAULT_KNOWLEDGE_THRESHOLDS } from './resolver.js';

describe('computeTier', () => {
  const thresholds = DEFAULT_KNOWLEDGE_THRESHOLDS;

  it('returns EXACT for scores >= 0.95', () => {
    expect(computeTier(0.95, thresholds)).toBe('EXACT');
    expect(computeTier(1.0, thresholds)).toBe('EXACT');
  });

  it('returns HIGH for scores >= 0.85 and < 0.95', () => {
    expect(computeTier(0.85, thresholds)).toBe('HIGH');
    expect(computeTier(0.90, thresholds)).toBe('HIGH');
  });

  it('returns MEDIUM for scores >= 0.70 and < 0.85', () => {
    expect(computeTier(0.70, thresholds)).toBe('MEDIUM');
    expect(computeTier(0.80, thresholds)).toBe('MEDIUM');
  });

  it('returns LOW for scores >= 0.50 and < 0.70', () => {
    expect(computeTier(0.50, thresholds)).toBe('LOW');
    expect(computeTier(0.65, thresholds)).toBe('LOW');
  });

  it('returns NONE for scores < 0.50', () => {
    expect(computeTier(0.0, thresholds)).toBe('NONE');
    expect(computeTier(0.49, thresholds)).toBe('NONE');
  });

  it('works with custom thresholds', () => {
    const custom = { exact: 0.99, high: 0.90, medium: 0.75, low: 0.60 };
    expect(computeTier(0.95, custom)).toBe('HIGH'); // below custom exact
    expect(computeTier(0.99, custom)).toBe('EXACT');
  });
});
