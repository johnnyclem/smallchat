import { describe, it, expect } from 'vitest';
import {
  computeTier,
  requiresVerification,
  requiresDecomposition,
  requiresRefinement,
  DEFAULT_THRESHOLDS,
} from './confidence';

// ---------------------------------------------------------------------------
// computeTier — default thresholds
// ---------------------------------------------------------------------------

describe('computeTier with default thresholds', () => {
  it('returns "exact" for confidence >= 0.95', () => {
    expect(computeTier(1.0)).toBe('exact');
    expect(computeTier(0.99)).toBe('exact');
    expect(computeTier(0.95)).toBe('exact');
  });

  it('returns "high" for confidence >= 0.85 and < 0.95', () => {
    expect(computeTier(0.94)).toBe('high');
    expect(computeTier(0.90)).toBe('high');
    expect(computeTier(0.85)).toBe('high');
  });

  it('returns "medium" for confidence >= 0.75 and < 0.85', () => {
    expect(computeTier(0.84)).toBe('medium');
    expect(computeTier(0.80)).toBe('medium');
    expect(computeTier(0.75)).toBe('medium');
  });

  it('returns "low" for confidence >= 0.60 and < 0.75', () => {
    expect(computeTier(0.74)).toBe('low');
    expect(computeTier(0.65)).toBe('low');
    expect(computeTier(0.60)).toBe('low');
  });

  it('returns "none" for confidence < 0.60', () => {
    expect(computeTier(0.59)).toBe('none');
    expect(computeTier(0.30)).toBe('none');
    expect(computeTier(0.0)).toBe('none');
  });

  it('handles edge values at exact boundaries', () => {
    // At each threshold boundary the value belongs to the higher tier
    expect(computeTier(0.95)).toBe('exact');
    expect(computeTier(0.85)).toBe('high');
    expect(computeTier(0.75)).toBe('medium');
    expect(computeTier(0.60)).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// computeTier — custom thresholds
// ---------------------------------------------------------------------------

describe('computeTier with custom thresholds', () => {
  const custom = { exact: 0.99, high: 0.90, medium: 0.70, low: 0.50 };

  it('uses custom thresholds for "exact"', () => {
    expect(computeTier(0.99, custom)).toBe('exact');
    expect(computeTier(0.98, custom)).toBe('high');
  });

  it('uses custom thresholds for "high"', () => {
    expect(computeTier(0.90, custom)).toBe('high');
    expect(computeTier(0.89, custom)).toBe('medium');
  });

  it('uses custom thresholds for "medium"', () => {
    expect(computeTier(0.70, custom)).toBe('medium');
    expect(computeTier(0.69, custom)).toBe('low');
  });

  it('uses custom thresholds for "low"', () => {
    expect(computeTier(0.50, custom)).toBe('low');
    expect(computeTier(0.49, custom)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_THRESHOLDS
// ---------------------------------------------------------------------------

describe('DEFAULT_THRESHOLDS', () => {
  it('has the documented default values', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      exact: 0.95,
      high: 0.85,
      medium: 0.75,
      low: 0.60,
    });
  });

  it('is frozen / read-only', () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requiresVerification / requiresDecomposition / requiresRefinement
// ---------------------------------------------------------------------------

describe('requiresVerification', () => {
  it('returns true only for "medium"', () => {
    expect(requiresVerification('medium')).toBe(true);
  });

  it.each(['exact', 'high', 'low', 'none'] as const)(
    'returns false for "%s"',
    (tier) => {
      expect(requiresVerification(tier)).toBe(false);
    },
  );
});

describe('requiresDecomposition', () => {
  it('returns true only for "low"', () => {
    expect(requiresDecomposition('low')).toBe(true);
  });

  it.each(['exact', 'high', 'medium', 'none'] as const)(
    'returns false for "%s"',
    (tier) => {
      expect(requiresDecomposition(tier)).toBe(false);
    },
  );
});

describe('requiresRefinement', () => {
  it('returns true only for "none"', () => {
    expect(requiresRefinement('none')).toBe(true);
  });

  it.each(['exact', 'high', 'medium', 'low'] as const)(
    'returns false for "%s"',
    (tier) => {
      expect(requiresRefinement(tier)).toBe(false);
    },
  );
});
