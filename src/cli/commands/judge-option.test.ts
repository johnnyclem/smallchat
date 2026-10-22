import { describe, it, expect } from 'vitest';
import { judgeContextFromOptions, judgeFromSpec } from './judge-option.js';

describe('--judge', () => {
  it('names d1, jev or an endpoint; unset means none', () => {
    expect(judgeFromSpec(undefined, {})).toBeNull();
    expect(judgeFromSpec('d1', {})!.name).toBe('d1');
    expect(judgeFromSpec(undefined, { SMALLCHAT_JUDGE: 'd1' })!.name).toBe('d1');
    expect(judgeFromSpec('jev', { TYPESAFE_API_KEY: 'k' })!.name).toBe('jev');
    expect(() => judgeFromSpec('jev', {})).toThrow(/TYPESAFE_API_KEY/);
    const endpoint = judgeFromSpec('http://localhost:5000', { SMALLCHAT_JUDGE_MODEL: 'ranker' })!;
    expect({ name: endpoint.name, model: endpoint.model }).toEqual({ name: 'endpoint', model: 'ranker' });
    expect(() => judgeFromSpec('magic', {})).toThrow(/--judge takes/);
    expect(judgeFromSpec('none', {})).toBeNull();
  });

  it('--judge-context builds a stenographer reader with the token from the environment', () => {
    expect(judgeContextFromOptions({}, {})).toBeNull();
    const provider = judgeContextFromOptions({ judgeContext: 'http://127.0.0.1:8787' }, { STENOGRAPHER_REST_TOKEN: 't' })!;
    expect(provider.name).toBe('stenographer');
    expect(() => judgeContextFromOptions({ judgeContext: 'http://127.0.0.1:8787', judgeContextTokenFile: '/nonexistent/token' }, {})).toThrow(/token-file/);
  });
});
