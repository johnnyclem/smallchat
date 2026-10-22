/**
 * The judge's context (RuntimeOptions.judgeContext) and grading
 * (ToolRuntime.gradeJudgement): the provider is asked once per judged
 * resolution within the judge's budget and never changes the digest; a
 * grade is logged as a judge-feedback line, handed to the judge, and a
 * correction teaches dispatch.
 */

import { describe, it, expect } from 'vitest';
import { ToolRuntime } from './runtime.js';
import { ToolClass } from '../core/tool-class.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import { DecisionLog, verifyDecisionLog, replayDecisionLog } from './decision-log.js';
import type { Embedder, ToolIMP } from '../core/types.js';
import type { JudgeContext, JudgeContextProvider, JudgeFeedback, JudgeRequest, ShortlistJudge } from '../core/judge.js';

const TOOLS = [{ id: 'github/get_issue', score: 0.9 }, { id: 'gitlab/get_issue', score: 0.88 }, { id: 'github/list_issues', score: 0.7 }];
const INTENT = 'look up issue';

function judgeOf(choice: string | null, requests: JudgeRequest[], feedback: JudgeFeedback[] = [], extra: Partial<ShortlistJudge> = {}): ShortlistJudge {
  return {
    name: 'stub',
    model: 'stub-1',
    judge: async request => {
      requests.push(request);
      return { status: 'answered', choice, probability: 0.9, confidence: 0.8 };
    },
    feedback: async grade => { feedback.push(grade); },
    ...extra,
  };
}

function runtimeWith(options: { judge: ShortlistJudge; judgeContext?: JudgeContextProvider; decisionLog?: DecisionLog }): ToolRuntime {
  const dims = TOOLS.length + 2;
  const axis0 = new Float32Array(dims);
  axis0[0] = 1;
  const other = new Float32Array(dims);
  other[dims - 1] = 1;
  const embedder: Embedder = {
    dimensions: dims,
    embed: async text => (text === INTENT ? axis0 : other),
    embedBatch: async texts => texts.map(t => (t === INTENT ? axis0 : other)),
  };
  const runtime = new ToolRuntime(new MemoryVectorIndex(), embedder, options);
  const classes = new Map<string, ToolClass>();
  TOOLS.forEach((tool, i) => {
    const [providerId, toolName] = tool.id.split('/');
    const vector = new Float32Array(dims);
    vector[0] = tool.score;
    vector[i + 1] = Math.sqrt(1 - tool.score * tool.score);
    const imp: ToolIMP = {
      providerId,
      toolName,
      transportType: 'local',
      schema: null,
      schemaLoader: async () => ({ name: toolName, description: INTENT, inputSchema: { type: 'object', properties: {} }, arguments: [] }),
      execute: async () => ({ content: null }),
      constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
    };
    let cls = classes.get(providerId);
    if (!cls) classes.set(providerId, cls = new ToolClass(providerId));
    cls.addMethod(runtime.selectorTable.register(vector, `${providerId}.${toolName}`), imp);
  });
  for (const cls of classes.values()) runtime.registerClass(cls);
  return runtime;
}

const CONTEXT: JudgeContext = { sessionId: 's1', truth: [{ id: 'tb1', type: 'TB', status: 'active', text: 'gitlab is the tracker now', grade: 'asserted' }] };

describe('the judge context', () => {
  it('is fetched once per judged resolution and handed to the judge; the step names the provider, never the context', async () => {
    const asks: string[] = [];
    const provider: JudgeContextProvider = { name: 'steno', context: async ({ intent }) => { asks.push(intent); return CONTEXT; } };
    const requests: JudgeRequest[] = [];
    const judged = await runtimeWith({ judge: judgeOf('gitlab/get_issue', requests), judgeContext: provider }).resolve(INTENT);
    expect(asks).toEqual([INTENT]);
    expect(requests[0].context).toEqual(CONTEXT);
    expect(judged.chosen).toBe('gitlab/get_issue');
    const step = judged.proof.steps.find(s => s.stage === 'judge')!;
    expect(step.detail).toMatchObject({ context: 'steno' });

    const bare: JudgeRequest[] = [];
    const plain = await runtimeWith({ judge: judgeOf('gitlab/get_issue', bare) }).resolve(INTENT);
    expect(bare[0].context).toBeUndefined();
    expect(plain.proof.steps.find(s => s.stage === 'judge')!.detail).not.toHaveProperty('context');
    // Context is an input: the digest records that it was offered (the step), not what it was
    expect(plain.proof.proofDigest).not.toBe(judged.proof.proofDigest);
    expect(JSON.stringify(judged.proof)).not.toContain('gitlab is the tracker now');
  });

  it('a provider that answers null, throws or is slow leaves the judge with the intent alone', async () => {
    for (const provider of [
      { name: 'null', context: async () => null },
      { name: 'throws', context: async () => { throw new Error('down'); } },
      { name: 'slow', context: ({ signal }: { signal?: AbortSignal }) => new Promise<JudgeContext | null>(resolve => { signal?.addEventListener('abort', () => resolve(null)); }) },
    ] as JudgeContextProvider[]) {
      const requests: JudgeRequest[] = [];
      const judge = judgeOf('gitlab/get_issue', requests, [], { timeoutMs: 50 });
      const r = await runtimeWith({ judge, judgeContext: provider }).resolve(INTENT);
      if (provider.name === 'slow') {
        expect(r.proof.judge!.verdict).toBe('unavailable');
        expect(requests).toEqual([]);
      } else {
        expect(requests[0].context).toBeUndefined();
        expect(r.proof.steps.find(s => s.stage === 'judge')!.detail).not.toHaveProperty('context');
      }
    }
  });

  it('is checked at construction and ignored without a judge', () => {
    expect(() => new ToolRuntime(new MemoryVectorIndex(), { dimensions: 2, embed: async () => new Float32Array(2), embedBatch: async () => [] }, { judge: judgeOf(null, []), judgeContext: { name: '' } as JudgeContextProvider })).toThrow(/judgeContext/);
    const without = new ToolRuntime(new MemoryVectorIndex(), { dimensions: 2, embed: async () => new Float32Array(2), embedBatch: async () => [] }, { judgeContext: { name: 'x', context: async () => null } });
    expect(without.context.judgeContext).toBeNull();
  });
});

describe('gradeJudgement', () => {
  it('rewards a correct guess: logged, told to the judge, no negative example', async () => {
    const feedback: JudgeFeedback[] = [];
    const log = new DecisionLog();
    const runtime = runtimeWith({ judge: judgeOf('gitlab/get_issue', [], feedback), decisionLog: log });
    const r = await runtime.resolve(INTENT);
    const graded = await runtime.gradeJudgement(r, { correct: true, reason: 'the user confirmed' });
    expect(graded).toMatchObject({ logged: true, judgeInformed: true, judgeError: null, feedback: { outcome: 'rewarded', chosenToolId: 'gitlab/get_issue', correctToolId: 'gitlab/get_issue', reason: 'the user confirmed' } });
    expect(feedback).toHaveLength(1);
    expect(feedback[0].judge.name).toBe('stub');
    const lines = log.lines().map(l => JSON.parse(l));
    expect(lines.map(l => l.kind)).toEqual(['resolve', 'judge-feedback']);
    expect(lines[1]).toMatchObject({ feedback: { outcome: 'rewarded', correctToolId: 'gitlab/get_issue', reason: 'the user confirmed' }, toolId: 'gitlab/get_issue', proofDigest: r.proof.proofDigest });
    expect(verifyDecisionLog(log.lines().join('\n') + '\n').ok).toBe(true);
    expect(runtime.observer.getNegativeExamples()).toEqual([]);
  });

  it('corrects a wrong guess: the choice becomes a negative example and the next resolution avoids it', async () => {
    const feedback: JudgeFeedback[] = [];
    const log = new DecisionLog();
    const runtime = runtimeWith({ judge: judgeOf('gitlab/get_issue', [], feedback), decisionLog: log });
    const r = await runtime.resolve(INTENT);
    expect(r.chosen).toBe('gitlab/get_issue');
    const graded = await runtime.gradeJudgement(r, { correct: false, correctToolId: 'github/get_issue', reason: 'wrong tracker' });
    expect(graded.feedback).toMatchObject({ outcome: 'corrected', chosenToolId: 'gitlab/get_issue', correctToolId: 'github/get_issue' });
    expect(runtime.observer.getNegativeExamples()).toMatchObject([{ wrongTool: 'gitlab/get_issue', correctTool: 'github/get_issue', source: 'feedback' }]);
    const again = await runtime.resolve(INTENT);
    expect(again.chosen).not.toBe('gitlab/get_issue');
    const replay = await replayDecisionLog(runtime, verifyDecisionLog(log.lines().join('\n') + '\n').records);
    expect(replay.entries.find(e => e.kind === 'judge-feedback')).toMatchObject({ status: 'skipped' });
  });

  it('refuses a resolution without a judge record, a correction naming the chosen tool, and reports a judge that throws', async () => {
    const runtime = runtimeWith({ judge: judgeOf('gitlab/get_issue', [], [], { feedback: async () => { throw new Error('store is read-only'); } }) });
    const r = await runtime.resolve(INTENT);
    await expect(runtime.gradeJudgement({ ...r, proof: { ...r.proof, judge: undefined } }, { correct: true })).rejects.toThrow(/no judge record/);
    await expect(runtime.gradeJudgement(r, { correct: false, correctToolId: 'gitlab/get_issue' })).rejects.toThrow(/other than the one chosen/);
    const graded = await runtime.gradeJudgement(r, { correct: true });
    expect(graded).toMatchObject({ logged: false, judgeInformed: false, judgeError: 'store is read-only' });
  });

  it('a decision log refuses a feedback line on another kind, or one without its judge', () => {
    const log = new DecisionLog();
    const runtime = runtimeWith({ judge: judgeOf('gitlab/get_issue', []), decisionLog: log });
    return runtime.resolve(INTENT).then(async r => {
      await runtime.gradeJudgement(r, { correct: true });
      const [resolveLine, feedbackLine] = log.lines().map(l => JSON.parse(l));
      const tampered = { ...resolveLine, feedback: feedbackLine.feedback };
      expect(verifyDecisionLog(JSON.stringify(tampered) + '\n').ok).toBe(false);
      const { judge: _judge, ...noJudge } = feedbackLine;
      expect(verifyDecisionLog(JSON.stringify(noJudge) + '\n').error!.message).toMatch(/hash|judge/);
    });
  });
});
