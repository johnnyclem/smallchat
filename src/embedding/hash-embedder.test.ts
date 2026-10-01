import { describe, it, expect } from 'vitest';
import { HashEmbedder, LocalEmbedder, hashFingerprint } from './hash-embedder.js';
import { LocalEmbedder as ShimLocalEmbedder } from './local-embedder.js';
import { onnxFingerprint, ONNXEmbedder } from './onnx-embedder.js';

describe('HashEmbedder', () => {
  it('declares a hash fingerprint matching its dimensions', () => {
    const embedder = new HashEmbedder(64);
    expect(embedder.fingerprint).toEqual(hashFingerprint(64));
    expect(embedder.fingerprint).toMatchObject({ kind: 'hash', modelSha256: null, dims: 64, maxLength: null });
  });

  it('keeps LocalEmbedder as a deprecated alias (also from the 0.x module path)', async () => {
    expect(LocalEmbedder).toBe(HashEmbedder);
    expect(ShimLocalEmbedder).toBe(HashEmbedder);
    const a = await new LocalEmbedder(32).embed('read a file');
    const b = await new HashEmbedder(32).embed('read a file');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('is distinguishable from the ONNX embedder by fingerprint', () => {
    expect(new ONNXEmbedder({ modelPath: '/nonexistent.onnx' }).fingerprint).toEqual(onnxFingerprint(128));
    expect(onnxFingerprint()).not.toEqual(hashFingerprint(384));
  });
});
