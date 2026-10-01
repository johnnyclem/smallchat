/**
 * Replay — golden dispatch traces (`smallchat replay <artifact> <traces…>`).
 *
 * A trace file lists intents and what the runtime must decide for each:
 *
 *   {"intent": "send a slack message", "expect": {"toolId": "slack/send_message", "tier": "high"}}
 *   {"intent": "create_issue", "expect": {"outcome": "needs-disambiguation", "candidates": ["github/create_issue", "gitlab/create_issue"]}}
 *   {"intent": "search the web", "expect": {"outcome": "unresolved"}}
 *
 * Files are JSONL (one case per line; blank lines and lines starting with
 * `#` are ignored) or JSON (an array of cases, or `{"cases": [...]}`).
 * A case may also carry `args` (passed to resolution, which uses them to
 * choose among overloads and in verification), `principal`, and `name`.
 *
 * Expectations:
 *   - `{toolId, tier?}` (or `{outcome: "resolved", toolId, tier?}`): the
 *     runtime resolves, on its own, to exactly that canonical tool id (at
 *     that tier, when given).
 *   - `{outcome: "needs-disambiguation", candidates?}`: the runtime refuses
 *     to pick on its own; every listed tool id is among its candidates
 *     (or, when it has none at or above LOW, among its refinement options).
 *   - `{outcome: "unresolved"}`: nothing matched.
 *
 * Cases run through `runtime.resolve()` with learning off: nothing
 * executes, nothing is cached, the semantic map and feedback are read but
 * never written, and the order of cases (or files) cannot change a
 * result. The same artifact, embedder, policy and learned state give the
 * same results on one platform; see spec/ranking for the score
 * quantization that keeps small cross-platform float differences out.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ConfidenceTier } from '../core/confidence.js';
import type { ResolutionOutcome } from '../core/proof.js';
import { isDecisionRecord, replayDecisionLog, verifyDecisionLog } from './decision-log.js';
import type { DecisionReplayReport } from './decision-log.js';
import type { ToolRuntime } from './runtime.js';
import type { Resolution } from './dispatch.js';

/** What a trace case expects. */
export type TraceExpectation =
  | { outcome?: 'resolved'; toolId: string; tier?: ConfidenceTier }
  | { outcome: 'needs-disambiguation'; candidates?: string[] }
  | { outcome: 'unresolved' };

export interface TraceCase {
  intent: string;
  expect: TraceExpectation;
  args?: Record<string, unknown>;
  principal?: string;
  /** Optional label shown in reports */
  name?: string;
}

/** A case with where it came from. */
export interface LoadedTraceCase extends TraceCase {
  file: string;
  /** 1-based line (JSONL) or case index + 1 (JSON) */
  line: number;
}

/** A trace file that cannot be read or parsed. */
export class TraceFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceFormatError';
  }
}

const TIERS: readonly ConfidenceTier[] = ['exact', 'high', 'medium', 'low', 'none'];

function checkCase(value: unknown, where: string): TraceCase {
  const fail = (why: string): never => { throw new TraceFormatError(`${where}: ${why}`); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('a case must be a JSON object');
  const c = value as Record<string, unknown>;
  if (typeof c.intent !== 'string' || c.intent.trim() === '') fail('"intent" must be a non-empty string');
  if (c.args !== undefined && (c.args === null || typeof c.args !== 'object' || Array.isArray(c.args))) fail('"args" must be a JSON object');
  if (c.principal !== undefined && typeof c.principal !== 'string') fail('"principal" must be a string');
  if (c.name !== undefined && typeof c.name !== 'string') fail('"name" must be a string');
  const e = c.expect as Record<string, unknown> | undefined;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) fail('"expect" must be a JSON object');

  let expect: TraceExpectation;
  if (e!.outcome === undefined || e!.outcome === 'resolved') {
    if (typeof e!.toolId !== 'string' || !e!.toolId.includes('/')) fail('"expect.toolId" must be a canonical tool id "<providerId>/<toolName>"');
    if (e!.tier !== undefined && !TIERS.includes(e!.tier as ConfidenceTier)) fail(`"expect.tier" must be one of ${TIERS.join(', ')}`);
    expect = { toolId: e!.toolId as string, ...(e!.tier !== undefined ? { tier: e!.tier as ConfidenceTier } : {}) };
  } else if (e!.outcome === 'needs-disambiguation') {
    const candidates = e!.candidates;
    if (candidates !== undefined && (!Array.isArray(candidates) || candidates.some(id => typeof id !== 'string'))) {
      fail('"expect.candidates" must be an array of tool ids');
    }
    expect = { outcome: 'needs-disambiguation', ...(candidates !== undefined ? { candidates: candidates as string[] } : {}) };
  } else if (e!.outcome === 'unresolved') {
    expect = { outcome: 'unresolved' };
  } else {
    return fail(`unknown "expect.outcome" ${JSON.stringify(e!.outcome)} (expected resolved, needs-disambiguation or unresolved)`);
  }

  return {
    intent: c.intent as string,
    expect,
    ...(c.args !== undefined ? { args: c.args as Record<string, unknown> } : {}),
    ...(c.principal !== undefined ? { principal: c.principal as string } : {}),
    ...(c.name !== undefined ? { name: c.name as string } : {}),
  };
}

/**
 * Parse one trace file's text. `.json` files hold an array of cases or
 * `{"cases": [...]}`; anything else is read as JSONL. Throws
 * TraceFormatError naming the file and line.
 */
export function parseTraceFile(text: string, file: string): LoadedTraceCase[] {
  if (file.endsWith('.json')) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw new TraceFormatError(`${file}: not valid JSON (${(err as Error).message})`);
    }
    const list = Array.isArray(doc) ? doc : (doc as { cases?: unknown })?.cases;
    if (!Array.isArray(list)) throw new TraceFormatError(`${file}: expected an array of cases or {"cases": [...]}`);
    return list.map((value, i) => ({ ...checkCase(value, `${file}, case ${i + 1}`), file, line: i + 1 }));
  }

  const cases: LoadedTraceCase[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new TraceFormatError(`${file}, line ${i + 1}: not valid JSON (${(err as Error).message})`);
    }
    cases.push({ ...checkCase(value, `${file}, line ${i + 1}`), file, line: i + 1 });
  }
  return cases;
}

/**
 * Trace files under `paths`: files as given, directories searched
 * recursively for `.jsonl` and `.json` files (sorted, so the order is
 * stable). Paths are reported relative to `base`.
 */
export function findTraceFiles(paths: readonly string[], base = process.cwd()): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (entry.endsWith('.jsonl') || entry.endsWith('.json')) files.push(full);
    }
  };
  for (const p of paths) {
    let stat;
    try {
      stat = statSync(p);
    } catch {
      throw new TraceFormatError(`${relative(base, p) || p}: no such file or directory`);
    }
    if (stat.isDirectory()) walk(p);
    else files.push(p);
  }
  return files;
}

/** Whether a file's first content line is a decision-log record rather than a trace case. */
export function isDecisionLogText(text: string): boolean {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      return isDecisionRecord(JSON.parse(line));
    } catch {
      return false;
    }
  }
  return false;
}

/** Load and parse trace files (see findTraceFiles / parseTraceFile). */
export function loadTraceFiles(paths: readonly string[], base = process.cwd()): LoadedTraceCase[] {
  return findTraceFiles(paths, base).flatMap(file =>
    parseTraceFile(readFileSync(file, 'utf-8'), relative(base, file) || file),
  );
}

/** What the runtime decided for one case. */
export interface TraceActual {
  outcome: ResolutionOutcome;
  toolId: string | null;
  tier: ConfidenceTier;
  decision: string;
  /** Candidate tool ids, best first (refinement options when there were no candidates) */
  candidates: string[];
  proofDigest: string;
}

export interface TraceCaseResult {
  file: string;
  line: number;
  name?: string;
  intent: string;
  expect: TraceExpectation;
  status: 'pass' | 'mismatch' | 'error';
  actual?: TraceActual;
  /** Why it did not pass, one sentence each */
  problems: string[];
}

export interface ReplayReport {
  artifactHash: string | null;
  total: number;
  passed: number;
  mismatched: number;
  errors: number;
  results: TraceCaseResult[];
}

/** Candidate ids a resolution offers: its candidates, else its refinement options. */
function offeredIds(resolution: Resolution): string[] {
  if (resolution.candidates.length > 0) return resolution.candidates.map(c => c.toolId);
  const ids: string[] = [];
  for (const option of resolution.refinement?.options ?? []) {
    if (option.toolId && !ids.includes(option.toolId)) ids.push(option.toolId);
  }
  return ids;
}

/** Compare one resolution with what a case expects; returns the problems (none = pass). */
export function checkExpectation(expect: TraceExpectation, actual: TraceActual): string[] {
  const problems: string[] = [];
  const got = `${actual.outcome}${actual.toolId ? ` ${actual.toolId}` : ''} (${actual.tier}, ${actual.decision})`;
  if ('toolId' in expect) {
    if (actual.outcome !== 'resolved' || actual.toolId !== expect.toolId) {
      problems.push(`expected resolved ${expect.toolId}, got ${got}`);
    } else if (expect.tier !== undefined && actual.tier !== expect.tier) {
      problems.push(`expected tier ${expect.tier}, got ${actual.tier}`);
    }
    return problems;
  }
  if (actual.outcome !== expect.outcome) {
    problems.push(`expected ${expect.outcome}, got ${got}`);
    return problems;
  }
  if (expect.outcome === 'needs-disambiguation') {
    const missing = (expect.candidates ?? []).filter(id => !actual.candidates.includes(id));
    if (missing.length > 0) {
      problems.push(`expected candidates ${missing.join(', ')} missing (candidates: ${actual.candidates.join(', ') || 'none'})`);
    }
  }
  return problems;
}

/**
 * Run trace cases against a runtime (resolve only, learning off). A case
 * whose resolution throws is an 'error'; the rest pass or mismatch.
 */
export async function replayTraces(runtime: ToolRuntime, cases: readonly LoadedTraceCase[]): Promise<ReplayReport> {
  const results: TraceCaseResult[] = [];
  for (const c of cases) {
    const base = {
      file: c.file,
      line: c.line,
      ...(c.name !== undefined ? { name: c.name } : {}),
      intent: c.intent,
      expect: c.expect,
    };
    let resolution: Resolution;
    try {
      resolution = await runtime.resolve(c.intent, {
        learn: false,
        ...(c.args !== undefined ? { args: c.args } : {}),
        ...(c.principal !== undefined ? { principal: c.principal } : {}),
      });
    } catch (err) {
      results.push({ ...base, status: 'error', problems: [`resolution threw: ${(err as Error).message}`] });
      continue;
    }
    const actual: TraceActual = {
      outcome: resolution.outcome,
      toolId: resolution.chosen ?? null,
      tier: resolution.tier,
      decision: resolution.proof.decision,
      candidates: offeredIds(resolution),
      proofDigest: resolution.proof.proofDigest,
    };
    const problems = checkExpectation(c.expect, actual);
    results.push({ ...base, status: problems.length === 0 ? 'pass' : 'mismatch', actual, problems });
  }
  return {
    artifactHash: runtime.context.artifactHash,
    total: results.length,
    passed: results.filter(r => r.status === 'pass').length,
    mismatched: results.filter(r => r.status === 'mismatch').length,
    errors: results.filter(r => r.status === 'error').length,
    results,
  };
}

/** Human-readable report (what `smallchat replay` prints). */
export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = [];
  let file: string | null = null;
  for (const r of report.results) {
    if (r.file !== file) {
      file = r.file;
      lines.push(file);
    }
    const label = r.name ? `${r.name}: ` : '';
    if (r.status === 'pass') {
      const a = r.actual!;
      lines.push(`  ✓ ${label}${JSON.stringify(r.intent)} → ${a.outcome}${a.toolId ? ` ${a.toolId}` : ''} (${a.tier})`);
    } else {
      lines.push(`  ✗ line ${r.line} ${label}${JSON.stringify(r.intent)}: ${r.problems.join('; ')}`);
    }
  }
  lines.push('');
  lines.push(`${report.passed} passed, ${report.mismatched} mismatched, ${report.errors} errors (${report.total} cases)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Files: trace files and decision logs together (what the CLI runs)
// ---------------------------------------------------------------------------

/** Exit codes of `smallchat replay` (as `appa replay`). */
export const REPLAY_EXIT = { pass: 0, mismatch: 1, couldNotRun: 2 } as const;

/** A decision log found among the replay inputs: chain verification, then replay. */
export interface DecisionLogReplay {
  file: string;
  verified: boolean;
  /** Records read (up to the break, when the chain is broken) */
  records: number;
  head: string | null;
  error?: { line: number; message: string };
  replay?: DecisionReplayReport;
}

export interface ReplayRun {
  traces: ReplayReport;
  decisionLogs: DecisionLogReplay[];
  /** 0 every case passed and every log verified and reproduced, 1 a mismatch or broken chain, 2 a case could not run */
  exitCode: 0 | 1 | 2;
}

/**
 * Replay every trace file and decision log under `paths` (files or
 * directories) against `runtime`. Decision logs are recognised by their
 * first line, verified, then replayed. Throws TraceFormatError when an
 * input cannot be read or parsed, or when there is nothing to replay.
 */
export async function replayPaths(runtime: ToolRuntime, paths: readonly string[], base = process.cwd()): Promise<ReplayRun> {
  const cases: LoadedTraceCase[] = [];
  const decisionLogs: DecisionLogReplay[] = [];
  for (const file of findTraceFiles(paths, base)) {
    const name = relative(base, file) || file;
    const text = readFileSync(file, 'utf-8');
    if (!isDecisionLogText(text)) {
      cases.push(...parseTraceFile(text, name));
      continue;
    }
    const verification = verifyDecisionLog(text);
    decisionLogs.push({
      file: name,
      verified: verification.ok,
      records: verification.records.length,
      head: verification.head,
      ...(verification.error ? { error: verification.error } : {}),
      ...(verification.ok ? { replay: await replayDecisionLog(runtime, verification.records) } : {}),
    });
  }
  if (cases.length === 0 && decisionLogs.length === 0) throw new TraceFormatError('No trace cases found.');

  const traces = await replayTraces(runtime, cases);
  const mismatch = traces.mismatched > 0 || decisionLogs.some(l => !l.verified || (l.replay?.differs ?? 0) > 0);
  const exitCode = traces.errors > 0 ? REPLAY_EXIT.couldNotRun : mismatch ? REPLAY_EXIT.mismatch : REPLAY_EXIT.pass;
  return { traces, decisionLogs, exitCode };
}

/** Human-readable decision-log section of a replay. */
export function formatDecisionLogReplay(log: DecisionLogReplay): string {
  const lines = [`${log.file}: decision log, ${log.records} record(s)${log.verified ? '' : ' intact before the break'}`];
  if (!log.verified) {
    lines.push(`  ✗ chain broken at line ${log.error!.line}: ${log.error!.message}`);
    return lines.join('\n');
  }
  lines.push(`  ✓ hash chain verified (head ${log.head ?? '(empty)'})`);
  const r = log.replay!;
  for (const e of r.entries.filter(x => x.status === 'differs')) {
    lines.push(`  ✗ seq ${e.seq} ${e.intent !== null ? JSON.stringify(e.intent) : e.recorded.toolId}: ${e.reason}`);
  }
  const skipped = new Map<string, number>();
  for (const e of r.entries.filter(x => x.status === 'skipped')) skipped.set(e.reason!, (skipped.get(e.reason!) ?? 0) + 1);
  for (const [reason, n] of skipped) lines.push(`  - ${n} skipped: ${reason}`);
  lines.push(`  ${r.reproduced} reproduced, ${r.differs} differ, ${r.skipped} skipped`);
  return lines.join('\n');
}
