import { describe, it, expect } from 'vitest';
import { safeJsonParse, PrototypePollutionError } from './safe-json.js';

describe('safeJsonParse', () => {
  it('round-trips ordinary JSON unchanged', () => {
    const json = JSON.stringify({ a: 1, b: [2, 3], c: { d: 'four' } });
    expect(safeJsonParse(json)).toEqual({ a: 1, b: [2, 3], c: { d: 'four' } });
  });

  it('throws by default when the root carries __proto__', () => {
    const json = '{"__proto__": {"polluted": true}, "ok": 1}';
    expect(() => safeJsonParse(json)).toThrow(PrototypePollutionError);
  });

  it('throws on a nested __proto__', () => {
    const json = '{"a": {"b": {"__proto__": {"polluted": true}}}}';
    expect(() => safeJsonParse(json)).toThrow(PrototypePollutionError);
  });

  it('throws on a __proto__ inside an array element', () => {
    const json = '{"items": [{"__proto__": {"polluted": true}}]}';
    expect(() => safeJsonParse(json)).toThrow(PrototypePollutionError);
  });

  it('throws on constructor and prototype keys too', () => {
    expect(() => safeJsonParse('{"constructor": 1}')).toThrow(PrototypePollutionError);
    expect(() => safeJsonParse('{"prototype": 1}')).toThrow(PrototypePollutionError);
  });

  it('reports the offending path in the error', () => {
    try {
      safeJsonParse('{"deep": {"path": {"__proto__": 1}}}');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PrototypePollutionError);
      expect((err as PrototypePollutionError).key).toBe('__proto__');
      expect((err as PrototypePollutionError).path).toBe('deep.path');
    }
  });

  it('strips forbidden keys silently in strip mode', () => {
    const json = '{"__proto__": {"x": 1}, "ok": "yes"}';
    const result = safeJsonParse(json, { onPollution: 'strip' }) as Record<string, unknown>;
    expect(result).toEqual({ ok: 'yes' });
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
  });

  it('strips nested forbidden keys without losing siblings', () => {
    const json = '{"a": {"constructor": "bad", "good": 1}, "b": 2}';
    const result = safeJsonParse(json, { onPollution: 'strip' }) as { a: { good: number }; b: number };
    expect(result).toEqual({ a: { good: 1 }, b: 2 });
  });

  it('does not pollute Object.prototype regardless of mode', () => {
    const probeBefore = ({} as Record<string, unknown>).polluted;
    try { safeJsonParse('{"__proto__": {"polluted": true}}'); } catch { /* expected */ }
    safeJsonParse('{"__proto__": {"polluted": true}}', { onPollution: 'strip' });
    expect(({} as Record<string, unknown>).polluted).toBe(probeBefore);
  });

  it('forwards the reviver to JSON.parse', () => {
    const result = safeJsonParse('{"a": 1, "b": 2}', {
      reviver: (key, value) => (typeof value === 'number' ? value * 10 : value),
    });
    expect(result).toEqual({ a: 10, b: 20 });
  });
});
