/**
 * Decision log — an optional, durable, append-only record of every
 * resolution and dispatch a runtime makes (RuntimeOptions.decisionLog).
 *
 * One JSON object per line (JSONL). Each line records what was asked
 * (the intent, or the tool id for a dispatch by id), what the runtime
 * decided (outcome, decision code, tier, tool id), what it ran (the
 * canonical call digest; raw arguments are never recorded), the proof
 * digest, and the identity of the artifact and embedder it decided with.
 *
 * Lines are hash-chained, in the same shape as the suite's truth format
 * (stenographer spec/truth-format):
 *   - `seq` starts at 1 and increases by exactly 1 per line;
 *   - `prevHash` is the previous line's `hash` (null on seq 1, only there);
 *   - `hash` = sha256hex(UTF8(JCS(line without `hash`))), RFC 8785 JCS;
 *   - `schema` is "smallchat.decision.v1" on every line (domain separation).
 * verifyDecisionLog() checks all of that. A changed, removed, reordered
 * or inserted line breaks the chain at that line. (The chain shows that
 * the file is internally consistent; it does not stop someone from
 * rewriting the whole file — keep the head hash elsewhere to detect that.)
 *
 * replayDecisionLog() re-resolves the logged intents against a runtime
 * loaded from the same artifact and reports whether each outcome, tool id
 * and tier is reproduced. Boundary: reproduction is expected for the same
 * artifact, embedder, policy and learned state (pins, semantic map,
 * feedback) on one platform. A shortlist judge's verdict is in the line
 * (`judge`), so replay answers with it and never calls a judge; a line
 * without one replays with no judge. Decisions that rested on inputs the
 * log does not hold — an LLM verifier's answer, a decomposition, the rate
 * limiter's window — are reported as skipped, not as reproduced.
 *
 * A runtime writes the line for a dispatch before the tool executes. If a
 * line cannot be written, the call throws DecisionLogError and nothing
 * executes: nothing runs unrecorded. One writer per file — two runtimes
 * appending to the same file would fork the chain.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, fstatSync, writeSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import type { EmbedderFingerprint } from '../core/types.js';
import type { ConfidenceTier } from '../core/confidence.js';
import type { DecisionCode, ResolutionOutcome, ResolutionProof } from '../core/proof.js';
import type { JudgeRecord } from '../core/judge.js';
import { isRecordedJudgeVerdict } from '../core/judge.js';
import { canonicalJson } from '../core/jcs.js';
import { domainDigest, sha256Hex } from '../core/sha256.js';
import type { ToolRuntime } from './runtime.js';

/** `schema` value of every decision-log line. */
export const DECISION_LOG_SCHEMA = 'smallchat.decision.v1';

/** Domain-separation prefix of the intent digest. */
export const INTENT_DIGEST_DOMAIN = 'smallchat.intent.v1';

/** What kind of call a line records. */
export type DecisionKind = 'resolve' | 'dispatch' | 'dispatch-by-id';

/**
 * What happened after the decision:
 *  - none: nothing was asked to run (resolve), or the outcome refused to run anything
 *  - ran: the tool was called with arguments whose digest is `callDigest`
 *  - invalid-arguments: the arguments failed validation; nothing ran
 *  - aborted: the caller's AbortSignal fired first; nothing ran
 *  - decomposed: the intent was split; each sub-intent has its own line
 */
export type DecisionExecution = 'none' | 'ran' | 'invalid-arguments' | 'aborted' | 'decomposed';

/** One line of a decision log. */
export interface DecisionRecord {
  schema: typeof DECISION_LOG_SCHEMA;
  seq: number;
  /** ISO 8601 UTC time the line was written */
  ts: string;
  kind: DecisionKind;
  /** The intent text (omitted when the log records digests only) */
  intent?: string;
  /** intentDigest(intent), or null for a dispatch by id */
  intentDigest: string | null;
  /** DispatchOptions.principal, when the caller gave one */
  principal: string | null;
  /** contentHash of the artifact the runtime was loaded from */
  artifactHash: string | null;
  /** Fingerprint of the embedder intents were embedded with */
  embedderFingerprint: EmbedderFingerprint | null;
  outcome: ResolutionOutcome;
  decision: DecisionCode;
  tier: ConfidenceTier;
  /** Tool chosen (or named, for a dispatch by id); null when none was */
  toolId: string | null;
  /**
   * The shortlist judge's part (the proof's `judge`), present only when one
   * was consulted: name, model, verdict, toolId, probability, confidence,
   * reason, and the margin and maxCandidates it was offered near-ties with.
   */
  judge?: JudgeRecord;
  execution: DecisionExecution;
  /** Canonical call digest of the call that ran (spec/call-digest), or null */
  callDigest: string | null;
  /** proofDigest of the decision's proof */
  proofDigest: string;
  prevHash: string | null;
  hash: string;
}

/** What a runtime hands the log for one decision. */
export interface DecisionInput {
  kind: DecisionKind;
  proof: ResolutionProof;
  execution: DecisionExecution;
  principal?: string;
  /** Tool id named by the caller (dispatch by id), when the proof chose none */
  toolId?: string;
}

export interface DecisionLogOptions {
  /** File to append to (created, with its directory, if missing; mode 0600). Omit to keep lines in memory. */
  path?: string;
  /** Record the intent text next to its digest (default true). Arguments are never recorded. */
  recordIntent?: boolean;
  /** fsync the file after every line (default false) */
  fsync?: boolean;
  /** Clock for `ts` (tests) */
  now?: () => Date;
}

/** A decision log that is damaged, or a line that could not be written. */
export class DecisionLogError extends Error {
  /** 1-based line number the problem was found at, when it is about one line */
  readonly line: number | null;

  constructor(message: string, line: number | null = null) {
    super(message);
    this.name = 'DecisionLogError';
    this.line = line;
  }
}

/** sha256hex(UTF8("smallchat.intent.v1") || 0x00 || UTF8(JCS(intent))) — total for any string. */
export function intentDigest(intent: string): string {
  return domainDigest(INTENT_DIGEST_DOMAIN, canonicalJson(intent));
}

/** The `hash` of a line: sha256hex of the JCS of the line without `hash`. */
export function decisionRecordHash(record: Omit<DecisionRecord, 'hash'> | DecisionRecord): string {
  const { hash: _hash, ...body } = record as DecisionRecord;
  return sha256Hex(new TextEncoder().encode(canonicalJson(body)));
}

/**
 * An append-only, hash-chained decision log. Opening a file that already
 * has lines continues its chain after checking that the last line is
 * complete and intact (run verifyDecisionLog for the whole file).
 */
export class DecisionLog {
  /** Absolute path of the file, or null for an in-memory log */
  readonly path: string | null;
  private readonly recordIntent: boolean;
  private readonly fsync: boolean;
  private readonly now: () => Date;
  private fd: number | null = null;
  private seq = 0;
  private prevHash: string | null = null;
  private readonly memory: string[] = [];

  constructor(options: DecisionLogOptions = {}) {
    this.path = options.path ? resolvePath(options.path) : null;
    this.recordIntent = options.recordIntent ?? true;
    this.fsync = options.fsync ?? false;
    this.now = options.now ?? (() => new Date());
    if (this.path) this.openFile(this.path);
  }

  /** Sequence number and hash of the last line (seq 0 and null when empty). */
  get head(): { seq: number; hash: string | null } {
    return { seq: this.seq, hash: this.prevHash };
  }

  /** The lines written by this instance of an in-memory log. */
  lines(): string[] {
    return [...this.memory];
  }

  /** Append one decision and return the line written. Throws DecisionLogError if it cannot be written. */
  record(input: DecisionInput): DecisionRecord {
    const { proof } = input;
    const body: Omit<DecisionRecord, 'hash'> = {
      schema: DECISION_LOG_SCHEMA,
      seq: this.seq + 1,
      ts: this.now().toISOString(),
      kind: input.kind,
      ...(this.recordIntent && proof.intent !== null ? { intent: proof.intent } : {}),
      intentDigest: proof.intent !== null ? intentDigest(proof.intent) : null,
      principal: input.principal ?? null,
      artifactHash: proof.artifactHash,
      embedderFingerprint: proof.embedder,
      outcome: proof.outcome,
      decision: proof.decision,
      tier: proof.tier,
      toolId: proof.chosen ?? input.toolId ?? null,
      ...(proof.judge ? { judge: { ...proof.judge } } : {}),
      execution: input.execution,
      callDigest: input.execution === 'ran' ? proof.callDigest : null,
      proofDigest: proof.proofDigest,
      prevHash: this.prevHash,
    };
    const record: DecisionRecord = { ...body, hash: decisionRecordHash(body) };
    const line = `${JSON.stringify(record)}\n`;

    if (this.path) {
      if (this.fd === null) throw new DecisionLogError(`Decision log ${this.path} is closed`);
      try {
        writeSync(this.fd, line);
        if (this.fsync) fsyncSync(this.fd);
      } catch (err) {
        throw new DecisionLogError(`Could not append to decision log ${this.path}: ${(err as Error).message}`);
      }
    } else {
      this.memory.push(line.slice(0, -1));
    }

    this.seq = record.seq;
    this.prevHash = record.hash;
    return record;
  }

  /** Close the file. Later record() calls throw. */
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  private openFile(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'a+', 0o600);
    const last = readLastLine(this.fd);
    if (last === null) return;
    if (!last.terminated) {
      this.close();
      throw new DecisionLogError(
        `Decision log ${path} ends with an incomplete line (an interrupted write?); ` +
        'move it aside or truncate it to its last complete line before appending.',
      );
    }
    let record: DecisionRecord;
    try {
      record = checkRecordShape(JSON.parse(last.text), null);
    } catch (err) {
      this.close();
      throw new DecisionLogError(`Decision log ${path}: its last line is not a decision record (${(err as Error).message})`);
    }
    if (decisionRecordHash(record) !== record.hash) {
      this.close();
      throw new DecisionLogError(`Decision log ${path}: the hash of its last line (seq ${record.seq}) does not match its content`);
    }
    this.seq = record.seq;
    this.prevHash = record.hash;
  }
}

/** The last line of a file, and whether it ends with a newline; null when the file is empty. */
function readLastLine(fd: number): { text: string; terminated: boolean } | null {
  const size = fstatSync(fd).size;
  if (size === 0) return null;
  const chunks: Buffer[] = [];
  let position = size;
  let terminated: boolean | null = null;
  const block = 64 * 1024;
  while (position > 0) {
    const length = Math.min(block, position);
    position -= length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, position);
    let data = buffer;
    if (terminated === null) {
      terminated = data[data.length - 1] === 0x0a;
      if (terminated) data = data.subarray(0, data.length - 1);
    }
    const newline = data.lastIndexOf(0x0a);
    if (newline >= 0) {
      chunks.unshift(data.subarray(newline + 1));
      break;
    }
    chunks.unshift(data);
  }
  const text = Buffer.concat(chunks).toString('utf-8');
  return text.trim() === '' ? null : { text, terminated: terminated ?? false };
}

// ---------------------------------------------------------------------------
// Reading and verifying
// ---------------------------------------------------------------------------

const KINDS: readonly DecisionKind[] = ['resolve', 'dispatch', 'dispatch-by-id'];
const EXECUTIONS: readonly DecisionExecution[] = ['none', 'ran', 'invalid-arguments', 'aborted', 'decomposed'];

function checkRecordShape(value: unknown, line: number | null): DecisionRecord {
  const fail = (why: string): never => { throw new DecisionLogError(why, line); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('not a JSON object');
  const r = value as Record<string, unknown>;
  if (r.schema !== DECISION_LOG_SCHEMA) fail(`schema is not "${DECISION_LOG_SCHEMA}"`);
  if (!Number.isSafeInteger(r.seq) || (r.seq as number) < 1) fail('seq is not a positive integer');
  if (typeof r.ts !== 'string') fail('ts is not a string');
  if (!KINDS.includes(r.kind as DecisionKind)) fail(`unknown kind ${JSON.stringify(r.kind)}`);
  if (!EXECUTIONS.includes(r.execution as DecisionExecution)) fail(`unknown execution ${JSON.stringify(r.execution)}`);
  if (r.intent !== undefined && typeof r.intent !== 'string') fail('intent is not a string');
  for (const key of ['outcome', 'decision', 'tier', 'proofDigest', 'hash'] as const) {
    if (typeof r[key] !== 'string') fail(`${key} is not a string`);
  }
  for (const key of ['intentDigest', 'principal', 'artifactHash', 'toolId', 'callDigest', 'prevHash'] as const) {
    if (r[key] !== null && typeof r[key] !== 'string') fail(`${key} is not a string or null`);
  }
  if (r.judge !== undefined && !isRecordedJudgeVerdict(r.judge)) fail('judge is not a judge record');
  return r as unknown as DecisionRecord;
}

/** Result of verifyDecisionLog. */
export interface DecisionLogVerification {
  ok: boolean;
  /** The records read, in order (up to the first problem when !ok) */
  records: DecisionRecord[];
  /** Hash of the last verified line (null for an empty log) */
  head: string | null;
  /** The first problem found */
  error?: { line: number; message: string };
}

/**
 * Check a decision log's text line by line: every line is a decision
 * record, its hash matches its content, `seq` starts at 1 and increases by
 * one, and `prevHash` is the previous line's hash. Stops at the first
 * problem. Never throws.
 */
export function verifyDecisionLog(text: string): DecisionLogVerification {
  const records: DecisionRecord[] = [];
  let prev: DecisionRecord | null = null;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const fail = (message: string): DecisionLogVerification => ({
      ok: false,
      records,
      head: prev?.hash ?? null,
      error: { line: lineNo, message },
    });
    if (i === lines.length - 1 && !text.endsWith('\n')) return fail('incomplete last line (no trailing newline)');
    let record: DecisionRecord;
    try {
      record = checkRecordShape(JSON.parse(lines[i]), lineNo);
    } catch (err) {
      return fail(err instanceof SyntaxError ? `not JSON: ${err.message}` : (err as Error).message);
    }
    if (decisionRecordHash(record) !== record.hash) return fail(`hash does not match the line's content (seq ${record.seq})`);
    const expectedSeq = prev ? prev.seq + 1 : 1;
    if (record.seq !== expectedSeq) return fail(`seq ${record.seq} where ${expectedSeq} was expected`);
    const expectedPrev = prev ? prev.hash : null;
    if (record.prevHash !== expectedPrev) {
      return fail(prev ? `prevHash does not match the hash of seq ${prev.seq}` : 'prevHash of seq 1 is not null');
    }
    records.push(record);
    prev = record;
  }
  return { ok: true, records, head: prev?.hash ?? null };
}

/** Read and verify a decision log file; throws DecisionLogError (with the line) if it does not verify. */
export function readDecisionLog(path: string): DecisionRecord[] {
  const result = verifyDecisionLog(readFileSync(path, 'utf-8'));
  if (!result.ok) {
    throw new DecisionLogError(`${path}, line ${result.error!.line}: ${result.error!.message}`, result.error!.line);
  }
  return result.records;
}

/** Whether a parsed JSON value looks like a decision-log line (used to tell logs from trace files). */
export function isDecisionRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (value as { schema?: unknown }).schema === DECISION_LOG_SCHEMA;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** What one logged decision looks like when replayed. */
export interface DecisionReplayEntry {
  seq: number;
  kind: DecisionKind;
  intent: string | null;
  recorded: { outcome: ResolutionOutcome; decision: DecisionCode; tier: ConfidenceTier; toolId: string | null };
  /** The replayed decision (absent when skipped) */
  replayed?: { outcome: ResolutionOutcome; decision: DecisionCode; tier: ConfidenceTier; toolId: string | null; proofDigest: string };
  status: 'reproduced' | 'differs' | 'skipped';
  /** Why it differs or was skipped */
  reason?: string;
  /**
   * For 'resolve' lines: whether the replayed proofDigest equals the logged
   * one (same decision from the same inputs, step for step). Null when not
   * comparable (dispatch proofs also record validation and execution).
   */
  proofIdentical: boolean | null;
}

export interface DecisionReplayReport {
  total: number;
  reproduced: number;
  differs: number;
  skipped: number;
  entries: DecisionReplayEntry[];
}

/**
 * Re-decide every logged intent against `runtime` (resolve only, learning
 * off — nothing executes and the runtime learns nothing) and compare the
 * outcome, tool id and tier with what was logged. A line's recorded judge
 * verdict answers in the judge's place; no judge is ever called. Lines
 * recorded against another artifact or embedder, digest-only lines (no
 * intent text), and decisions that rested on inputs the log does not hold
 * (LLM verifier, decomposition, rate limiter) are skipped with the reason.
 */
export async function replayDecisionLog(
  runtime: ToolRuntime,
  records: readonly DecisionRecord[],
): Promise<DecisionReplayReport> {
  const entries: DecisionReplayEntry[] = [];
  const artifactHash = runtime.context.artifactHash;
  const fingerprint = runtime.context.embedder.fingerprint ?? null;
  const hasVerifier = typeof runtime.context.llmClient.microCheck === 'function';

  for (const record of records) {
    const base = {
      seq: record.seq,
      kind: record.kind,
      intent: record.intent ?? null,
      recorded: { outcome: record.outcome, decision: record.decision, tier: record.tier, toolId: record.toolId },
      proofIdentical: null,
    };
    const skip = (reason: string): void => { entries.push({ ...base, status: 'skipped', reason }); };

    if (record.artifactHash !== artifactHash) {
      skip(`recorded against artifact ${short(record.artifactHash)}, replaying ${short(artifactHash)}`);
      continue;
    }
    if (record.kind !== 'dispatch-by-id' && canonicalJson(record.embedderFingerprint) !== canonicalJson(fingerprint)) {
      skip('recorded with a different embedder');
      continue;
    }

    if (record.kind === 'dispatch-by-id') {
      const known = record.toolId !== null && runtime.getTool(record.toolId) !== undefined;
      const outcome: ResolutionOutcome = known ? 'resolved' : 'unresolved';
      const replayed = { outcome, decision: (known ? 'exact-id' : 'unknown-tool') as DecisionCode, tier: (known ? 'exact' : 'none') as ConfidenceTier, toolId: record.toolId, proofDigest: '' };
      const same = outcome === record.outcome;
      entries.push({ ...base, replayed, status: same ? 'reproduced' : 'differs', ...(same ? {} : { reason: `${record.toolId} is ${known ? 'now' : 'no longer'} a registered tool` }) });
      continue;
    }

    if (record.intent === undefined || record.intentDigest === null) {
      skip('the log records only the intent digest (recordIntent: false)');
      continue;
    }
    if (intentDigest(record.intent) !== record.intentDigest) {
      entries.push({ ...base, status: 'differs', reason: 'intent text does not match intentDigest' });
      continue;
    }
    if (record.outcome === 'throttled') { skip('throttled by the rate limiter (depends on its window)'); continue; }
    if (record.decision === 'decomposed') { skip('decomposed by the LLM client (its answer is not recorded)'); continue; }
    if (record.decision === 'llm-verified' && !hasVerifier) { skip('approved by an LLM verifier (its answer is not recorded)'); continue; }
    if ((record.decision === 'judge-approved' || record.decision === 'judge-declined') && !record.judge) {
      skip('decided by a shortlist judge whose verdict the line does not record');
      continue;
    }

    const resolution = await runtime.resolve(record.intent, {
      learn: false,
      judge: record.judge ?? false,
      ...(record.principal !== null ? { principal: record.principal } : {}),
    });
    const replayed = {
      outcome: resolution.outcome,
      decision: resolution.proof.decision,
      tier: resolution.tier,
      toolId: resolution.chosen ?? null,
      proofDigest: resolution.proof.proofDigest,
    };
    const differences: string[] = [];
    if (replayed.outcome !== record.outcome) differences.push(`outcome ${record.outcome} → ${replayed.outcome}`);
    if (replayed.toolId !== record.toolId) differences.push(`tool ${record.toolId ?? 'none'} → ${replayed.toolId ?? 'none'}`);
    if (replayed.tier !== record.tier) differences.push(`tier ${record.tier} → ${replayed.tier}`);
    entries.push({
      ...base,
      replayed,
      status: differences.length === 0 ? 'reproduced' : 'differs',
      ...(differences.length > 0 ? { reason: `${differences.join(', ')} (logged decision: ${record.decision})` } : {}),
      proofIdentical: record.kind === 'resolve' ? replayed.proofDigest === record.proofDigest : null,
    });
  }

  return {
    total: entries.length,
    reproduced: entries.filter(e => e.status === 'reproduced').length,
    differs: entries.filter(e => e.status === 'differs').length,
    skipped: entries.filter(e => e.status === 'skipped').length,
    entries,
  };
}

function short(hash: string | null): string {
  return hash ? `${hash.slice(0, 12)}…` : '(none)';
}
