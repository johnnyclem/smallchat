import { describe, it, expect, vi } from 'vitest';
import { refine, buildRefinementResult } from './refinement.js';
import type { LLMClient, ToolSummary } from '../core/llm-client.js';
import type { SelectorMatch, ToolRefinementNeeded } from '../core/types.js';

const tools: ToolSummary[] = [
  { name: 'github.search_code', description: 'Search code on GitHub' },
  { name: 'github.list_repos', description: 'List repositories' },
  { name: 'jira.create_issue', description: 'Create a Jira issue' },
];

describe('refine', () => {
  it('LLM-powered refinement returns options from LLM', async () => {
    const llm: LLMClient = {
      refine: vi.fn().mockResolvedValue({
        question: 'Which tool did you mean?',
        options: [
          { label: 'Search Code', intent: 'search code', confidence: 0.8 },
          { label: 'List Repos', intent: 'list repos', confidence: 0.6 },
        ],
        narrowedIntents: ['search code', 'list repos'],
      }),
    };

    const matches: SelectorMatch[] = [];
    const result = await refine('find stuff', matches, tools, llm);

    expect(result.refined).toBe(true);
    expect(result.refinement).toBeDefined();
    expect(result.refinement!.type).toBe('tool_refinement_needed');
    expect(result.refinement!.originalIntent).toBe('find stuff');
    expect(result.refinement!.question).toBe('Which tool did you mean?');
    expect(result.refinement!.options).toHaveLength(2);
    expect(result.refinement!.narrowedIntents).toEqual(['search code', 'list repos']);
    expect(llm.refine).toHaveBeenCalledWith({
      intent: 'find stuff',
      nearestTools: tools.slice(0, 10),
    });
  });

  it('falls back to heuristic refinement using nearest matches when no LLM', async () => {
    const matches: SelectorMatch[] = [
      { id: 'vendor.github.search_code', distance: 0.3 },
      { id: 'vendor.github.list_repos', distance: 0.4 },
    ];

    const result = await refine('find stuff', matches, tools);

    expect(result.refined).toBe(true);
    expect(result.refinement).toBeDefined();
    expect(result.refinement!.type).toBe('tool_refinement_needed');
    expect(result.refinement!.originalIntent).toBe('find stuff');
    expect(result.refinement!.question).toContain('find stuff');
    expect(result.refinement!.options).toHaveLength(2);
    // Confidence is 1 - distance
    expect(result.refinement!.options[0].confidence).toBeCloseTo(0.7);
    expect(result.refinement!.options[1].confidence).toBeCloseTo(0.6);
    // Intents are derived from selector IDs with colons replaced by spaces
    expect(result.refinement!.options[0].intent).toBe('vendor.github.search_code');
    expect(result.refinement!.narrowedIntents).toHaveLength(2);
  });

  it('falls back to heuristic when LLM returns empty options', async () => {
    const llm: LLMClient = {
      refine: vi.fn().mockResolvedValue({
        question: '',
        options: [],
        narrowedIntents: [],
      }),
    };

    const matches: SelectorMatch[] = [
      { id: 'vendor.github.search_code', distance: 0.2 },
    ];

    const result = await refine('ambiguous', matches, tools, llm);

    expect(result.refined).toBe(true);
    // Should have used heuristic path since LLM returned empty options
    expect(result.refinement!.question).toContain('ambiguous');
    expect(result.refinement!.options).toHaveLength(1);
  });

  it('returns refined=false when no matches and no LLM', async () => {
    const result = await refine('totally unknown', [], tools);

    expect(result.refined).toBe(false);
    expect(result.refinement).toBeUndefined();
  });

  it('returns refined=false when no matches and LLM returns empty', async () => {
    const llm: LLMClient = {
      refine: vi.fn().mockResolvedValue({
        question: '',
        options: [],
        narrowedIntents: [],
      }),
    };

    const result = await refine('totally unknown', [], tools, llm);

    expect(result.refined).toBe(false);
    expect(result.refinement).toBeUndefined();
  });
});

describe('buildRefinementResult', () => {
  it('wraps refinement in a ToolResult with metadata', () => {
    const refinement: ToolRefinementNeeded = {
      type: 'tool_refinement_needed',
      originalIntent: 'do something',
      question: 'Which one did you mean?',
      options: [
        { label: 'Option A', intent: 'option a', confidence: 0.9 },
        { label: 'Option B', intent: 'option b', confidence: 0.7 },
      ],
      narrowedIntents: ['option a', 'option b'],
    };

    const result = buildRefinementResult(refinement);

    expect(result.isError).toBe(false);
    expect(result.refinement).toBe(refinement);

    const content = result.content as Record<string, unknown>;
    expect(content.message).toBe('Which one did you mean?');
    expect(content.options).toEqual(['Option A', 'Option B']);
    expect(content.hint).toContain('Re-dispatch');

    expect(result.metadata).toEqual({
      refinement: true,
      optionCount: 2,
    });
  });
});

describe('label formatting from selector IDs', () => {
  it('formats dotted selector IDs into human-readable labels', async () => {
    const matches: SelectorMatch[] = [
      { id: 'vendor.github.search_code', distance: 0.2 },
    ];

    const result = await refine('search', matches, tools);

    // "vendor.github.search_code" -> tool part "search_code" -> "Search Code"
    // provider part "github" -> "(github)"
    expect(result.refinement!.options[0].label).toBe('Search Code (github)');
  });

  it('formats single-segment IDs without provider suffix', async () => {
    const matches: SelectorMatch[] = [
      { id: 'search_code', distance: 0.1 },
    ];

    const result = await refine('search', matches, tools);

    // Single segment: no provider part
    expect(result.refinement!.options[0].label).toBe('Search Code');
  });

  it('limits heuristic options to 5 matches', async () => {
    const matches: SelectorMatch[] = Array.from({ length: 8 }, (_, i) => ({
      id: `tool_${i}`,
      distance: 0.1 * (i + 1),
    }));

    const result = await refine('broad query', matches, tools);

    expect(result.refinement!.options).toHaveLength(5);
  });
});
