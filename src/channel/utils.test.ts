import { describe, it, expect } from 'vitest';
import {
  filterMetaKeys,
  isValidMetaKey,
  parsePermissionReply,
  isValidPermissionId,
  validatePayloadSize,
  serializeChannelTag,
} from './utils.js';

// ---------------------------------------------------------------------------
// Meta key filtering
// ---------------------------------------------------------------------------

describe('filterMetaKeys', () => {
  it('passes through valid keys', () => {
    const result = filterMetaKeys({ sender: 'alice', room_id: '123', count: '5' });
    expect(result).toEqual({ sender: 'alice', room_id: '123', count: '5' });
  });

  it('drops keys with invalid characters', () => {
    const result = filterMetaKeys({
      'valid_key': 'ok',
      'invalid-key': 'dropped',
      'also.invalid': 'dropped',
      'has spaces': 'dropped',
      'ok123': 'kept',
    });
    expect(result).toEqual({ valid_key: 'ok', ok123: 'kept' });
  });

  it('drops prototype pollution keys', () => {
    const result = filterMetaKeys({
      '__proto__': 'evil',
      'constructor': 'evil',
      'prototype': 'evil',
      'safe': 'ok',
    });
    expect(result).toEqual({ safe: 'ok' });
  });

  it('converts non-string values to strings', () => {
    const result = filterMetaKeys({ count: 42 as unknown, flag: true as unknown });
    expect(result).toEqual({ count: '42', flag: 'true' });
  });

  it('drops null/undefined values', () => {
    const result = filterMetaKeys({ key: null as unknown, other: undefined as unknown, ok: 'yes' });
    expect(result).toEqual({ ok: 'yes' });
  });

  it('returns undefined for null/undefined input', () => {
    expect(filterMetaKeys(null)).toBeUndefined();
    expect(filterMetaKeys(undefined)).toBeUndefined();
  });

  it('returns undefined for empty object', () => {
    expect(filterMetaKeys({})).toBeUndefined();
  });

  it('returns undefined when all keys are invalid', () => {
    expect(filterMetaKeys({ 'bad-key': 'val', 'also.bad': 'val' })).toBeUndefined();
  });
});

describe('isValidMetaKey', () => {
  it('accepts valid keys', () => {
    expect(isValidMetaKey('sender')).toBe(true);
    expect(isValidMetaKey('room_id')).toBe(true);
    expect(isValidMetaKey('ABC123')).toBe(true);
    expect(isValidMetaKey('_private')).toBe(true);
  });

  it('rejects invalid keys', () => {
    expect(isValidMetaKey('has-dash')).toBe(false);
    expect(isValidMetaKey('has.dot')).toBe(false);
    expect(isValidMetaKey('has space')).toBe(false);
    expect(isValidMetaKey('')).toBe(false);
    expect(isValidMetaKey('__proto__')).toBe(false);
    expect(isValidMetaKey('constructor')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Permission reply parsing
// ---------------------------------------------------------------------------

describe('parsePermissionReply', () => {
  it('parses "yes <id>" correctly', () => {
    const result = parsePermissionReply('yes abcde');
    expect(result).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('parses "no <id>" correctly', () => {
    const result = parsePermissionReply('no fghij');
    expect(result).toEqual({ requestId: 'fghij', behavior: 'deny' });
  });

  it('is case-insensitive for the verdict', () => {
    expect(parsePermissionReply('YES abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' });
    expect(parsePermissionReply('No abcde')).toEqual({ requestId: 'abcde', behavior: 'deny' });
  });

  it('normalizes request ID to lowercase', () => {
    const result = parsePermissionReply('yes ABCDE');
    expect(result).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('trims whitespace', () => {
    const result = parsePermissionReply('  yes abcde  ');
    expect(result).toEqual({ requestId: 'abcde', behavior: 'allow' });
  });

  it('rejects IDs containing "l" (excluded letter)', () => {
    expect(parsePermissionReply('yes abcle')).toBeNull();
    expect(parsePermissionReply('yes lllll')).toBeNull();
  });

  it('rejects IDs with wrong length', () => {
    expect(parsePermissionReply('yes abcd')).toBeNull();   // 4 chars
    expect(parsePermissionReply('yes abcdef')).toBeNull();  // 6 chars
  });

  it('rejects IDs with digits', () => {
    expect(parsePermissionReply('yes abc12')).toBeNull();
  });

  it('rejects invalid formats', () => {
    expect(parsePermissionReply('maybe abcde')).toBeNull();
    expect(parsePermissionReply('yes')).toBeNull();
    expect(parsePermissionReply('')).toBeNull();
    expect(parsePermissionReply(null as unknown as string)).toBeNull();
  });
});

describe('isValidPermissionId', () => {
  it('accepts valid IDs', () => {
    expect(isValidPermissionId('abcde')).toBe(true);
    expect(isValidPermissionId('mnopq')).toBe(true);
    expect(isValidPermissionId('zzzzz')).toBe(true);
  });

  it('rejects IDs with "l"', () => {
    expect(isValidPermissionId('abcle')).toBe(false);
  });

  it('rejects wrong-length IDs', () => {
    expect(isValidPermissionId('abcd')).toBe(false);
    expect(isValidPermissionId('abcdef')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Payload size validation
// ---------------------------------------------------------------------------

describe('validatePayloadSize', () => {
  it('accepts payloads within limit', () => {
    const result = validatePayloadSize('hello', 100);
    expect(result.valid).toBe(true);
    expect(result.size).toBe(5);
  });

  it('rejects payloads over limit', () => {
    const result = validatePayloadSize('a'.repeat(200), 100);
    expect(result.valid).toBe(false);
    expect(result.size).toBe(200);
    expect(result.limit).toBe(100);
  });

  it('uses default 64KB limit', () => {
    const result = validatePayloadSize('hello');
    expect(result.valid).toBe(true);
    expect(result.limit).toBe(65536);
  });
});

// ---------------------------------------------------------------------------
// Channel tag serialization
// ---------------------------------------------------------------------------

describe('serializeChannelTag', () => {
  it('serializes basic channel tag', () => {
    const tag = serializeChannelTag('slack', 'Hello world');
    expect(tag).toBe('<channel source="slack">\nHello world\n</channel>');
  });

  it('includes meta attributes', () => {
    const tag = serializeChannelTag('slack', 'Hi', { sender: 'alice', room: 'general' });
    expect(tag).toContain('source="slack"');
    expect(tag).toContain('sender="alice"');
    expect(tag).toContain('room="general"');
    expect(tag).toContain('Hi');
  });

  it('escapes XML special characters in attributes', () => {
    const tag = serializeChannelTag('test', 'content', { key: 'value "with" quotes' });
    expect(tag).toContain('key="value &quot;with&quot; quotes"');
  });

  it('filters invalid meta keys', () => {
    const tag = serializeChannelTag('test', 'content', { valid: 'ok', 'bad-key': 'dropped' });
    expect(tag).toContain('valid="ok"');
    expect(tag).not.toContain('bad-key');
  });
});
