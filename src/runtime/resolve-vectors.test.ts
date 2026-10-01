/**
 * Conformance with spec/resolve/vectors.json (smallchat.resolve.v1): given
 * each tool's similarity to the intent, its annotations, intent pins and
 * policy options, runtime.resolve() reaches the expected outcome, decision,
 * tier, chosen tool, candidate order and exclusions. smallchat-swift runs
 * the same vectors.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolRuntime } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';
import { ToolClass } from '../core/tool-class.js';
import { parseToolId } from '../core/tool-id.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { Embedder, LLMClient, ToolAnnotations, ToolIMP } from '../core/types.js';
import type { IntentPin } from '../core/intent-pin.js';

interface VectorCase {
  name: string;
  intent: string;
  tools: Array<{ id: string; score: number; annotations?: ToolAnnotations }>;
  pins?: Array<{ toolId: string; policy: 'exact' | 'elevated'; phrases?: string[]; threshold?: number }>;
  options?: { llm?: { approve: string[] }; requireLLMForSubHighDispatch?: boolean; treatUnannotatedAsDestructive?: boolean };
  expect: {
    outcome: string;
    decision: string;
    tier: string;
    chosen: string | null;
    candidates: string[];
    excluded?: Array<{ toolId: string; reason: string }>;
  };
}

const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../spec/resolve/vectors.json', import.meta.url)), 'utf8')) as {
  version: string;
  cases: VectorCase[];
};

/** Selector canonical of a tool id: `<providerId>.<toolName>`. */
function selectorOf(id: string): string {
  const { providerId, toolName } = parseToolId(id);
  return `${providerId}.${toolName}`;
}

/**
 * A runtime in which the intent embeds as e₀ and tool i's selector as
 * score·e₀ + √(1−score²)·e_{i+1}, so cosine(intent, tool i) = score.
 */
function runtimeFor(c: VectorCase): ToolRuntime {
  const dims = c.tools.length + 2;
  const axis0 = new Float32Array(dims);
  axis0[0] = 1;
  const other = new Float32Array(dims);
  other[dims - 1] = 1;
  const embedder: Embedder = {
    dimensions: dims,
    embed: async text => (text === c.intent ? axis0 : other),
    embedBatch: async texts => texts.map(t => (t === c.intent ? axis0 : other)),
  };

  const llmClient: LLMClient | undefined = c.options?.llm
    ? { microCheck: async ({ toolName }) => c.options!.llm!.approve.includes(toolName) }
    : undefined;
  const pins: IntentPin[] = (c.pins ?? []).map(p => ({
    canonical: selectorOf(p.toolId),
    policy: p.policy,
    ...(p.phrases ? { aliases: p.phrases } : {}),
    ...(p.threshold !== undefined ? { threshold: p.threshold } : {}),
  }));
  const options: RuntimeOptions = {
    ...(llmClient ? { llmClient } : {}),
    ...(pins.length > 0 ? { intentPins: pins } : {}),
    ...(c.options?.requireLLMForSubHighDispatch !== undefined ? { requireLLMForSubHighDispatch: c.options.requireLLMForSubHighDispatch } : {}),
    ...(c.options?.treatUnannotatedAsDestructive !== undefined ? { treatUnannotatedAsDestructive: c.options.treatUnannotatedAsDestructive } : {}),
  };
  const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder, options);

  const classes = new Map<string, ToolClass>();
  c.tools.forEach((tool, i) => {
    const { providerId, toolName } = parseToolId(tool.id);
    const vector = new Float32Array(dims);
    vector[0] = tool.score;
    vector[i + 1] = Math.sqrt(1 - tool.score * tool.score);
    const imp: ToolIMP = {
      providerId,
      toolName,
      transportType: 'local',
      schema: null,
      // The description is the intent itself, so keyword verification passes.
      schemaLoader: async () => ({ name: toolName, description: c.intent, inputSchema: { type: 'object' }, arguments: [] }),
      execute: async () => ({ content: null }),
      constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    };
    let cls = classes.get(providerId);
    if (!cls) classes.set(providerId, cls = new ToolClass(providerId));
    cls.addMethod(runtime.selectorTable.register(vector, selectorOf(tool.id)), imp);
  });
  for (const cls of classes.values()) runtime.registerClass(cls);
  return runtime;
}

describe('resolve-outcome vectors (spec/resolve/vectors.json)', () => {
  it('is smallchat.resolve.v1', () => {
    expect(spec.version).toBe('smallchat.resolve.v1');
  });

  for (const c of spec.cases) {
    it(c.name, async () => {
      const resolution = await runtimeFor(c).resolve(c.intent);
      expect({
        outcome: resolution.outcome,
        decision: resolution.proof.decision,
        tier: resolution.tier,
        chosen: resolution.chosen ?? null,
        candidates: resolution.candidates.map(x => x.toolId),
        ...(c.expect.excluded ? {
          excluded: resolution.proof.candidates.filter(x => x.excluded).map(x => ({ toolId: x.toolId, reason: x.excluded })),
        } : {}),
      }).toEqual(c.expect);
    });
  }
});
