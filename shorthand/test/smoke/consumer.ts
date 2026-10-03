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
  checkQuorum,
  evidenceClass,
  QUORUM_WINDOW_MS,
  SETTLING_EVIDENCE_KINDS,
  type TruthEvidenceClass,
  type TruthQuorumMember,
  type TruthQuorumSubject,
  type TruthSelection,
  type TruthSignerFile,
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
  const settling: TruthEvidenceClass = evidenceClass(SETTLING_EVIDENCE_KINDS[0]);
  const members: TruthQuorumMember[] = [
    { author: 'agent:a', agentSessionId: 's1', ts: '2026-09-01T12:00:00Z', evidence: [{ kind: 'commit', ref: 'a1b2c3' }], verdict: 'verified' },
  ];
  const subject: TruthQuorumSubject = { type: 'ADDENDUM', author: 'agent:a', ts: '2026-09-01T12:00:00Z', evidence: members[0].evidence, quorum: members };
  const issues: string[] = checkQuorum(subject);
  const registry: TruthSignerFile = { signers: [{ id: 'kim', role: 'human', keys: [{ alg: 'ed25519', id: 'kim/1', publicKey: 'AAAA' }] }] };
  const window: number = QUORUM_WINDOW_MS;

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

  void [tokens, level, snapshot, state, score, selection, jcs, settling, issues, registry, window, pages, events, checked, recall, gate];
}
