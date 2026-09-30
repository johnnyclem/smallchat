import { describe, it, expect } from 'vitest';
import { canonicalJson } from './jcs.js';

describe('canonicalJson (RFC 8785)', () => {
  it('serializes the RFC 8785 §3.2.2 example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      '"literals":[null,true,false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
      '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
      '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
    );
    // Compare the string: re-parsing would move the integer-like key "1" first.
    const order = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'];
    const expected = `{${order.map(k => `${JSON.stringify(k)}:${JSON.stringify(input[k])}`).join(',')}}`;
    expect(canonicalJson(input)).toBe(expected);
  });

  it('writes nested structures without whitespace and drops undefined properties', () => {
    expect(canonicalJson({ b: [1, { d: 2, c: 'x' }], a: undefined, e: -0 })).toBe('{"b":[1,{"c":"x","d":2}],"e":0}');
  });

  it('rejects values JSON cannot represent exactly', () => {
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson([Infinity])).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: 1n })).toThrow(/bigint/);
    expect(() => canonicalJson([undefined])).toThrow(/undefined/);
    expect(() => canonicalJson(new Float32Array(2))).toThrow(/typed array/);
  });
});
