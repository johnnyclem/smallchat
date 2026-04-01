import { describe, it, expect, vi } from 'vitest';
import { decompose, executeDecomposition } from './decomposition.js';
import type { DecompositionResult } from './decomposition.js';
import type { LLMClient, ToolSummary } from '../core/llm-client.js';
import type { ToolResult } from '../core/types.js';

const tools: ToolSummary[] = [
  { name: 'search', description: 'Search files' },
  { name: 'read', description: 'Read a file' },
];

describe('decompose', () => {
  it('returns non-decomposed when no LLM client is provided', async () => {
    const result = await decompose('search and read files', tools);

    expect(result.decomposed).toBe(false);
    expect(result.original).toBe('search and read files');
    expect(result.subIntents).toEqual([]);
    expect(result.strategy).toBe('sequential');
  });

  it('returns non-decomposed when LLM client has no decompose method', async () => {
    const llm: LLMClient = {};
    const result = await decompose('search and read files', tools, llm);

    expect(result.decomposed).toBe(false);
    expect(result.subIntents).toEqual([]);
  });

  it('returns non-decomposed when LLM returns empty sub-intents', async () => {
    const llm: LLMClient = {
      decompose: vi.fn().mockResolvedValue({
        subIntents: [],
        strategy: 'sequential',
      }),
    };
    const result = await decompose('do something vague', tools, llm);

    expect(result.decomposed).toBe(false);
    expect(result.subIntents).toEqual([]);
    expect(llm.decompose).toHaveBeenCalledWith({
      intent: 'do something vague',
      availableTools: tools,
    });
  });

  it('returns decomposed result with sub-intents from LLM', async () => {
    const llm: LLMClient = {
      decompose: vi.fn().mockResolvedValue({
        subIntents: [
          { intent: 'search files', args: { query: 'test' } },
          { intent: 'read file', args: { path: 'result.txt' }, dependsOn: ['search files'] },
        ],
        strategy: 'sequential',
      }),
    };
    const result = await decompose('search and read files', tools, llm);

    expect(result.decomposed).toBe(true);
    expect(result.original).toBe('search and read files');
    expect(result.strategy).toBe('sequential');
    expect(result.subIntents).toHaveLength(2);
    expect(result.subIntents[0].intent).toBe('search files');
    expect(result.subIntents[1].dependsOn).toEqual(['search files']);
  });

  it('depth limit prevents infinite recursion', async () => {
    const llm: LLMClient = {
      decompose: vi.fn().mockResolvedValue({
        subIntents: [{ intent: 'sub' }],
        strategy: 'parallel',
      }),
    };

    const result = await decompose('deep intent', tools, llm, {
      maxDepth: 3,
      currentDepth: 3,
    });

    expect(result.decomposed).toBe(false);
    expect(result.subIntents).toEqual([]);
    // LLM should never be called when depth is exceeded
    expect(llm.decompose).not.toHaveBeenCalled();
  });

  it('respects custom maxDepth', async () => {
    const llm: LLMClient = {
      decompose: vi.fn().mockResolvedValue({
        subIntents: [{ intent: 'sub' }],
        strategy: 'parallel',
      }),
    };

    const result = await decompose('intent', tools, llm, {
      maxDepth: 1,
      currentDepth: 1,
    });

    expect(result.decomposed).toBe(false);
    expect(llm.decompose).not.toHaveBeenCalled();
  });
});

describe('executeDecomposition', () => {
  it('parallel strategy executes all sub-intents at once', async () => {
    const callOrder: string[] = [];
    const dispatcher = vi.fn(async (intent: string): Promise<ToolResult> => {
      callOrder.push(intent);
      return { content: { result: `done: ${intent}` } };
    });

    const result: DecompositionResult = {
      original: 'do everything',
      subIntents: [
        { intent: 'task-a' },
        { intent: 'task-b' },
        { intent: 'task-c' },
      ],
      strategy: 'parallel',
      decomposed: true,
    };

    const output = await executeDecomposition(result, dispatcher);

    expect(output.isError).toBe(false);
    expect(dispatcher).toHaveBeenCalledTimes(3);
    const content = output.content as Record<string, unknown>;
    expect(content.decomposed).toBe(true);
    expect(content.strategy).toBe('parallel');
    expect((content.results as unknown[]).length).toBe(3);
    expect(output.metadata).toEqual({
      decomposed: true,
      subIntentCount: 3,
      strategy: 'parallel',
    });
  });

  it('sequential strategy resolves dependencies in order', async () => {
    const callOrder: string[] = [];
    const dispatcher = vi.fn(async (intent: string): Promise<ToolResult> => {
      callOrder.push(intent);
      return { content: { result: intent } };
    });

    const result: DecompositionResult = {
      original: 'search then read',
      subIntents: [
        { intent: 'search files' },
        { intent: 'read file', dependsOn: ['search files'] },
      ],
      strategy: 'sequential',
      decomposed: true,
    };

    const output = await executeDecomposition(result, dispatcher);

    expect(output.isError).toBe(false);
    expect(callOrder).toEqual(['search files', 'read file']);
    expect(dispatcher).toHaveBeenCalledTimes(2);
  });

  it('sequential strategy reports unmet dependencies as errors', async () => {
    const dispatcher = vi.fn(async (): Promise<ToolResult> => {
      return { content: 'ok' };
    });

    const result: DecompositionResult = {
      original: 'broken chain',
      subIntents: [
        { intent: 'step-b', dependsOn: ['step-a'] }, // step-a not in list
      ],
      strategy: 'sequential',
      decomposed: true,
    };

    const output = await executeDecomposition(result, dispatcher);

    expect(output.isError).toBe(true);
    const results = (output.content as Record<string, unknown>).results as Array<Record<string, unknown>>;
    expect(results[0].isError).toBe(true);
    expect((results[0].content as Record<string, unknown>).error).toContain('Unmet dependencies');
    // Dispatcher should not have been called for the step with unmet deps
    expect(dispatcher).not.toHaveBeenCalled();
  });

  it('returns error result when decomposition was not successful', async () => {
    const dispatcher = vi.fn();

    const result: DecompositionResult = {
      original: 'undecomposed',
      subIntents: [],
      strategy: 'sequential',
      decomposed: false,
    };

    const output = await executeDecomposition(result, dispatcher);

    expect(output.isError).toBe(true);
    expect((output.content as Record<string, unknown>).error).toBe('Could not decompose intent');
    expect((output.content as Record<string, unknown>).original).toBe('undecomposed');
    expect(dispatcher).not.toHaveBeenCalled();
  });
});
