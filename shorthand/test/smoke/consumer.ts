/**
 * A consumer of the packed @shorthand/core, typechecked by
 * scripts/pack-smoke.mjs under moduleResolution Node16 and Bundler with
 * skipLibCheck off, so the published declarations are checked as a user's
 * compiler sees them. Imports one or more names from every subpath export.
 */
import {
  CompactionEngine,
  renderContextFrame,
  estimateTokens,
  type ContextFrame,
  type ConversationMessage,
} from '@shorthand/core';
import {
  CompactionLevel,
  DefaultCompactor,
  type CompactedSnapshot,
  type SnapshotLevel,
} from '@shorthand/core/compaction';
import { AgentMemory, LWWRegister, type AgentMemoryState } from '@shorthand/core/crdt';
import { ImportanceDetector, type ImportanceScore } from '@shorthand/core/importance';
import {
  parseWikiLines,
  selectCurrentTruth,
  canonicalizeJcs,
  type TruthSelection,
  type WikiParseResult,
} from '@shorthand/core/truth';
import { WikiRenderer, type WikiPage } from '@shorthand/core/wiki';
import { SourceIngester, type IngestionEvent } from '@shorthand/core/ingestion';
import { RegexInterpreter, withFallback, type Interpreter } from '@shorthand/core/interpreter';
import { InvariantChecker, RecallTester } from '@shorthand/core/verification';
import {
  ContextShiftBenchmark,
  KeywordJudge,
  STARTER_FIXTURES,
  type BenchmarkReport,
} from '@shorthand/core/benchmark';

// @ts-expect-error -- only the subpaths in "exports" are importable
import type * as Internal from '@shorthand/core/dist/compaction/frame.js';

export type Unused = typeof Internal;

export async function smoke(): Promise<void> {
  const message: ConversationMessage = {
    id: '1',
    role: 'user',
    content: 'We decided to use PostgreSQL instead of MySQL.',
    timestamp: Date.now(),
  };
  const engine = new CompactionEngine({ memtableSize: 4 });
  await engine.addMessage(message);
  const frame: ContextFrame = engine.buildContextFrame(500);
  const prompt: string = renderContextFrame(frame);
  const tokens: number = estimateTokens(prompt);
  const level: CompactionLevel = CompactionLevel.L1_COMPACTED;

  const snapshotLevel: SnapshotLevel = 'L2';
  const snapshot: CompactedSnapshot = await new DefaultCompactor().compact(
    { sessionId: 's', messages: [message] },
    snapshotLevel,
  );

  const memory = new AgentMemory('agent-1');
  memory.setInvariant('db', 'PostgreSQL');
  const state: AgentMemoryState = memory.serialize();
  const register = new LWWRegister<string>('agent-1');
  register.set('db', 'PostgreSQL');

  const score: ImportanceScore = new ImportanceDetector().addMessage(message);

  const read: WikiParseResult = parseWikiLines('');
  const selection: TruthSelection = selectCurrentTruth(read.entries);
  const jcs: string = canonicalizeJcs({ b: 1, a: [true, null] });

  const pages: WikiPage[] = new WikiRenderer().render(engine.getState(), []);
  const ingester = new SourceIngester();
  const events: IngestionEvent[] = ingester.getEvents();

  const interpreter: Interpreter = withFallback(new RegexInterpreter(), new RegexInterpreter());
  const checked = new InvariantChecker().verify(engine.getState(), { frame });
  const recall = new RecallTester().generateQuestions([message]);

  const report: BenchmarkReport = await new ContextShiftBenchmark({
    interpreter,
    judge: new KeywordJudge(),
  }).run(STARTER_FIXTURES.slice(0, 1));
  const gate: boolean = report.gate.passed;

  void [tokens, level, snapshot, state, score, selection, jcs, pages, events, checked, recall, gate];
}
