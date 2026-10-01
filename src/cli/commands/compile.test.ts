/**
 * Feature: compile chooses the same embedder as every other surface
 *
 * SC-SURF-06: `-e/--embedder` used to default to 'onnx' in commander, so the
 * smallchat.json `compiler.embedder` fallback was dead code. The flag now
 * has no default; the shared DEFAULT_EMBEDDER_KIND applies only when neither
 * the flag nor smallchat.json names an embedder.
 */

import { describe, it, expect } from 'vitest';
import { compileCommand } from './compile.js';
import { DEFAULT_EMBEDDER_KIND, parseEmbedderKind } from '../../artifact/embedder.js';

describe('Feature: compile embedder selection', () => {
  it('leaves --embedder unset by default so smallchat.json compiler.embedder can apply', () => {
    const option = compileCommand.options.find(o => o.long === '--embedder');
    expect(option).toBeDefined();
    expect(option!.defaultValue).toBeUndefined();
  });

  it('offers --allow-duplicates', () => {
    expect(compileCommand.options.some(o => o.long === '--allow-duplicates')).toBe(true);
  });

  it('resolves embedder names to the built-in kinds', () => {
    expect(parseEmbedderKind(undefined)).toBe(DEFAULT_EMBEDDER_KIND);
    expect(parseEmbedderKind('onnx')).toBe('onnx');
    expect(parseEmbedderKind('hash')).toBe('hash');
    expect(parseEmbedderKind('local')).toBe('hash');
    expect(() => parseEmbedderKind('openai')).toThrow(/Unknown embedder/);
  });
});
