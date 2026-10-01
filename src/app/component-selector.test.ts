/**
 * Feature: resolving UI intents never pollutes the component index (SC-SURF-30).
 */

import { describe, it, expect } from 'vitest';
import { ComponentSelectorTable } from './component-selector.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { Embedder } from '../core/types.js';

function scriptedEmbedder(vectors: Record<string, number[]>): Embedder {
  const embed = async (text: string) => Float32Array.from(vectors[text] ?? [0, 0, 1]);
  return { dimensions: 3, embed, embedBatch: async (texts: string[]) => Promise.all(texts.map(embed)) };
}

function unit(v: number[]): number[] {
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

describe('ComponentSelectorTable.resolve', () => {
  it('does not intern intents that match no component', async () => {
    const table = new ComponentSelectorTable(new MemoryVectorIndex(), scriptedEmbedder({
      'plot some numbers': unit([0.6, 0.8, 0]),
    }), 0.95);
    await table.intern(Float32Array.from([1, 0, 0]), 'bar:chart');

    const selector = await table.resolve('plot some numbers');

    expect(selector.canonical).toBe('plot:some:numbers');
    expect(table.size).toBe(1);
    expect(table.get('plot:some:numbers')).toBeUndefined();
  });

  it('keeps resolving to the component after many nearby intents', async () => {
    // Each intent sits just below the dedup threshold from the component
    // but closer to the next query than the component is.
    const component = [1, 0, 0];
    const vectors: Record<string, number[]> = {
      'show figures': unit([0.94, 0.34, 0]),
      'show figures please': unit([0.951, 0.309, 0]),
    };
    const table = new ComponentSelectorTable(new MemoryVectorIndex(), scriptedEmbedder(vectors), 0.95);
    await table.intern(Float32Array.from(component), 'bar:chart');

    await table.resolve('show figures');
    const later = await table.resolve('show figures please');

    expect(later.canonical).toBe('bar:chart');
    expect(table.size).toBe(1);
  });
});
