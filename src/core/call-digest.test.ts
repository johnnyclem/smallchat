import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callDigest, CALL_DIGEST_DOMAIN } from './call-digest.js';
import { canonicalJson } from './jcs.js';
import { sha256Hex, domainDigest } from './sha256.js';

const VECTORS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spec', 'call-digest', 'vectors.json');

interface Vectors {
  domain: string;
  vectors: Array<{ name: string; toolId: string; arguments: Record<string, unknown>; jcs: string; digest: string }>;
  invalid: Array<{ name: string; toolId: string; arguments?: unknown; nonFinite?: { key: string; value: string } }>;
}

const golden = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8')) as Vectors;

describe('sha256Hex', () => {
  it('matches node:crypto on the FIPS test strings and on random inputs of every padding length', () => {
    const enc = new TextEncoder();
    expect(sha256Hex(enc.encode(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(enc.encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (let len = 0; len < 200; len++) {
      const bytes = new Uint8Array(randomBytes(len));
      expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('rejects separator and lone-surrogate content in domain digests', () => {
    expect(() => domainDigest('d', 'a\u0000b')).toThrow(/U\+0000/);
    expect(() => domainDigest('d', 'x\ud800')).toThrow(/surrogate/);
  });
});

describe('callDigest — golden vectors (spec/call-digest/vectors.json)', () => {
  it('uses the smallchat.call.v1 domain', () => {
    expect(golden.domain).toBe(CALL_DIGEST_DOMAIN);
  });

  for (const v of golden.vectors) {
    it(`reproduces JCS and digest: ${v.name}`, () => {
      expect(canonicalJson(v.arguments)).toBe(v.jcs);
      expect(callDigest(v.toolId, v.arguments)).toBe(v.digest);
    });
  }

  it('gives spellings of the same call one digest, and the same arguments on another tool another', () => {
    const [a, b, other] = ['same call, spelling A (whitespace, key order)', 'same call, spelling B (number spelling)', 'same arguments, different tool']
      .map(name => golden.vectors.find(v => v.name === name)!);
    expect(a.digest).toBe(b.digest);
    expect(other.digest).not.toBe(a.digest);
  });

  for (const v of golden.invalid) {
    it(`rejects: ${v.name}`, () => {
      const args = v.nonFinite
        ? { [v.nonFinite.key]: Number(v.nonFinite.value) }
        : v.arguments;
      expect(() => callDigest(v.toolId, args as Record<string, unknown>)).toThrow(TypeError);
    });
  }

  it('rejects values with no faithful JSON form', () => {
    expect(() => callDigest('p/t', { when: new Date(0) })).toThrow(/non-plain object/);
    expect(() => callDigest('p/t', { v: new Float32Array(1) })).toThrow(/typed array/);
    expect(() => callDigest('p/t', { n: 1n })).toThrow(/bigint/);
  });
});
