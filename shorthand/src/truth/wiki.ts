/**
 * Truth Ledger Interop — reading truth streams, and consumption-rule selection
 *
 * Reads stenographer's truth format v2 (spec/truth-format): one writer's
 * hash-chained JSONL stream of TB and UV entry lines, the ADDENDUM and
 * RULING lines that cause status changes, and a TRANSITION line for every
 * change. Version 1 lines (stenographer 0.x: no chain, a `status` field,
 * later lines for an id superseding earlier ones) are still read.
 *
 * - **Status is a fold.** An entry's current status is the status of the
 *   highest-seq TRANSITION that targets it, else the entry line's own —
 *   among the TRANSITIONs a reader honours. Overridden and struck TBs, and
 *   verified, refuted and struck UVs, are final: a later TRANSITION can
 *   only move them up the lattice. With a signer registry, a TRANSITION by
 *   someone it doesn't list is not honoured either (both are `held`). A
 *   TRANSITION's `cause.ref` must name an earlier line of the stream.
 * - **Incremental reads** pass the earlier result as `base`: the increment
 *   folds into it as one stream.
 * - **Fail closed.** A missing or unknown status means not current truth;
 *   the line is kept as history and written back verbatim. A v2 stream
 *   with any refused line (bad hash, identity, structure) or a broken
 *   chain is refused whole: a dropped TRANSITION must never revive a
 *   struck TB.
 * - **Admission.** An unsigned TB is never truth on its own; a v1 TB has no
 *   hash and is unverifiable (unless the host opts in); with a signer
 *   registry, unlisted authors and signers are unverifiable; a TB an agent
 *   signed is truth only with a quorum whose members are all agents (the
 *   codec has checked the quorum's rules), and never when it cites an
 *   evidence kind or carries a link type this version doesn't know (the
 *   rules don't refuse one, so nothing shows two settling angles); two
 *   lines giving one id different content, unknown fields included, are a
 *   conflict.
 * - **Never rewrite.** Unknown fields and values are kept, never coerced,
 *   and a parsed entry serializes back to the exact line it was read from.
 * - **Several files** (one per teammate) fold one by one, then each entry
 *   takes the most advanced status on the lattice TB
 *   `active < contested < overridden < struck`, UV
 *   `open < verified < refuted < struck`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalize } from './jcs.js';
import {
  LINK_TYPES,
  TRUTH_STATUSES,
  TruthLineError,
  checkTruthChain,
  decodeTruthLine,
  literalIssue,
  type DecodedTruthLine,
  type StreamHead,
  type TruthLineType,
} from './format.js';
import {
  createSignerRegistry,
  type TruthSigner,
  type TruthSignerFile,
  type TruthSignerRegistry,
} from './identity.js';
import { AGENT_PREFIX, hasAgentPrefix } from './quorum.js';
import { EVIDENCE_KINDS } from './types.js';
import type {
  ConsumptionAction,
  TruthEvidence,
  TruthInadmissible,
  TruthLedgerEntry,
  TruthQuorumMember,
  TruthSelection,
  TruthTbEntry,
  TruthTombstonedLiteral,
  TruthTransition,
  TruthUvEntry,
  TruthVerifyBy,
  WikiEntryLine,
} from './types.js';

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface TruthReadOptions {
  /**
   * Whose entries count, in stenographer's signers.json shape (or a list,
   * or a registry). With one, a TB is truth only when its author and signer
   * are listed (as a person or an agent), and a UV only when its author is;
   * an agent is an identity it lists with role `agent`. Without one, any
   * identity that passes the identity rules is accepted, and an agent is an
   * identity whose key starts with `agent:`. Either way, a TB an agent
   * signed is truth only with a quorum whose members are all agents, citing
   * only evidence kinds this version knows.
   */
  signers?: TruthSignerFile | TruthSigner[] | TruthSignerRegistry | null;
  /**
   * Take version 1 TBs as truth. Off by default: a v1 line carries no hash,
   * so nothing shows it is the line stenographer wrote (stenographer itself
   * files them for a person to sign). Turn on only to read a 0.x export.
   */
  admitV1Tbs?: boolean;
  /**
   * The head of the stream as last read (`result.head`). The input must
   * continue it or still hold it, which is how a reader notices lines
   * removed from the end or a rewritten stream; an input with no version 2
   * line (an empty one, or one rewritten as version 1 lines) is refused.
   * Without `base`, the result holds only the input's entries: a check that
   * a chunk continues the stream, not a fold of the whole stream.
   */
  previous?: StreamHead | null;
  /**
   * The read this input continues: an earlier `parseWikiLines` result (one
   * stream, not a `parseWikiFiles` merge). The result is the whole stream
   * so far — the base's lines, then the input's, folded as one — so the
   * input's TRANSITIONs apply to the base's entries. Keep it and pass it as
   * the next `base`. The whole stream is admitted again with this call's
   * options, so pass the same `signers` and `admitV1Tbs` as the base read.
   * `previous` defaults to `base.head`; an empty input is the base again. A
   * refused base refuses the read. Line numbers count within the input each
   * line was read from.
   */
  base?: WikiParseResult | null;
}

/** One line of the input, as read. */
export interface TruthLineRecord {
  /** 1-based line number (blank lines count). */
  line: number;
  /** The line exactly as read. */
  text: string;
  version: 1 | 2;
  type: TruthLineType;
  id: string;
  seq: number | null;
  hash: string | null;
  file?: string;
}

export interface WikiParseResult {
  /**
   * TB and UV entries in order of first appearance, each with its folded
   * status. Empty when the stream was refused.
   */
  entries: TruthLedgerEntry[];
  /**
   * Refused lines and chain breaks, by line (line 0: the input as a whole).
   * With a v2 stream, any of them refuses it.
   */
  errors: Array<{ line: number; error: string; id?: string; file?: string }>;
  /** True when the input was refused: nothing it says is truth. */
  refused: boolean;
  /** Every TRANSITION read, in order, including ones whose target is not in the input (a partial stream). */
  transitions: TruthTransition[];
  /**
   * TRANSITIONs read but not honoured, with the reason: one that would move
   * a final status (TB overridden or struck; UV verified, refuted or struck)
   * back down the lattice, or, with a signer registry, one whose author it
   * doesn't list. They change no status; the lines are kept in `lines`.
   */
  held: Array<{ line: number; id: string; reason: string; file?: string }>;
  /** Every line read, verbatim — the whole stream, to write back or forward. Empty when refused. */
  lines: TruthLineRecord[];
  /** The last v2 line read: keep it and pass it as `previous` next time. */
  head: StreamHead | null;
  /** Ids two lines (or two files) gave different content (unknown fields included). Those entries are not truth. */
  conflicts: Array<{ id: string; files: string[] }>;
}

// ---------------------------------------------------------------------------
// Line ↔ entry conversion
// ---------------------------------------------------------------------------

/**
 * Stenographer's rule for a tombstoned literal as a version 1 line states
 * it: every present field a non-blank string, and without a `subject`,
 * `dead` must be a distinctive identifier (≥4 chars, contains a letter).
 * Returns the reason it's invalid, or null. (Version 2 lines also refuse
 * surrounding whitespace.)
 */
export function literalValidationError(literal: unknown): string | null {
  return literalIssue(literal, 1);
}

/** Keys the codec maps to typed fields; anything else rides in `extra`. */
const TB_KEYS = new Set(['id', 'type', 'ts', 'author', 'claim', 'evidence', 'signedBy', 'literals', 'quorum', 'status', 'x-steno']);
const UV_KEYS = new Set(['id', 'type', 'ts', 'author', 'assertion', 'basis', 'verifyBy', 'contests', 'status', 'x-steno']);

function extraKeys(line: Record<string, unknown>, known: Set<string>): Record<string, unknown> | undefined {
  const unknown = Object.entries(line).filter(([key]) => !known.has(key));
  // fromEntries defines each key as an own field, so even a `__proto__` field stays one
  return unknown.length > 0 ? Object.fromEntries(unknown) : undefined;
}

/** A v2 line's chain fields: where the line sits in its writer's stream, not what the entry says. */
const CHAIN_KEYS = new Set(['schemaVersion', 'seq', 'prevHash', 'hash']);

function entryOf(d: DecodedTruthLine, lineNo: number, file?: string): TruthLedgerEntry {
  const line = d.line;
  const lineStatus = typeof line.status === 'string' ? line.status : null;
  const source = {
    version: d.version,
    text: d.text,
    line: lineNo,
    seq: d.seq,
    hash: d.hash,
    lineStatus,
    ...(file !== undefined ? { file } : {}),
  };
  const xSteno = line['x-steno'] as Record<string, unknown> | undefined;

  if (d.type === 'TB') {
    // Version 1 'command' evidence is read as claimed-command: stenographer never ran it
    const evidence = (line.evidence as TruthEvidence[]).map((e) =>
      d.version === 1 && e.kind === 'command' ? { ...e, kind: 'claimed-command' } : e,
    );
    const entry: TruthTbEntry = {
      id: line.id as string,
      type: 'TB',
      ts: line.ts as string,
      author: line.author as string,
      claim: line.claim as string,
      evidence,
      signedBy: (line.signedBy as string | null | undefined) ?? null,
      status: lineStatus,
    };
    if (Array.isArray(line.literals) && line.literals.length > 0) entry.literals = line.literals as TruthTombstonedLiteral[];
    if (Array.isArray(line.quorum)) entry.quorum = line.quorum as TruthQuorumMember[];
    if (xSteno !== undefined) entry.xSteno = xSteno;
    const extra = extraKeys(line, TB_KEYS);
    if (extra) entry.extra = extra;
    entry.source = source;
    return entry;
  }

  const entry: TruthUvEntry = {
    id: line.id as string,
    type: 'UV',
    ts: line.ts as string,
    author: line.author as string,
    assertion: line.assertion as string,
    basis: line.basis as string,
    verifyBy: line.verifyBy as TruthVerifyBy,
    contests: (line.contests as string | null | undefined) ?? null,
    status: lineStatus,
  };
  if (xSteno !== undefined) entry.xSteno = xSteno;
  const extra = extraKeys(line, UV_KEYS);
  if (extra) entry.extra = extra;
  entry.source = source;
  return entry;
}

function transitionOf(d: DecodedTruthLine, lineNo: number, file?: string): TruthTransition {
  const line = d.line;
  const cause = line.cause as { kind: string; ref: string | null };
  return {
    id: line.id as string,
    seq: d.seq!,
    ts: line.ts as string,
    author: line.author as string,
    target: line.target as string,
    status: line.status as string,
    cause: { kind: cause.kind, ref: cause.ref },
    line: lineNo,
    ...(file !== undefined ? { file } : {}),
  };
}

/**
 * What two copies of one entry must agree on, compared as JCS bytes (key
 * order never matters): its fields, unknown ones included (stenographer's
 * Importing rules 2 and 10). The chain fields differ between two writers'
 * copies of one entry, and `x-steno` is each ledger's own record, so
 * neither counts.
 */
function bodyKey(e: TruthLedgerEntry): string {
  const unknown = Object.entries(e.extra ?? {}).filter(([key]) => !CHAIN_KEYS.has(key));
  const extra = unknown.length > 0 ? Object.fromEntries(unknown) : null;
  return canonicalize(
    e.type === 'TB'
      ? { type: e.type, author: e.author, claim: e.claim, evidence: e.evidence, signedBy: e.signedBy, literals: e.literals ?? null, quorum: e.quorum ?? null, extra }
      : { type: e.type, author: e.author, assertion: e.assertion, basis: e.basis, verifyBy: e.verifyBy, contests: e.contests, extra },
  );
}

/**
 * Convert one TB or UV line (an object or its JSON text) to a typed entry,
 * validating it as `decodeTruthLine` does and applying the admission rules
 * that need no other line. Throws `TruthLineError` on a line a reader must
 * refuse, or one that is not a TB or UV.
 */
export function wikiLineToEntry(line: WikiEntryLine | string, options: TruthReadOptions = {}): TruthLedgerEntry {
  const text = typeof line === 'string' ? line : JSON.stringify(line);
  const d = decodeTruthLine(text);
  if (d.type !== 'TB' && d.type !== 'UV') throw new TruthLineError(`a ${d.type} line is not an entry (TB or UV)`);
  const entry = entryOf(d, 1);
  admit(entry, { conflict: null, verifiable: d.version === 2 }, options, registryOf(options));
  return entry;
}

/**
 * The wire line for an entry. An entry read from a stream gives back the
 * line it was read from, never a rewrite (its `status` may have been folded
 * from a later TRANSITION; the line's own does not change). An entry built
 * by hand is written in the version 1 shape, which carries no quorum: one
 * whose `quorum` (or an `extra` field of that name) is set throws
 * `TruthLineError` rather than give a line every reader refuses. Only a
 * version 2 line carries a quorum, and only stenographer writes those.
 */
export function entryToWikiLine(entry: TruthLedgerEntry): WikiEntryLine {
  if (entry.source) return JSON.parse(entry.source.text) as WikiEntryLine;
  const base = { id: entry.id, type: entry.type, ts: entry.ts, author: entry.author };
  const status = entry.status === null ? {} : { status: entry.status };

  if (entry.type === 'TB') {
    const line: WikiEntryLine = {
      ...base,
      claim: entry.claim,
      evidence: entry.evidence,
      signedBy: entry.signedBy,
      // Only present when given, so literal-free TBs keep their exact shape
      ...(entry.literals && entry.literals.length > 0 ? { literals: entry.literals } : {}),
      ...(entry.quorum ? { quorum: entry.quorum } : {}),
      ...status,
    };
    if (entry.xSteno !== undefined) line['x-steno'] = entry.xSteno;
    return versionOneLine(entry, entry.extra ? { ...entry.extra, ...line } : line);
  }

  const line: WikiEntryLine = {
    ...base,
    assertion: entry.assertion,
    basis: entry.basis,
    verifyBy: entry.verifyBy,
    contests: entry.contests,
    ...status,
  };
  if (entry.xSteno !== undefined) line['x-steno'] = entry.xSteno;
  return versionOneLine(entry, entry.extra ? { ...entry.extra, ...line } : line);
}

/** The version 1 line an entry built by hand is written as; a v1 line carries no quorum (the codec refuses one). */
function versionOneLine(entry: TruthLedgerEntry, line: WikiEntryLine): WikiEntryLine {
  if (line.quorum !== undefined) {
    throw new TruthLineError(
      `quorum: ${entry.type} ${entry.id} was built by hand, so it is written as a version 1 line, and a v1 line carries no quorum: ` +
        'agents settle claims together only on v2 lines, which stenographer writes',
    );
  }
  return line;
}

// ---------------------------------------------------------------------------
// Reading a stream
// ---------------------------------------------------------------------------

interface FileRead {
  entries: Map<string, TruthLedgerEntry>;
  conflicts: Map<string, string>;
  transitions: TruthTransition[];
  held: WikiParseResult['held'];
  errors: WikiParseResult['errors'];
  refused: boolean;
  lines: TruthLineRecord[];
  head: StreamHead | null;
}

interface Item {
  line: number;
  d: DecodedTruthLine | null;
}

/** Statuses that never change again, except up the lattice (a strike after an override). */
const FINAL_STATUSES: Record<'TB' | 'UV', readonly string[]> = { TB: ['overridden', 'struck'], UV: ['verified', 'refuted', 'struck'] };

/** A line of an earlier read, decoded again without re-checking what that read checked. */
function redecode(record: TruthLineRecord): DecodedTruthLine {
  const line = JSON.parse(record.text) as Record<string, unknown>;
  return {
    version: record.version,
    type: record.type,
    line,
    text: record.text,
    seq: record.seq,
    prevHash: record.version === 2 ? (line.prevHash as string | null) : null,
    hash: record.hash,
  };
}

function refusedRead(errors: WikiParseResult['errors']): FileRead {
  return { entries: new Map(), conflicts: new Map(), transitions: [], held: [], errors, refused: true, lines: [], head: null };
}

function readFile(input: string | string[], options: TruthReadOptions, file?: string): FileRead {
  const raw = Array.isArray(input) ? input : input.split('\n');
  const tag = file !== undefined ? { file } : {};
  const base = options.base ?? null;
  if (base?.refused) return refusedRead([{ line: 0, error: 'the base read was refused: there is no stream to continue', ...tag }]);
  if (base?.lines.some((l) => l.file !== undefined)) {
    return refusedRead([{ line: 0, error: 'the base is a merge of several files (parseWikiFiles): an increment continues one stream', ...tag }]);
  }
  const previous = options.previous ?? base?.head ?? null;

  // The base's lines were checked when it was read; they come first in the stream
  const baseItems: Item[] = (base?.lines ?? []).map((record) => ({ line: record.line, d: redecode(record) }));
  const items: Item[] = [];
  const errors: WikiParseResult['errors'] = [...(base?.errors ?? [])];
  // A stream read before as v2 (a head) stays one: a version 1 line can't continue it
  let v2 = previous !== null || baseItems.some((i) => i.d!.version === 2);

  for (let i = 0; i < raw.length; i++) {
    const text = raw[i];
    if (text.trim().length === 0) continue;
    try {
      const d = decodeTruthLine(text);
      if (d.version === 2) v2 = true;
      if (d.type === 'PROPOSAL') {
        throw new TruthLineError('a PROPOSAL line belongs in a proposals file (parseProposalLines), not a truth stream');
      }
      items.push({ line: i + 1, d });
    } catch (err) {
      items.push({ line: i + 1, d: null });
      const declared = declaredVersion(text);
      if (declared !== undefined && declared !== 1) v2 = true;
      errors.push({ line: i + 1, error: err instanceof Error ? err.message : String(err), ...idOf(text), ...tag });
    }
  }
  const all = [...baseItems, ...items];
  if (v2) {
    // One writer's v2 stream holds only v2 lines: a version 1 line in it was not written by that writer
    for (const item of all) {
      if (item.d?.version !== 1) continue;
      errors.push({
        line: item.line,
        error: 'a version 1 line inside a version 2 stream: the file is not one writer’s stream',
        id: item.d.line.id as string,
        ...tag,
      });
      item.d = null;
    }
  }
  for (const { index, error } of checkTruthChain(all.map((i) => i.d), previous)) {
    const item = all[index];
    errors.push({ line: item?.line ?? 0, error, ...(item?.d ? { id: item.d.line.id as string } : {}), ...tag });
  }

  // A v2 stream is one unit: a refused line or a broken chain refuses all of it.
  // A pure v1 file keeps its old per-line tolerance (it has no chain to break).
  if (errors.length > 0 && v2) return refusedRead(errors.sort((a, b) => a.line - b.line));
  const result = fold(all, options, file);
  result.errors.unshift(...errors);
  result.errors.sort((a, b) => a.line - b.line);
  if (result.errors.length > 0 && v2) return refusedRead(result.errors);
  return result;
}

/** The fold over a checked stream: entries, then the TRANSITIONs a reader honours, in stream (seq) order. */
function fold(items: Item[], options: TruthReadOptions, file?: string): FileRead {
  const tag = file !== undefined ? { file } : {};
  const result: FileRead = { entries: new Map(), conflicts: new Map(), transitions: [], held: [], errors: [], refused: false, lines: [], head: null };
  const position = new Map<string, number>(); // first stream position of each line id: what a cause.ref may name
  const transitions: Array<{ t: TruthTransition; at: number }> = [];

  items.forEach(({ line, d }, at) => {
    if (!d) return;
    const id = d.line.id as string;
    if (!position.has(id)) position.set(id, at);
    result.lines.push({ line, text: d.text, version: d.version, type: d.type, id, seq: d.seq, hash: d.hash, ...tag });
    if (d.version === 2) result.head = { seq: d.seq!, hash: d.hash! };
    if (d.type === 'TRANSITION') {
      const t = transitionOf(d, line, file);
      result.transitions.push(t);
      transitions.push({ t, at });
      return;
    }
    if (d.type !== 'TB' && d.type !== 'UV') return; // ADDENDUM / RULING: causes, kept in `lines`; TRANSITIONs carry their effect

    const entry = entryOf(d, line, file);
    const prior = result.entries.get(entry.id);
    if (!prior) {
      result.entries.set(entry.id, entry);
      return;
    }
    if (bodyKey(prior) !== bodyKey(entry)) {
      result.conflicts.set(entry.id, `lines ${prior.source!.line} and ${line} give ${entry.id} different content`);
    }
    if (d.version === 1) {
      // Version 1 re-emitted a line to change a status: the later line wins.
      // (A v2 stream states each entry once; its status changes are TRANSITIONs.)
      result.entries.delete(entry.id);
      result.entries.set(entry.id, entry);
    }
  });

  // The fold: the last honoured TRANSITION that targets an entry sets its status
  const registry = registryOf(options);
  const floors = new Map<string, string>(); // the final status an entry reached, if any
  const isFinal = (entry: TruthLedgerEntry, status: string | null) => status !== null && FINAL_STATUSES[entry.type].includes(status);
  const rankOf = (entry: TruthLedgerEntry, status: string) => (TRUTH_STATUSES[entry.type] as readonly string[]).indexOf(status);
  for (const entry of result.entries.values()) if (isFinal(entry, entry.status)) floors.set(entry.id, entry.status!);

  for (const { t, at } of transitions) {
    const entry = result.entries.get(t.target);
    if (!entry) continue; // its target is not in the stream read (it starts part-way)
    const hold = (reason: string) => result.held.push({ line: t.line, id: t.id, reason, ...tag });
    // Stenographer writes the cause's line first, or names no cause (ref null)
    if (t.cause.ref !== null && !((position.get(t.cause.ref) ?? Infinity) < at)) {
      result.errors.push({ line: t.line, id: t.id, error: `TRANSITION ${t.id} names cause ${t.cause.ref}, which is not an earlier line of the stream`, ...tag });
      continue;
    }
    if (registry && !listed(registry, t.author)) {
      hold(`TRANSITION ${t.id} is by '${t.author}', whom the signer registry doesn't list: not applied`);
      continue;
    }
    const floor = floors.get(entry.id);
    const rank = rankOf(entry, t.status);
    if (floor !== undefined && rank !== -1 && rank < rankOf(entry, floor)) {
      hold(`${entry.type} ${entry.id} is ${floor}, which is final: its TRANSITION to '${t.status}' is not applied`);
      continue;
    }
    entry.status = t.status;
    entry.source!.transition = { id: t.id, seq: t.seq, ts: t.ts, author: t.author, cause: t.cause };
    if (isFinal(entry, t.status) && (floor === undefined || rank > rankOf(entry, floor))) floors.set(entry.id, t.status);
  }
  return result;
}

function registryOf(options: TruthReadOptions): TruthSignerRegistry | null {
  return options.signers ? createSignerRegistry(options.signers) : null;
}

function listed(registry: TruthSignerRegistry, identity: string): boolean {
  const role = registry.lookup(identity)?.role;
  return role === 'human' || role === 'agent';
}

/**
 * Who is an agent (spec/truth-format, "Agent quorum"): with a signer
 * registry, an identity it lists with role `agent` (its role decides, not
 * its name); without one, an identity whose key starts with `agent:`.
 */
function isAgent(identity: string, registry: TruthSignerRegistry | null): boolean {
  return registry ? registry.lookup(identity)?.role === 'agent' : hasAgentPrefix(identity);
}

/**
 * Why a TB an agent signed can't be truth, or null: agents settle a claim
 * only together, so it needs a quorum (whose rules the codec checked) whose
 * members are all agents. With a registry, an unlisted `agent:` name is no
 * witness.
 */
function agentWithoutQuorum(entry: TruthTbEntry, registry: TruthSignerRegistry | null): string | null {
  if (!entry.signedBy || !isAgent(entry.signedBy, registry)) return null;
  const outsider = entry.quorum?.find((m) => !isAgent(m.author, registry));
  if (entry.quorum && !outsider) return null;
  const why = outsider ? `a quorum that isn't all agents (quorum member ${outsider.author} is not an agent: ${notAnAgent(outsider.author, registry)})` : 'no quorum';
  return (
    `TB ${entry.id} is signed by agent ${entry.signedBy} with ${why}: agents settle a claim only as two or more agent sessions ` +
    'agreeing from different angles within 15 minutes, or a person signs it'
  );
}

/**
 * Why a TB an agent signed can't be truth for this reader because of a value
 * it doesn't know, or null: an evidence kind on its line or in its quorum,
 * or a link type in its `x-steno.links`. The codec refuses no line over
 * either (it may be a newer writer's: a settling kind, a new relation), and
 * the quorum rules read only the kinds and link types a reader knows, so
 * this reader can't tell what the agents settled, or that they agree from
 * different angles: it fails closed instead (spec/truth-format, "Unknown
 * values", "An unknown evidence kind fails closed"), as stenographer's
 * import does (reason `unknown-value`, naming the first such value, evidence
 * kinds first). A version 1 line's links are not checked by the codec, and
 * stenographer drops those it doesn't take, so only a version 2 line's
 * count. A person may sign on evidence of any class, and a person's TB is
 * not refused here.
 */
function agentUnknownValue(entry: TruthTbEntry, registry: TruthSignerRegistry | null): string | null {
  if (!entry.signedBy || !isAgent(entry.signedBy, registry)) return null;
  const signed = `TB ${entry.id} is signed by agent ${entry.signedBy}`;
  const items = [...entry.evidence, ...(entry.quorum ?? []).flatMap((m) => m.evidence)];
  const kind = items.find((e) => !(EVIDENCE_KINDS as readonly string[]).includes(e.kind));
  if (kind) {
    return (
      `${signed} and cites evidence kind '${kind.kind}', which this version doesn't know: ` +
      "it settles nothing for this reader, which can't tell that the quorum agrees from different angles"
    );
  }
  const link = entry.source?.version === 2 ? unknownLinkType(entry.xSteno) : null;
  if (link !== null) {
    return (
      `${signed} and carries link type '${link}' in x-steno.links, which this version doesn't know: ` +
      "an agent's settlement carrying a value this reader can't read settles nothing for it"
    );
  }
  return null;
}

/** The first link type in `x-steno.links` this version doesn't know, or null. */
function unknownLinkType(xSteno: Record<string, unknown> | undefined): string | null {
  const links = xSteno?.links;
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const type = typeof l === 'object' && l !== null ? (l as { type?: unknown }).type : undefined;
    if (typeof type === 'string' && !(LINK_TYPES as readonly string[]).includes(type)) return type;
  }
  return null;
}

/** Why `identity`, which `isAgent` says is not an agent, isn't one. */
function notAnAgent(identity: string, registry: TruthSignerRegistry | null): string {
  if (!registry) return `its name doesn't start with '${AGENT_PREFIX}'`;
  const role = registry.lookup(identity)?.role;
  if (!role) return "the signer registry doesn't list it";
  return `the signer registry lists it as ${role === 'human' ? 'a person' : `a ${role}`}`;
}

/** Sets `entry.inadmissible` when the reader will not take it as truth whatever its status. */
function admit(
  entry: TruthLedgerEntry,
  facts: { conflict: string | null; verifiable: boolean },
  options: TruthReadOptions,
  registry: TruthSignerRegistry | null,
): void {
  const refuse = (reason: TruthInadmissible['reason'], detail: string) => {
    entry.inadmissible = { reason, detail };
  };
  if (facts.conflict) return refuse('conflict', facts.conflict);
  if (entry.type === 'TB') {
    if (!entry.signedBy) return refuse('unsigned', `TB ${entry.id} has no signer: a backfilled TB is never truth on its own`);
    if (!facts.verifiable && !options.admitV1Tbs) {
      return refuse('unverifiable', `TB ${entry.id} is a version 1 line: it carries no hash, so its content can't be checked`);
    }
  }
  if (registry) {
    if (!listed(registry, entry.author)) return refuse('unverifiable', `${entry.type} ${entry.id}: author '${entry.author}' is not in the signer registry`);
    if (entry.type === 'TB' && !listed(registry, entry.signedBy!)) {
      return refuse('unverifiable', `TB ${entry.id}: signer '${entry.signedBy}' is not in the signer registry`);
    }
  }
  // Agents settle only together, from different angles: an agent's TB is truth only with a
  // quorum of agents, and only when this reader knows every evidence kind it cites and every
  // link type it carries (it fails closed on one it doesn't, ahead of the quorum check, as
  // stenographer's import does)
  if (entry.type === 'TB') {
    const unknown = agentUnknownValue(entry, registry);
    if (unknown) return refuse('unknown-value', unknown);
    const why = agentWithoutQuorum(entry, registry);
    if (why) return refuse('agent-without-quorum', why);
  }
}

function emptyResult(errors: WikiParseResult['errors']): WikiParseResult {
  return { entries: [], errors, refused: true, transitions: [], held: [], lines: [], head: null, conflicts: [] };
}

/**
 * Parse one truth stream (JSONL text, or its lines). Blank lines are
 * skipped and counted in line numbers. See the module comment for the
 * fold, fail-closed and admission rules; `result.refused` says the input
 * was refused as a whole.
 */
export function parseWikiLines(input: string | string[], options: TruthReadOptions = {}): WikiParseResult {
  const read = readFile(input, options);
  if (read.refused) return emptyResult(read.errors);
  const registry = registryOf(options);
  const entries = [...read.entries.values()];
  for (const entry of entries) {
    admit(entry, { conflict: read.conflicts.get(entry.id) ?? null, verifiable: entry.source!.version === 2 }, options, registry);
  }
  return {
    entries,
    errors: read.errors,
    refused: false,
    transitions: read.transitions,
    held: read.held,
    lines: read.lines,
    head: read.head,
    conflicts: [...read.conflicts.keys()].map((id) => ({ id, files: [] })),
  };
}

/**
 * Rank on the status lattice (TRUTH_STATUSES is in lattice order). A
 * missing or unknown status ranks above every known one: it fails closed.
 */
function rank(entry: TruthLedgerEntry): number {
  if (entry.status === null) return 4;
  const i = (TRUTH_STATUSES[entry.type] as readonly string[]).indexOf(entry.status);
  return i === -1 ? 5 : i;
}

/**
 * Read several truth streams — one per writer, e.g. `wiki/<handle>.jsonl`
 * — fold each on its own, then give each entry the most advanced status
 * any of them reached. An id the files give different content is a
 * conflict, not truth. If any file is refused, the merge is refused: a
 * stream that can't be read might hold the strike that matters.
 */
export function parseWikiFiles(
  files: Array<{ name: string; text: string | string[] }>,
  options: Omit<TruthReadOptions, 'previous' | 'base'> = {},
): WikiParseResult {
  const reads = files.map((f) => ({ name: f.name, read: readFile(f.text, { ...options, previous: null, base: null }, f.name) }));
  const errors = reads.flatMap((r) => r.read.errors);
  if (reads.some((r) => r.read.refused)) return emptyResult(errors);

  const byId = new Map<string, Array<{ file: string; entry: TruthLedgerEntry; conflict: string | null }>>();
  for (const { name, read } of reads) {
    for (const entry of read.entries.values()) {
      const list = byId.get(entry.id) ?? [];
      list.push({ file: name, entry, conflict: read.conflicts.get(entry.id) ?? null });
      byId.set(entry.id, list);
    }
  }

  const registry = registryOf(options);
  const entries: TruthLedgerEntry[] = [];
  const conflicts: WikiParseResult['conflicts'] = [];
  for (const [id, copies] of byId) {
    let winner = copies[0];
    for (const copy of copies.slice(1)) {
      const r = rank(copy.entry);
      const w = rank(winner.entry);
      if (r > w || (r === w && r === 5 && (copy.entry.status as string) < (winner.entry.status as string))) winner = copy;
    }
    const keys = new Set(copies.map((c) => bodyKey(c.entry)));
    const conflictFiles = [...new Set(copies.map((c) => c.file))];
    let conflict = copies.find((c) => c.conflict)?.conflict ?? null;
    if (keys.size > 1) {
      conflict = `${conflictFiles.join(', ')} give ${id} different content`;
      conflicts.push({ id, files: conflictFiles });
    }
    const entry = winner.entry;
    admit(entry, { conflict, verifiable: copies.some((c) => c.entry.source!.version === 2) }, options, registry);
    entries.push(entry);
  }
  return {
    entries,
    errors,
    refused: false,
    transitions: reads.flatMap((r) => r.read.transitions),
    held: reads.flatMap((r) => r.read.held),
    lines: reads.flatMap((r) => r.read.lines),
    head: null,
    conflicts,
  };
}

/**
 * The fold as a table: `{ id: { type, status, current } }` for every
 * entry — the shape of the truth-format fixtures' `*.expected.json`.
 */
export function truthStatusTable(
  entries: TruthLedgerEntry[],
): Record<string, { type: 'TB' | 'UV'; status: string | null; current: boolean }> {
  return Object.fromEntries(
    entries.map((e) => [e.id, { type: e.type, status: e.status, current: classifyEntry(e) !== 'history' }]),
  );
}

/**
 * Serialize entries back to JSONL lines (no trailing newline). An entry
 * read from a stream is written back exactly as read; an entry built by
 * hand in the version 1 shape, and one of those carrying a quorum throws
 * `TruthLineError` (see `entryToWikiLine`). A stream's TRANSITION, ADDENDUM
 * and RULING lines are not entries: to write a whole stream back, use
 * `result.lines.map((l) => l.text)` (or `writeWikiFile(path, result)`).
 */
export function serializeWikiEntries(entries: TruthLedgerEntry[]): string[] {
  return entries.map((e) => (e.source ? e.source.text : JSON.stringify(entryToWikiLine(e))));
}

/** Read and parse a truth stream file. */
export function readWikiFile(path: string, options: TruthReadOptions = {}): WikiParseResult {
  return parseWikiLines(readFileSync(path, 'utf8'), options);
}

/**
 * Write entries (see `serializeWikiEntries`), or a parsed stream's lines
 * verbatim, to a file — one line each. Truth streams are stenographer's to
 * write (one writer per file); this is for copies and fixtures. Every line
 * is built before the file is touched, so an entry `serializeWikiEntries`
 * refuses leaves the file untouched.
 */
export function writeWikiFile(path: string, content: TruthLedgerEntry[] | WikiParseResult): void {
  const lines = Array.isArray(content) ? serializeWikiEntries(content) : content.lines.map((l) => l.text);
  writeFileSync(path, lines.map((l) => l + '\n').join(''));
}

function declaredVersion(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as { schemaVersion?: unknown } | null;
    return parsed && typeof parsed === 'object' ? parsed.schemaVersion : undefined;
  } catch {
    return undefined; // unreadable: it refuses the file only if the file is a v2 stream
  }
}

function idOf(text: string): { id?: string } {
  try {
    const id = (JSON.parse(text) as { id?: unknown } | null)?.id;
    return typeof id === 'string' ? { id } : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Consumption rules (§7)
// ---------------------------------------------------------------------------

/**
 * Classify a single entry per the §7 consumption rules. Fails closed:
 * anything but an active/contested, signed, admissible TB or an open,
 * admissible UV — including a status this package does not know, or none —
 * is history.
 */
export function classifyEntry(entry: TruthLedgerEntry): ConsumptionAction {
  if (entry.inadmissible) return 'history';
  if (entry.type === 'TB') {
    if (!entry.signedBy) return 'history'; // unsigned: never truth on its own
    if (entry.status === 'active') return 'ground-truth';
    if (entry.status === 'contested') return 'contested';
    return 'history'; // overridden, struck, unknown or missing
  }
  // UV: open is a flag; verified minted a TB elsewhere, refuted is dead —
  // both are history here, as are struck and any unknown or missing status.
  return entry.status === 'open' ? 'flag' : 'history';
}

/**
 * Partition ledger entries into the selection compaction consumes. An open
 * UV that contests a TB is attached to that TB whatever the TB's recorded
 * status: a current TB with an open contest is carried as contested, with
 * its contesting UVs — the dispute is never resolved silently. A UV
 * contesting a TB that is not current truth stays in `unverified` (and
 * renders with `contests <id>`).
 */
export function selectCurrentTruth(entries: TruthLedgerEntry[]): TruthSelection {
  const selection: TruthSelection = {
    groundTruth: [],
    contested: [],
    unverified: [],
    history: [],
  };

  const openContestsByTb = new Map<string, TruthUvEntry[]>();
  for (const entry of entries) {
    if (entry.type === 'UV' && entry.contests && classifyEntry(entry) === 'flag') {
      const list = openContestsByTb.get(entry.contests) ?? [];
      list.push(entry);
      openContestsByTb.set(entry.contests, list);
    }
  }

  for (const entry of entries) {
    const action = classifyEntry(entry);
    if (action === 'ground-truth' && openContestsByTb.has(entry.id)) {
      selection.contested.push({ tombstone: entry as TruthTbEntry, contestedBy: openContestsByTb.get(entry.id)! });
      continue;
    }
    switch (action) {
      case 'ground-truth':
        selection.groundTruth.push(entry as TruthTbEntry);
        break;
      case 'contested':
        selection.contested.push({
          tombstone: entry as TruthTbEntry,
          contestedBy: openContestsByTb.get(entry.id) ?? [],
        });
        break;
      case 'flag':
        selection.unverified.push(entry as TruthUvEntry);
        break;
      case 'history':
        selection.history.push(entry);
        break;
    }
  }

  return selection;
}
