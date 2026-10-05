/**
 * Conformance with spec/judge/vectors.json (smallchat.judge.v1):
 *   - trigger: judgeTrigger(tier, best, runner-up, margin);
 *   - resolve: runtime.resolve() with a stub judge — whether it is asked,
 *     the trigger and the offered ids (in order) and, when given, their
 *     descriptions, the outcome, decision, tier and choice, and what the
 *     proof records (the judge's digested fields, when given the rest of
 *     its record, and its step);
 *   - replay: runtime.resolve() with a recorded verdict in place of the
 *     judge (ResolveOptions.judge), on a runtime whose own judge must never
 *     be called — the outcome and what the replayed proof records;
 *   - wire: a TypeSafe HTTP response read by JevJudge, then accepted or
 *     declined (acceptJudgeAnswer).
 * The resolve harness is spec/resolve's (cosine(intent, tool) = score).
 * A port of the judge (smallchat-swift) runs the trigger, resolve and
 * replay sections.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ToolRuntime } from './runtime.js';
import type { RuntimeOptions } from './runtime.js';
import { ToolClass } from '../core/tool-class.js';
import { parseToolId } from '../core/tool-id.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { Embedder, ToolAnnotations, ToolIMP } from '../core/types.js';
import type { LLMClient } from '../core/llm-client.js';
import type { ConfidenceTier, TierThresholds } from '../core/confidence.js';
import { acceptJudgeAnswer, judgeTrigger } from '../core/judge.js';
import type { JudgeAnswer, JudgeRequest, RecordedJudgeVerdict, ShortlistJudge } from '../core/judge.js';
import { JevJudge } from '../jev/index.js';

type Answer = { choice: string | null; probability: number | null; confidence: number | null; model?: string } | { unavailable: string };
type RecordedFields = { reason: string | null; probability: number | null; confidence: number | null; margin: number; maxCandidates: number };

interface ResolveCase {
  name: string;
  intent: string;
  args?: Record<string, unknown>;
  tools: Array<{ id: string; score: number; annotations?: ToolAnnotations; description?: string; required?: string[] }>;
  options?: { llm?: { approve: string[] }; requireLLMForSubHighDispatch?: boolean; strict?: boolean; thresholds?: TierThresholds };
  judge: { margin?: number; maxCandidates?: number; acceptThreshold?: number; answer: Answer };
  expect: {
    asked: boolean;
    trigger?: string;
    offered?: string[];
    descriptions?: string[];
    outcome: string;
    decision: string;
    tier: string;
    chosen: string | null;
    judge: { name: string; model: string; verdict: string; toolId: string | null } | null;
    record?: RecordedFields;
    step?: { decision: string; detail: Record<string, unknown> };
  };
}

interface ReplayCase {
  name: string;
  intent: string;
  tools: ResolveCase['tools'];
  options?: ResolveCase['options'];
  recorded: RecordedJudgeVerdict;
  expect: {
    outcome: string;
    decision: string;
    tier: string;
    chosen: string | null;
    judge: { name: string; model: string; verdict: string; toolId: string | null; reason: string | null } | null;
    step?: { decision: string; detail: Record<string, unknown> };
  };
}

const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../spec/judge/vectors.json', import.meta.url)), 'utf8')) as {
  version: string;
  defaults: { margin: number; maxCandidates: number; acceptThreshold: number; judge: { name: string; model: string } };
  trigger: Array<{ name: string; tier: ConfidenceTier; best: number; runnerUp: number | null; margin?: number; expect: string | null }>;
  resolve: ResolveCase[];
  replay: ReplayCase[];
  wire: {
    responses: {
      offered: string[];
      acceptThreshold: number;
      model: string;
      cases: Array<{ name: string; status: number; body?: unknown; bodyText?: string; expect: Record<string, unknown> }>;
    };
  };
};

function selectorOf(id: string): string {
  const { providerId, toolName } = parseToolId(id);
  return `${providerId}.${toolName}`;
}

/** A judge that answers the case's answer and remembers what it was asked. */
function stubJudge(c: ResolveCase, requests: JudgeRequest[]): ShortlistJudge {
  const a = c.judge.answer;
  return {
    name: spec.defaults.judge.name,
    model: spec.defaults.judge.model,
    ...(c.judge.margin !== undefined ? { margin: c.judge.margin } : {}),
    ...(c.judge.maxCandidates !== undefined ? { maxCandidates: c.judge.maxCandidates } : {}),
    ...(c.judge.acceptThreshold !== undefined ? { acceptThreshold: c.judge.acceptThreshold } : {}),
    judge: async (request: JudgeRequest): Promise<JudgeAnswer> => {
      requests.push(request);
      return 'unavailable' in a
        ? { status: 'unavailable', error: a.unavailable as JudgeAnswer extends { error: infer E } ? E : never }
        : { status: 'answered', choice: a.choice, probability: a.probability, confidence: a.confidence, ...(a.model !== undefined ? { model: a.model } : {}) };
    },
  };
}

/** spec/resolve's runtime, plus per-tool descriptions and required parameters, and the stub judge. */
function runtimeFor(c: Pick<ResolveCase, 'intent' | 'tools' | 'options'>, judge: ShortlistJudge): ToolRuntime {
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
  const options: RuntimeOptions = {
    judge,
    ...(llmClient ? { llmClient } : {}),
    ...(c.options?.strict !== undefined ? { strict: c.options.strict } : {}),
    ...(c.options?.thresholds ? { thresholds: c.options.thresholds } : {}),
    ...(c.options?.requireLLMForSubHighDispatch !== undefined ? { requireLLMForSubHighDispatch: c.options.requireLLMForSubHighDispatch } : {}),
  };
  const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder, options);
  const classes = new Map<string, ToolClass>();
  c.tools.forEach((tool, i) => {
    const { providerId, toolName } = parseToolId(tool.id);
    const vector = new Float32Array(dims);
    vector[0] = tool.score;
    vector[i + 1] = Math.sqrt(1 - tool.score * tool.score);
    const required = tool.required ?? [];
    const imp: ToolIMP = {
      providerId,
      toolName,
      transportType: 'local',
      schema: null,
      schemaLoader: async () => ({
        name: toolName,
        description: tool.description ?? c.intent,
        inputSchema: { type: 'object', properties: Object.fromEntries(required.map(r => [r, { type: 'string' }])), required },
        arguments: required.map(r => ({ name: r, type: { type: 'string' }, description: r, required: true })),
      }),
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

describe('shortlist-judge vectors (spec/judge/vectors.json)', () => {
  it('is smallchat.judge.v1', () => {
    expect(spec.version).toBe('smallchat.judge.v1');
  });

  describe('trigger', () => {
    for (const c of spec.trigger) {
      it(c.name, () => {
        expect(judgeTrigger({ tier: c.tier, bestScore: c.best, runnerUpScore: c.runnerUp, margin: c.margin ?? spec.defaults.margin })).toBe(c.expect);
      });
    }
  });

  describe('resolve', () => {
    for (const c of spec.resolve) {
      it(c.name, async () => {
        const requests: JudgeRequest[] = [];
        const resolution = await runtimeFor(c, stubJudge(c, requests)).resolve(c.intent, c.args ? { args: c.args } : {});
        const judged = resolution.proof.judge;
        const step = resolution.proof.steps.find(s => s.stage === 'judge');
        expect({
          asked: requests.length > 0,
          ...(requests.length > 0 ? { trigger: requests[0].trigger, offered: requests[0].candidates.map(x => x.toolId) } : {}),
          ...(c.expect.descriptions !== undefined ? { descriptions: requests[0]?.candidates.map(x => x.description) } : {}),
          outcome: resolution.outcome,
          decision: resolution.proof.decision,
          tier: resolution.tier,
          chosen: resolution.chosen ?? null,
          judge: judged ? { name: judged.name, model: judged.model, verdict: judged.verdict, toolId: judged.toolId } : null,
          ...(c.expect.record !== undefined ? {
            record: judged
              ? { reason: judged.reason, probability: judged.probability, confidence: judged.confidence, margin: judged.margin, maxCandidates: judged.maxCandidates }
              : null,
          } : {}),
          ...(step ? { step: { decision: step.decision, detail: step.detail } } : {}),
        }).toEqual(c.expect);
        expect(requests.length).toBeLessThanOrEqual(1);
      });
    }
  });

  describe('replay: a recorded verdict answers in the judge\'s place', () => {
    for (const c of spec.replay) {
      it(c.name, async () => {
        const calls: JudgeRequest[] = [];
        const live: ShortlistJudge = {
          name: spec.defaults.judge.name,
          model: spec.defaults.judge.model,
          judge: async request => {
            calls.push(request);
            throw new Error('replay must not call the judge');
          },
        };
        const resolution = await runtimeFor(c, live).resolve(c.intent, { judge: c.recorded });
        const judged = resolution.proof.judge;
        const step = resolution.proof.steps.find(s => s.stage === 'judge');
        expect(calls).toEqual([]);
        expect({
          outcome: resolution.outcome,
          decision: resolution.proof.decision,
          tier: resolution.tier,
          chosen: resolution.chosen ?? null,
          judge: judged ? { name: judged.name, model: judged.model, verdict: judged.verdict, toolId: judged.toolId, reason: judged.reason } : null,
          ...(step ? { step: { decision: step.decision, detail: step.detail } } : {}),
        }).toEqual(c.expect);
      });
    }
  });

  describe('wire: a TypeSafe response becomes a verdict', () => {
    const { offered, acceptThreshold, model, cases } = spec.wire.responses;
    for (const c of cases) {
      it(c.name, async () => {
        const judge = new JevJudge({
          apiKey: 'sk-test-vectors',
          model,
          maxRetries: 0,
          fetch: async () => new Response(c.bodyText ?? JSON.stringify(c.body), { status: c.status, headers: { 'Content-Type': 'application/json' } }),
        });
        const answer = await judge.judge({ intent: 'email the invoice', trigger: 'ambiguous', candidates: offered.map(toolId => ({ toolId, description: toolId })) });
        expect(acceptJudgeAnswer(answer, offered, acceptThreshold, model)).toMatchObject(c.expect);
      });
    }
  });
});
