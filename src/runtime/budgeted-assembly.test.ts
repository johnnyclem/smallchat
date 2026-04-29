/**
 * Feature: Token-budgeted assembly
 */

import { describe, it, expect } from 'vitest';
import {
  assembleWithinBudget,
  estimateTokens,
  scoreByQuery,
  type ToolDescriptor,
} from './budgeted-assembly.js';

function makeTool(
  id: string,
  description: string,
  extra: Partial<ToolDescriptor> = {},
): ToolDescriptor {
  return {
    id,
    name: id.split('.').pop() ?? id,
    providerId: id.split('.')[0] ?? 'p',
    description,
    inputSchema: { type: 'object' },
    ...extra,
  };
}

describe('Feature: assembleWithinBudget', () => {
  it('Given an empty list, When assembled, Then exhausted is "empty"', () => {
    const res = assembleWithinBudget([], 100);
    expect(res.included).toEqual([]);
    expect(res.excluded).toEqual([]);
    expect(res.totalTokens).toBe(0);
    expect(res.exhausted).toBe('empty');
  });

  it('Given budget exceeds the ranked list, When assembled, Then exhausted is "candidates"', () => {
    const tools = [makeTool('p.a', 'short'), makeTool('p.b', 'short')];
    const res = assembleWithinBudget(tools, 1_000_000);
    expect(res.included.length).toBe(2);
    expect(res.excluded.length).toBe(0);
    expect(res.exhausted).toBe('candidates');
  });

  it('Given the budget runs out mid-list, When assembled, Then exhausted is "budget" and excluded retains order', () => {
    const tools = [
      makeTool('p.a', 'one'),
      makeTool('p.b', 'two'),
      makeTool('p.c', 'three'),
      makeTool('p.d', 'four'),
    ];
    // Each tool is roughly the same size; pick a budget that fits ~2.
    const perTool = estimateTokens(tools[0]);
    const res = assembleWithinBudget(tools, perTool * 2);
    expect(res.included.length).toBe(2);
    expect(res.excluded.length).toBe(2);
    expect(res.included.map((t) => t.id)).toEqual(['p.a', 'p.b']);
    expect(res.excluded.map((t) => t.id)).toEqual(['p.c', 'p.d']);
    expect(res.exhausted).toBe('budget');
    expect(res.totalTokens).toBeLessThanOrEqual(perTool * 2);
  });

  it('Given an oversized item but smaller items after it, When assembled, Then the smaller items still fit', () => {
    const giant = makeTool(
      'p.giant',
      'x'.repeat(10_000),
    );
    const small1 = makeTool('p.small1', 'tiny');
    const small2 = makeTool('p.small2', 'tiny');
    const res = assembleWithinBudget([giant, small1, small2], 200);
    expect(res.included.map((t) => t.id)).toEqual(['p.small1', 'p.small2']);
    expect(res.excluded.map((t) => t.id)).toEqual(['p.giant']);
  });

  it('Given a custom estimator, When assembled, Then it is honoured', () => {
    const tools = [makeTool('p.a', 'a'), makeTool('p.b', 'b'), makeTool('p.c', 'c')];
    const res = assembleWithinBudget(tools, 5, () => 2);
    expect(res.included.length).toBe(2);
    expect(res.totalTokens).toBe(4);
  });
});

describe('Feature: scoreByQuery', () => {
  it('Given a query that matches one tool by name, When ranked, Then that tool is first', () => {
    const tools = [
      makeTool('loom.search', 'Search the indexed code'),
      makeTool('loom.delete', 'Delete a file from the workspace'),
      makeTool('loom.summarize', 'Summarize a document'),
    ];
    const ranked = scoreByQuery(tools, 'search code');
    expect(ranked[0].id).toBe('loom.search');
    expect((ranked[0].score ?? 0)).toBeGreaterThan(ranked[1].score ?? 0);
  });

  it('Given an empty query, When ranked, Then all scores are zero and order is preserved', () => {
    const tools = [makeTool('p.a', 'A'), makeTool('p.b', 'B')];
    const ranked = scoreByQuery(tools, '');
    expect(ranked.every((t) => t.score === 0)).toBe(true);
    expect(ranked.map((t) => t.id)).toEqual(['p.a', 'p.b']);
  });

  it('Given a query whose terms appear in no tool, When ranked, Then no tool gets a positive score', () => {
    const tools = [makeTool('p.a', 'foo bar'), makeTool('p.b', 'baz qux')];
    const ranked = scoreByQuery(tools, 'completely unrelated terms');
    expect(ranked.every((t) => (t.score ?? 0) === 0)).toBe(true);
  });

  it('Given scoreByQuery output, When passed to assembleWithinBudget, Then highest-scored tools are kept', () => {
    const tools = [
      makeTool('loom.indexer', 'Index a directory of source code'),
      makeTool('loom.search', 'Search the indexed code by symbol name'),
      makeTool('loom.notes', 'Take notes about something unrelated'),
    ];
    const ranked = scoreByQuery(tools, 'search symbol code');
    const perTool = estimateTokens(tools[0]);
    const res = assembleWithinBudget(ranked, perTool * 2);
    expect(res.included.map((t) => t.id)).toContain('loom.search');
  });
});
