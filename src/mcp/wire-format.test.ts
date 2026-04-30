/**
 * Feature: Compact wire format
 *
 * Lossless encode/decode plus auto-negotiation that picks the compact form
 * only when it saves at least `MIN_SAVINGS_RATIO` bytes.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeValue,
  decodeValue,
  wrap,
  unwrap,
  negotiate,
  parseFormatParam,
  MIN_SAVINGS_RATIO,
  type Json,
} from './wire-format.js';

describe('Feature: Wire-format encode/decode roundtrip', () => {
  const cases: Array<[string, Json]> = [
    ['primitive null', null],
    ['primitive number', 42],
    ['primitive string', 'hello'],
    ['empty array', []],
    ['empty object', {}],
    ['heterogeneous array', [1, 'two', { three: 3 }]],
    ['single-element array of objects (not packed)', [{ a: 1 }]],
    [
      'array of homogeneous objects (packed)',
      [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
        { id: 'c', name: 'Gamma' },
      ],
    ],
    [
      'array of objects with differing keys (not packed)',
      [
        { id: 'a', name: 'Alpha' },
        { id: 'b', label: 'Beta' },
      ],
    ],
    [
      'nested packable arrays',
      {
        outer: [
          { id: 'x', children: [{ k: 1 }, { k: 2 }] },
          { id: 'y', children: [{ k: 3 }, { k: 4 }] },
        ],
      },
    ],
    [
      'tools/list-shaped payload',
      {
        tools: [
          { id: 't1', providerId: 'p', description: 'desc1', transportType: 'mcp' },
          { id: 't2', providerId: 'p', description: 'desc2', transportType: 'mcp' },
          { id: 't3', providerId: 'p', description: 'desc3', transportType: 'mcp' },
        ],
        nextCursor: null,
        snapshot: '0',
      },
    ],
  ];

  for (const [label, input] of cases) {
    it(`Given ${label}, When encoded and then decoded, Then the result deep-equals the original`, () => {
      const decoded = decodeValue(encodeValue(input));
      expect(decoded).toEqual(input);
    });
  }

  it('Given a packed value, When wrapped and unwrapped, Then the original is recovered', () => {
    const original = {
      tools: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
    };
    const wrapped = wrap(encodeValue(original));
    expect(unwrap(wrapped)).toEqual(original);
  });

  it('Given an unwrapped JSON value, When unwrap is called, Then it passes through unchanged', () => {
    const value = { hello: 'world', xs: [1, 2, 3] };
    expect(unwrap(value)).toEqual(value);
  });

  it('Given an envelope with an unsupported version, When unwrap is called, Then it throws', () => {
    const bogus = { __sc_wire: 999, data: null } as Json;
    expect(() => unwrap(bogus)).toThrow(/wire envelope/);
  });
});

describe('Feature: Negotiation thresholds', () => {
  it('Given format="json", When negotiated, Then the payload is the original value', () => {
    const value = { tools: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    const res = negotiate('json', value);
    expect(res.format).toBe('json');
    expect(res.payload).toEqual(value);
    expect(res.savingsRatio).toBe(0);
  });

  it('Given format="compact", When negotiated, Then a wrapped envelope is returned', () => {
    const value = { tools: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    const res = negotiate('compact', value);
    expect(res.format).toBe('compact');
    expect(unwrap(res.payload)).toEqual(value);
  });

  it('Given format="auto" and a tools/list-shaped payload, When negotiated, Then compact is chosen', () => {
    const value = {
      tools: Array.from({ length: 10 }, (_, i) => ({
        id: `tool-${i}`,
        providerId: 'loom',
        description: `Tool number ${i} with a reasonably long description`,
        transportType: 'mcp',
      })),
    };
    const res = negotiate('auto', value);
    expect(res.format).toBe('compact');
    expect(res.savingsRatio).toBeGreaterThan(MIN_SAVINGS_RATIO);
    expect(unwrap(res.payload)).toEqual(value);
  });

  it('Given format="auto" and a small payload, When negotiated, Then JSON is chosen', () => {
    const value = { ok: true };
    const res = negotiate('auto', value);
    expect(res.format).toBe('json');
    expect(res.savingsRatio).toBeLessThan(MIN_SAVINGS_RATIO);
  });

  it('Given a heterogeneous array, When negotiated as auto, Then JSON is chosen because no packing happens', () => {
    const value = { items: [{ a: 1 }, { b: 2 }, { c: 3 }] };
    const res = negotiate('auto', value);
    expect(res.format).toBe('json');
  });
});

describe('Feature: parseFormatParam', () => {
  it('Given a known format string, When parsed, Then it is returned', () => {
    expect(parseFormatParam({ format: 'auto' })).toBe('auto');
    expect(parseFormatParam({ format: 'compact' })).toBe('compact');
    expect(parseFormatParam({ format: 'json' })).toBe('json');
  });

  it('Given an absent or unknown format, When parsed, Then "json" is returned', () => {
    expect(parseFormatParam({})).toBe('json');
    expect(parseFormatParam({ format: 'XML' })).toBe('json');
    expect(parseFormatParam({ format: 42 })).toBe('json');
  });
});
