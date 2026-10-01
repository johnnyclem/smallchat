/**
 * PROPOSAL streams — @shorthand/core's only write path toward the ledger.
 *
 * Proposals go out in the suite's single PROPOSAL envelope
 * (spec/truth-format, "The PROPOSAL envelope"):
 *
 *   {schemaVersion: 2, seq, id, type: "PROPOSAL", ts, author, kind: "tb"|"uv",
 *    draft, targetRef, signal: {source, detail?}, agentSessionId, prevHash, hash}
 *
 * A proposals file is one writer's hash-chained stream, like a wiki file:
 * `ProposalStream` assigns `seq`, `prevHash` and `hash`, and
 * `appendProposalsFile` only appends to a file that is a valid run of its
 * stream, in one write. Duplicates are recognized by (kind, targetRef,
 * normalized claim or assertion), so a corrected value is proposed again
 * while a repeated round files nothing (SAT-10). An id names one envelope:
 * stenographer's intake files a line once by its id and refuses a different
 * envelope under an id it filed, so neither writes one.
 *
 * The pre-1.0 bare short-hand line (`{kind: "tombstone", draft, signal,
 * targetRef?}`) and the `shorthand-compaction` source are read
 * (`parseProposalLines`) but never written.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { canonicalize } from './jcs.js';
import {
  TRUTH_SCHEMA_VERSION,
  TruthLineError,
  checkTruthChain,
  decodeTruthLine,
  literalIssue,
  truthLineHash,
  type DecodedTruthLine,
  type StreamHead,
} from './format.js';
import { assertAccountableAuthor } from './identity.js';
import type { ProposalLine, WrittenProposalLine } from './types.js';

/** The detector identity short-hand's compaction candidates are usually filed under (stenographer's default for this seam). */
export const COMPACTION_DETECTOR = 'detector:short-hand';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Why a proposal's draft can't be filed, or null. A `tb` draft needs a
 * claim and at least one piece of evidence (and valid literals); a `uv`
 * draft needs an assertion, a basis and a verifyBy hint.
 */
export function proposalDraftIssue(proposal: Pick<ProposalLine, 'kind' | 'draft'>): string | null {
  const draft = proposal.draft as unknown;
  if (!isObject(draft)) return 'draft must be an object';
  if (proposal.kind === 'tb') {
    if (!nonEmpty(draft.claim)) return 'a tb draft needs a claim';
    if (!Array.isArray(draft.evidence) || draft.evidence.length === 0) return 'a tb draft needs at least one piece of evidence';
    for (const e of draft.evidence) {
      if (!isObject(e) || !nonEmpty(e.kind) || !nonEmpty(e.ref)) return 'evidence is {kind, ref, detail?}';
    }
    if (draft.literals !== undefined) {
      if (!Array.isArray(draft.literals) || draft.literals.length === 0) return 'omit literals rather than send none';
      for (const l of draft.literals) {
        const issue = literalIssue(l, 2);
        if (issue) return issue;
      }
    }
    return null;
  }
  if (proposal.kind === 'uv') {
    if (!nonEmpty(draft.assertion)) return 'a uv draft needs an assertion';
    if (!nonEmpty(draft.basis)) return 'a uv draft needs a basis';
    if (!isObject(draft.verifyBy) || !nonEmpty(draft.verifyBy.kind) || !nonEmpty(draft.verifyBy.value)) {
      return 'a uv draft needs verifyBy {kind, value}';
    }
    return null;
  }
  return `kind is 'tb' or 'uv' (got ${JSON.stringify(proposal.kind)})`;
}

/** The envelope `ProposalStream.append` writes for a proposal, without its chain fields. */
function envelopeOf(proposal: ProposalLine) {
  return {
    schemaVersion: TRUTH_SCHEMA_VERSION,
    id: proposal.id,
    type: 'PROPOSAL' as const,
    ts: proposal.ts,
    author: proposal.author,
    kind: proposal.kind,
    draft: proposal.draft,
    targetRef: proposal.targetRef ?? null,
    signal: proposal.signal,
    agentSessionId: proposal.agentSessionId ?? null,
  };
}

/**
 * What an envelope is compared by when its id comes back: its JCS form
 * without `seq`, `prevHash` and `hash`, so the same envelope at another
 * place in another stream is the same envelope (stenographer's intake rule).
 */
function envelopeKey(line: Record<string, unknown>): string {
  const { seq: _seq, prevHash: _prev, hash: _hash, ...envelope } = line;
  return canonicalize(envelope);
}

function idConflict(id: string): string {
  return `proposal ${id}: a different envelope already has this id — an id names one envelope, and stenographer's intake refuses a second one`;
}

/**
 * One writer's hash-chained PROPOSAL stream. `append` writes the envelope
 * exactly as the spec gives it — nothing else — and checks the result with
 * the same codec readers use.
 */
export class ProposalStream {
  private seq: number;
  private prevHash: string | null;
  /** The envelope each id names, for the lines this stream wrote or (`resume`) read. */
  private readonly envelopes = new Map<string, string>();

  /** A stream continuing from `head` (the last line written), or a new one. */
  constructor(head: StreamHead | null = null) {
    this.seq = head?.seq ?? 0;
    this.prevHash = head?.hash ?? null;
  }

  /**
   * Continue the stream a proposals file holds. Throws `TruthLineError`
   * when the lines are not one valid stream from seq 1 — a refused line, a
   * broken chain, a bare pre-1.0 line, or a run that starts part-way — so a
   * file is never extended into something readers refuse.
   */
  static resume(input: string | string[]): ProposalStream {
    const parsed = parseProposalLines(input);
    const stream = streamFor(parsed);
    for (const p of parsed.proposals) stream.envelopes.set(p.id!, envelopeKey(JSON.parse(p.text) as Record<string, unknown>));
    return stream;
  }

  /** The last line written, or null for an empty stream. */
  get head(): StreamHead | null {
    return this.prevHash === null ? null : { seq: this.seq, hash: this.prevHash };
  }

  /**
   * Chain one proposal into the stream; returns the line as written. Throws
   * when the stream already gave its id a different envelope. The same
   * envelope again is written again as a new line (stenographer's intake
   * files it once); `appendProposalsFile` is the writer that skips it.
   */
  append(proposal: ProposalLine): WrittenProposalLine {
    assertAccountableAuthor(proposal.author);
    const issue = proposalDraftIssue(proposal);
    if (issue) throw new TypeError(`proposal ${proposal.id}: ${issue}`);
    const envelope = envelopeOf(proposal);
    const key = canonicalize(envelope);
    const named = this.envelopes.get(proposal.id);
    if (named !== undefined && named !== key) throw new TruthLineError(idConflict(proposal.id));
    const { schemaVersion, ...body } = envelope;
    const unhashed = { schemaVersion, seq: this.seq + 1, ...body, prevHash: this.prevHash };
    const line = { ...unhashed, hash: truthLineHash(unhashed) } as WrittenProposalLine;
    decodeTruthLine(JSON.stringify(line)); // the line readers will see: refuse it here rather than there
    this.seq = line.seq;
    this.prevHash = line.hash;
    this.envelopes.set(proposal.id, key);
    return line;
  }
}

function streamFor(parsed: ProposalParseResult): ProposalStream {
  const fix = 'write to a new proposals file instead';
  if (parsed.errors.length > 0) {
    const e = parsed.errors[0];
    throw new TruthLineError(`line ${e.line}: ${e.error} — this file is not one valid proposals stream; ${fix}`);
  }
  const bare = parsed.proposals.find((p) => p.version === 'bare');
  if (bare) {
    throw new TruthLineError(
      `line ${bare.line} is a pre-1.0 bare proposal (read-only since @shorthand/core 1.0), so the file is not a proposals stream; ${fix}`,
    );
  }
  const first = parsed.proposals[0];
  if (first && first.seq !== 1) {
    throw new TruthLineError(`its first line is seq ${first.seq}, not 1: the file holds part of a stream; ${fix}`);
  }
  return new ProposalStream(parsed.head);
}

/**
 * Chain proposals into JSONL lines (no trailing newline), starting a new
 * stream or continuing from `head`. Use `appendProposalsFile` to extend a
 * file: it checks the file and dedupes.
 */
export function serializeProposals(proposals: ProposalLine[], options: { head?: StreamHead | null } = {}): string[] {
  const stream = new ProposalStream(options.head ?? null);
  return proposals.map((p) => JSON.stringify(stream.append(p)));
}

function normalizedText(text: unknown): string {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What makes two proposals the same: kind, targetRef and the normalized
 * claim (tb) or assertion (uv). A new value for the same target is a new
 * proposal; the same one again is a duplicate.
 */
export function proposalDedupeKey(proposal: { kind: string; targetRef?: string | null; draft: unknown }): string {
  const kind = proposal.kind === 'tombstone' ? 'tb' : proposal.kind;
  const draft = (isObject(proposal.draft) ? proposal.draft : {}) as Record<string, unknown>;
  return canonicalize([kind, proposal.targetRef ?? null, normalizedText(kind === 'tb' ? draft.claim : draft.assertion)]);
}

/**
 * Append proposals to a proposals file (created if absent) as the next
 * lines of its stream, in one write, skipping any the file already holds
 * (or that repeat within the batch): the same envelope under its id, or
 * the same `proposalDedupeKey`. Throws, leaving the file untouched, when
 * the file is not one valid proposals stream (for example a pre-1.0 file
 * of bare lines), or when a proposal reuses an id the file or the batch
 * gives a different envelope.
 */
export function appendProposalsFile(
  path: string,
  proposals: ProposalLine[],
): { written: number; skipped: number; head: StreamHead | null } {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const parsed = parseProposalLines(existing);
  const stream = streamFor(parsed);
  const seen = new Set(parsed.proposals.map(proposalDedupeKey));
  const envelopes = new Map(parsed.proposals.map((p) => [p.id!, envelopeKey(JSON.parse(p.text) as Record<string, unknown>)]));

  const fresh: string[] = [];
  let skipped = 0;
  for (const proposal of proposals) {
    // An id names one envelope: checked before the dedupe, which would hide a reused id
    const envelope = canonicalize(envelopeOf(proposal));
    const named = envelopes.get(proposal.id);
    if (named !== undefined && named !== envelope) throw new TruthLineError(`${idConflict(proposal.id)}; nothing was written`);
    const key = proposalDedupeKey(proposal);
    if (named !== undefined || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    envelopes.set(proposal.id, envelope);
    fresh.push(JSON.stringify(stream.append(proposal)));
  }
  if (fresh.length > 0) {
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(path, separator + fresh.map((l) => l + '\n').join(''));
  }
  return { written: fresh.length, skipped, head: stream.head };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** One proposal line, read. */
export interface ParsedProposal {
  /** 2: the suite envelope, hash-chained. 'bare': a pre-1.0 short-hand or smallchat line (read-only). */
  version: 2 | 'bare';
  /** 'tb' or 'uv' ('tombstone' is read as 'tb'); an unknown kind is kept as written. */
  kind: 'tb' | 'uv' | (string & {});
  draft: Record<string, unknown>;
  targetRef: string | null;
  signal: { source: string; [key: string]: unknown };
  /** Null on a bare line, which had none. */
  author: string | null;
  id: string | null;
  ts: string | null;
  agentSessionId: string | null;
  /** v2 only. */
  seq: number | null;
  hash: string | null;
  /** 1-based line number (blank lines count). */
  line: number;
  /** The line exactly as read. */
  text: string;
}

export interface ProposalParseResult {
  /** Empty when the stream was refused. */
  proposals: ParsedProposal[];
  errors: Array<{ line: number; error: string }>;
  /** True when a v2 stream had a refused line or a broken chain: nothing in it is read. */
  refused: boolean;
  /** The last v2 line. */
  head: StreamHead | null;
}

function bare(raw: Record<string, unknown>, line: number, text: string): ParsedProposal {
  const kind = raw.kind === 'tombstone' ? 'tb' : raw.kind;
  if (kind !== 'tb' && kind !== 'uv') throw new TruthLineError(`kind: a bare proposal is 'tombstone' or 'uv' (got ${JSON.stringify(raw.kind)})`);
  if (!isObject(raw.draft)) throw new TruthLineError('draft: must be an object');
  if (!isObject(raw.signal) || !nonEmpty(raw.signal.source)) throw new TruthLineError('signal: must be an object with a source');
  if (raw.targetRef !== undefined && raw.targetRef !== null && typeof raw.targetRef !== 'string') {
    throw new TruthLineError('targetRef: must be a string or null');
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    version: 'bare',
    kind,
    draft: raw.draft,
    targetRef: str(raw.targetRef),
    signal: raw.signal as ParsedProposal['signal'],
    author: str(raw.author),
    id: str(raw.id),
    ts: str(raw.ts),
    agentSessionId: str(raw.agentSessionId),
    seq: null,
    hash: null,
    line,
    text,
  };
}

/**
 * Read a proposals file: suite envelope lines (validated, hash-checked,
 * chained) and, as read-only compatibility, bare pre-1.0 lines.
 */
export function parseProposalLines(input: string | string[]): ProposalParseResult {
  const raw = Array.isArray(input) ? input : input.split('\n');
  const proposals: ParsedProposal[] = [];
  const errors: ProposalParseResult['errors'] = [];
  const chained: Array<{ line: number; d: DecodedTruthLine | null }> = [];

  for (let i = 0; i < raw.length; i++) {
    const text = raw[i];
    if (text.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      errors.push({ line: i + 1, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` });
      chained.push({ line: i + 1, d: null });
      continue;
    }
    try {
      if (isObject(parsed) && parsed.schemaVersion === undefined) {
        proposals.push(bare(parsed, i + 1, text));
        continue;
      }
      const d = decodeTruthLine(text);
      if (d.type !== 'PROPOSAL') throw new TruthLineError(`a ${d.type} line is not a proposal`);
      chained.push({ line: i + 1, d });
      const l = d.line;
      proposals.push({
        version: 2,
        kind: l.kind as string,
        draft: l.draft as Record<string, unknown>,
        targetRef: l.targetRef as string | null,
        signal: l.signal as ParsedProposal['signal'],
        author: l.author as string,
        id: l.id as string,
        ts: l.ts as string,
        agentSessionId: (l.agentSessionId as string | null | undefined) ?? null,
        seq: d.seq,
        hash: d.hash,
        line: i + 1,
        text,
      });
    } catch (err) {
      errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err) });
      chained.push({ line: i + 1, d: null });
    }
  }
  const v2 = chained.length > 0;
  if (v2) {
    // A proposals stream holds only envelope lines: bare lines in it were not written by its writer
    for (const p of proposals.filter((p) => p.version === 'bare')) {
      errors.push({ line: p.line, error: 'a bare pre-1.0 proposal inside a proposals stream: the file is not one writer’s stream' });
    }
  }
  for (const { index, error } of checkTruthChain(chained.map((c) => c.d))) errors.push({ line: chained[index].line, error });
  errors.sort((a, b) => a.line - b.line);

  if (errors.length > 0 && v2) return { proposals: [], errors, refused: true, head: null };
  const last = [...proposals].reverse().find((p) => p.version === 2);
  return { proposals, errors, refused: false, head: last ? { seq: last.seq!, hash: last.hash! } : null };
}
