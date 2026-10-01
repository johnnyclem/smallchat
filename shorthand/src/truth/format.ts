/**
 * Truth format v2 — the line codec (stenographer spec/truth-format).
 *
 * A truth file is UTF-8 JSONL, one writer's stream. Every v2 line carries
 * `schemaVersion: 2`, `seq` (1, 2, 3, … with no gaps), `prevHash` (the
 * previous line's `hash`; null on seq 1 only) and `hash` (lowercase hex
 * SHA-256 of the line's RFC 8785 JCS form without `hash`). Lines without
 * `schemaVersion` are version 1 (stenographer 0.x): no chain, a `status`
 * field, still readable.
 *
 * `decodeTruthLine` validates one line — the structure the JSON Schema
 * (wiki-line.v2.schema.json) describes, plus what JSON Schema can't
 * express: the hash, the identity rules and the link rules — and throws
 * `TruthLineError` when a reader must refuse it. `checkTruthChain` checks
 * that decoded lines form one stream. The schema is open where readers must
 * be: unknown fields and unknown values of status, kinds, link types,
 * cause kinds and signal sources are kept, never refused and never
 * coerced. The line `type` and the required fields are closed.
 *
 * Zero dependencies (node:crypto for SHA-256). The reference codec is
 * stenographer's src/truth/wiki.ts; the golden fixtures in
 * test/fixtures/truth-format pin this one to it.
 */

import { sha256Hex } from '../utils.js';
import { CanonicalizationError, canonicalize } from './jcs.js';
import { MIGRATION_AUTHOR, identityIssue, identityKey } from './identity.js';

export const TRUTH_SCHEMA_VERSION = 2;

export const TRUTH_LINE_TYPES = ['TB', 'UV', 'ADDENDUM', 'RULING', 'PROPOSAL', 'TRANSITION'] as const;
export type TruthLineType = (typeof TRUTH_LINE_TYPES)[number];

/**
 * The statuses this version knows, in lattice order (a reader merging
 * several files takes the most advanced). A reader treats any other status,
 * or none, as not current truth.
 */
export const TRUTH_STATUSES = {
  TB: ['active', 'contested', 'overridden', 'struck'],
  UV: ['open', 'verified', 'refuted', 'struck'],
} as const;

/** What caused a TRANSITION. `dismiss` and `promote` are for proposal streams. */
export const CAUSE_KINDS = ['contest', 'override', 'strike', 'verify', 'refute', 'dismiss', 'promote'] as const;

/** Link types this version knows. A link of any other type is kept and not judged. */
export const LINK_TYPES = ['supersedes', 'contests', 'verifies', 'refutes', 'signs', 'overrides', 'strikes', 'dismisses'] as const;

/** Links a TB or UV line may carry from itself, and into itself (its own history). */
const OUTBOUND_LINKS: Record<'TB' | 'UV', readonly string[]> = { TB: ['supersedes', 'signs'], UV: ['contests', 'signs'] };
const INBOUND_LINKS: Record<'TB' | 'UV', readonly string[]> = {
  TB: ['overrides', 'contests', 'supersedes', 'strikes'],
  UV: ['verifies', 'refutes', 'supersedes', 'strikes'],
};

/** v1 lines were validated like a live write: closed evidence and verifyBy kinds. */
const V1_EVIDENCE_KINDS = ['commit', 'file', 'test', 'command', 'claimed-command', 'wiki', 'message'];
const V1_VERIFY_KINDS = ['command', 'inspect', 'ask', 'observe'];

/** A line a reader must refuse. */
export class TruthLineError extends Error {}

/** One line, read and validated. */
export interface DecodedTruthLine {
  version: 1 | 2;
  type: TruthLineType;
  /** The parsed line, unknown fields included. */
  line: Record<string, unknown>;
  /** The line exactly as read: what re-serialization writes back. */
  text: string;
  /** v2 only. */
  seq: number | null;
  prevHash: string | null;
  hash: string | null;
}

/** The last line of a stream a reader has read: pass it back to check the stream still holds it. */
export interface StreamHead {
  seq: number;
  hash: string;
}

/** sha256hex(JCS(line without `hash`)): the hash a v2 line carries. Doesn't validate the line. */
export function truthLineHash(line: string | Record<string, unknown>): string {
  const { hash: _hash, ...rest } = typeof line === 'string' ? (JSON.parse(line) as Record<string, unknown>) : line;
  return sha256Hex(canonicalize(rest));
}

/**
 * Chains line bodies into one stream as a writer would: `schemaVersion: 2`,
 * `seq` from `head.seq + 1` (or 1), `prevHash`, `hash`. It does not
 * validate the bodies — `decodeTruthLine` does. Truth itself is written by
 * stenographer (one writer per wiki file); this package writes only
 * PROPOSAL streams (`ProposalStream`), and uses this for fixtures.
 */
export function chainTruthLines(bodies: Array<Record<string, unknown>>, head: StreamHead | null = null): string[] {
  let seq = head?.seq ?? 0;
  let prev = head?.hash ?? null;
  return bodies.map((body) => {
    const { schemaVersion: _v, seq: _s, prevHash: _p, hash: _h, ...rest } = body;
    const unhashed = { schemaVersion: TRUTH_SCHEMA_VERSION, seq: ++seq, ...rest, prevHash: prev };
    prev = truthLineHash(unhashed);
    return JSON.stringify({ ...unhashed, hash: prev });
  });
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const LITERAL_VALUE_RE = /^\S([\s\S]*\S)?$/;

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new TruthLineError(path ? `${path}: ${message}` : message);
}

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, key: string) => Object.prototype.hasOwnProperty.call(o, key);

function text(o: Obj, key: string, path = key): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) fail(path, 'must be a non-empty string');
  return v;
}

function optionalString(o: Obj, key: string, path = key): void {
  if (has(o, key) && typeof o[key] !== 'string') fail(path, 'must be a string');
}

function nullableString(o: Obj, key: string, path = key, required = false): void {
  if (!has(o, key)) {
    if (required) fail(path, 'is required (a string or null)');
    return;
  }
  if (o[key] !== null && typeof o[key] !== 'string') fail(path, 'must be a string or null');
}

function id(o: Obj, key: string, path = key): string {
  const v = o[key];
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(path, 'an id is 1–256 characters: letters, digits, . _ : - (starting with a letter or digit)');
  return v;
}

function daysIn(year: number, month: number): number {
  return [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * RFC 3339 date-time naming a real time (no February 30, no 24:00, no
 * offset past 23:59), as the schema's pattern and `format: date-time`
 * require, and as stenographer's codec reads it: `T` and `Z` upper case,
 * and no leap second (`:60`), which the spec lets a codec refuse.
 */
export function isRfc3339(ts: string): boolean {
  const m = RFC3339_RE.exec(ts);
  if (!m) return false;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) return false;
  return m[9] === undefined || (Number(m[9]) <= 23 && Number(m[10]) <= 59);
}

function evidenceList(o: Obj, key: string, v1: boolean): void {
  const list = o[key];
  if (!Array.isArray(list) || list.length === 0) fail(key, 'at least one piece of evidence is required');
  list.forEach((e, i) => {
    const path = `${key}.${i}`;
    if (!isObject(e)) fail(path, 'must be an object');
    const kind = text(e, 'kind', `${path}.kind`);
    if (v1 && !V1_EVIDENCE_KINDS.includes(kind)) fail(`${path}.kind`, `'${kind}' is not an evidence kind a version 1 line could carry`);
    text(e, 'ref', `${path}.ref`);
    optionalString(e, 'detail', `${path}.detail`);
  });
}

function verifyBy(o: Obj, v1: boolean): void {
  const v = o.verifyBy;
  if (!isObject(v)) fail('verifyBy', 'must be an object');
  const kind = text(v, 'kind', 'verifyBy.kind');
  if (v1 && !V1_VERIFY_KINDS.includes(kind)) fail('verifyBy.kind', `'${kind}' is not a verifyBy kind a version 1 line could carry`);
  text(v, 'value', 'verifyBy.value');
  optionalString(v, 'detail', 'verifyBy.detail');
}

function isDistinctiveIdentifier(value: string): boolean {
  return [...value].length >= 4 && /[A-Za-z]/.test(value);
}

/**
 * Why a dead literal is invalid, or null. A v2 line states values exactly
 * (non-empty, no surrounding whitespace); a v1 line was trimmed on write.
 * Without a `subject`, `dead` must be a distinctive identifier (at least 4
 * characters, an ASCII letter): a bare `30` would match everything.
 */
export function literalIssue(literal: unknown, version: 1 | 2 = 2): string | null {
  if (!isObject(literal)) return 'a literal must be an object';
  for (const key of ['dead', 'subject', 'current'] as const) {
    if (key !== 'dead' && !has(literal, key)) continue;
    const v = literal[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      return key === 'dead' ? 'a literal needs a dead value' : `a literal's ${key} must be a non-blank string`;
    }
    if (version === 2 && !LITERAL_VALUE_RE.test(v)) return `literal values cannot have surrounding whitespace (${key})`;
  }
  if (!has(literal, 'subject') && !isDistinctiveIdentifier((literal.dead as string).trim())) {
    return 'a literal without a subject must be a distinctive identifier (≥4 chars, contains a letter) — name the subject of bare values';
  }
  return null;
}

function literals(o: Obj, version: 1 | 2): void {
  if (!has(o, 'literals')) return;
  const list = o.literals;
  if (!Array.isArray(list) || (version === 2 && list.length === 0)) fail('literals', 'omit literals rather than send none');
  list.forEach((l, i) => {
    const issue = literalIssue(l, version);
    if (issue) fail(`literals.${i}`, issue);
  });
}

function status(o: Obj): void {
  if (has(o, 'status') && (typeof o.status !== 'string' || o.status.length === 0)) fail('status', 'must be a non-empty string');
}

function identity(o: Obj, key: string, options: { reserved?: 'detector' } = {}): void {
  const issue = identityIssue(o[key], options);
  if (issue) fail(key, issue);
}

function xSteno(o: Obj): Array<{ fromId: string; toId: string; type: string }> | null {
  if (!has(o, 'x-steno')) return null;
  const x = o['x-steno'];
  if (!isObject(x)) fail('x-steno', 'must be an object');
  if (has(x, 'origin')) text(x, 'origin', 'x-steno.origin');
  if (has(x, 'provenance')) {
    const p = x.provenance;
    if (!isObject(p)) fail('x-steno.provenance', 'must be an object');
    text(p, 'kind', 'x-steno.provenance.kind');
    optionalString(p, 'ref', 'x-steno.provenance.ref');
    if (has(p, 'line') && !Number.isInteger(p.line)) fail('x-steno.provenance.line', 'must be an integer');
  }
  nullableString(x, 'agentSessionId', 'x-steno.agentSessionId');
  nullableString(x, 'targetRef', 'x-steno.targetRef');
  if (has(x, 'ledgerHash') && (typeof x.ledgerHash !== 'string' || !HEX64_RE.test(x.ledgerHash))) {
    fail('x-steno.ledgerHash', 'a hash is 64 lowercase hex digits');
  }
  if (!has(x, 'links')) return null;
  const links = x.links;
  if (!Array.isArray(links)) fail('x-steno.links', 'must be an array');
  const seen = new Set<string>();
  return links.map((l, i) => {
    const path = `x-steno.links.${i}`;
    if (!isObject(l)) fail(path, 'must be an object');
    const link = { fromId: id(l, 'fromId', `${path}.fromId`), toId: id(l, 'toId', `${path}.toId`), type: text(l, 'type', `${path}.type`) };
    const key = JSON.stringify([link.fromId, link.toId, link.type]);
    if (seen.has(key)) fail('x-steno.links', 'a line lists each link once');
    seen.add(key);
    return link;
  });
}

/** The link rules: a TB/UV line speaks only for itself, an ADDENDUM/RULING lists only the links it writes. */
function checkLinks(o: Obj, type: TruthLineType, links: Array<{ fromId: string; toId: string; type: string }> | null): void {
  if (!links) return;
  const self = o.id as string;
  if (type === 'TB' || type === 'UV') {
    links.forEach((l, i) => {
      if (!(LINK_TYPES as readonly string[]).includes(l.type)) return; // an unknown type: not ours to judge
      const own =
        (l.fromId === self && OUTBOUND_LINKS[type].includes(l.type)) ||
        (l.toId === self && l.fromId !== self && INBOUND_LINKS[type].includes(l.type));
      if (!own) fail(`x-steno.links.${i}`, `a ${type} line cannot carry the link ${l.fromId} -${l.type}-> ${l.toId}`);
    });
  }
  if (type === 'UV') {
    const contests = o.contests as string | null;
    const contestLinks = links.filter((l) => l.type === 'contests' && l.fromId === self);
    if (contests && !contestLinks.some((l) => l.toId === contests)) {
      fail('x-steno.links', 'a UV that contests a TB lists its contests link in x-steno.links');
    }
    if (contestLinks.some((l) => l.toId !== contests)) fail('x-steno.links', 'a contests link points at the TB the contests field names');
  }
  if (type === 'ADDENDUM' || type === 'RULING') {
    links.forEach((l, i) => {
      if (l.fromId !== self) fail(`x-steno.links.${i}`, `${type === 'ADDENDUM' ? 'an' : 'a'} ${type} line lists only the links it writes`);
    });
  }
}

function decodeV2(o: Obj, raw: string): DecodedTruthLine {
  for (const key of ['seq', 'id', 'type', 'ts', 'author', 'prevHash', 'hash']) {
    if (!has(o, key)) fail(key, 'is required');
  }
  if (typeof o.seq !== 'number' || !Number.isInteger(o.seq) || o.seq < 1) fail('seq', 'must be an integer of at least 1');
  id(o, 'id');
  if (!(TRUTH_LINE_TYPES as readonly unknown[]).includes(o.type)) {
    fail('type', `${JSON.stringify(o.type)} is not a truth line type (${TRUTH_LINE_TYPES.join(', ')})`);
  }
  const type = o.type as TruthLineType;
  if (typeof o.ts !== 'string' || !isRfc3339(o.ts)) {
    // JSON Schema's date-time takes 23:59:60 UTC; stenographer's codec (Date.parse) refuses every leap second
    if (typeof o.ts === 'string' && RFC3339_RE.exec(o.ts)?.[6] === '60') fail('ts', 'a leap second (:60) is not a time this codec reads');
    fail('ts', 'must be an RFC 3339 date-time');
  }
  if (typeof o.author !== 'string' || o.author.length === 0) fail('author', 'must be a non-empty string');
  if (o.prevHash !== null && (typeof o.prevHash !== 'string' || !HEX64_RE.test(o.prevHash))) fail('prevHash', 'a hash is 64 lowercase hex digits, or null');
  if (typeof o.hash !== 'string' || !HEX64_RE.test(o.hash)) fail('hash', 'a hash is 64 lowercase hex digits');
  if ((o.seq === 1) !== (o.prevHash === null)) fail('prevHash', 'is null on the first line of a stream (seq 1), and only there');
  const links = xSteno(o);

  switch (type) {
    case 'TB': {
      text(o, 'claim');
      evidenceList(o, 'evidence', false);
      if (!has(o, 'signedBy')) fail('signedBy', 'is required (an identity, or null on a backfilled TB)');
      if (o.signedBy !== null) identity(o, 'signedBy');
      literals(o, 2);
      status(o);
      // The backfill's second-class TBs are the one place 'migration' authors one, unsigned
      if (!(identityKey(o.author as string) === MIGRATION_AUTHOR && o.signedBy === null)) identity(o, 'author');
      break;
    }
    case 'UV':
      text(o, 'assertion');
      text(o, 'basis');
      verifyBy(o, false);
      if (!has(o, 'contests')) fail('contests', 'is required (the contested TB id, or null)');
      if (o.contests !== null) id(o, 'contests');
      status(o);
      identity(o, 'author');
      break;
    case 'ADDENDUM':
      evidenceList(o, 'evidence', false);
      nullableString(o, 'note', 'note', true);
      identity(o, 'author');
      break;
    case 'RULING':
      text(o, 'kind');
      if (typeof o.opinion !== 'string' || !/\S/.test(o.opinion)) fail('opinion', 'cannot be blank');
      id(o, 'target');
      identity(o, 'author');
      break;
    case 'PROPOSAL': {
      text(o, 'kind');
      if (!isObject(o.draft)) fail('draft', 'must be an object');
      nullableString(o, 'targetRef', 'targetRef', true);
      if (!isObject(o.signal)) fail('signal', 'must be an object');
      text(o.signal, 'source', 'signal.source');
      nullableString(o, 'agentSessionId');
      // Detectors file proposals
      identity(o, 'author', { reserved: 'detector' });
      break;
    }
    case 'TRANSITION': {
      id(o, 'target');
      text(o, 'status');
      if (!isObject(o.cause)) fail('cause', 'is required: {kind, ref}');
      text(o.cause, 'kind', 'cause.kind');
      if (!has(o.cause, 'ref')) fail('cause.ref', 'is required (the causing entry id, or null)');
      if (o.cause.ref !== null) id(o.cause, 'ref', 'cause.ref');
      // A transition's author is its cause's: a person or an agent, never 'migration' or a detector
      identity(o, 'author');
      break;
    }
  }
  checkLinks(o, type, links);

  let hash: string;
  try {
    hash = truthLineHash(o);
  } catch (err) {
    if (err instanceof CanonicalizationError) fail('', `the line can't be canonicalized: ${err.message}`);
    throw err;
  }
  if (hash !== o.hash) {
    fail('', `hash mismatch: the line hashes to ${hash}, not ${o.hash as string} — it was changed after it was written`);
  }
  return { version: 2, type, line: o, text: raw, seq: o.seq, prevHash: o.prevHash as string | null, hash };
}

function decodeV1(o: Obj, raw: string): DecodedTruthLine {
  if (o.type !== 'TB' && o.type !== 'UV') {
    fail('type', `a version 1 line is a TB or UV (got ${JSON.stringify(o.type)})`);
  }
  const type = o.type;
  id(o, 'id');
  if (typeof o.ts !== 'string' || !Number.isFinite(Date.parse(o.ts))) fail('ts', 'must be a timestamp');
  if (typeof o.author !== 'string') fail('author', 'must be a string');
  if (has(o, 'status') && typeof o.status !== 'string') fail('status', 'must be a string');
  if (has(o, 'x-steno') && !isObject(o['x-steno'])) fail('x-steno', 'must be an object');

  if (type === 'TB') {
    text(o, 'claim');
    evidenceList(o, 'evidence', true);
    if (has(o, 'signedBy') && o.signedBy !== null) identity(o, 'signedBy');
    literals(o, 1);
    if (!(identityKey(o.author as string) === MIGRATION_AUTHOR && !o.signedBy)) identity(o, 'author');
  } else {
    identity(o, 'author');
    text(o, 'assertion');
    text(o, 'basis');
    verifyBy(o, true);
    if (has(o, 'contests') && o.contests !== null) id(o, 'contests');
  }
  return { version: 1, type, line: o, text: raw, seq: null, prevHash: null, hash: null };
}

/**
 * Reads one line: validates it (v2, or v1 from stenographer 0.x) and, for
 * v2, checks its hash. Throws `TruthLineError` when a reader must refuse
 * it. Chain continuity across lines is `checkTruthChain`'s.
 */
export function decodeTruthLine(raw: string): DecodedTruthLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TruthLineError(`not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(parsed)) throw new TruthLineError('a line is a JSON object');
  const version = parsed.schemaVersion;
  if (version === undefined || version === 1) return decodeV1(parsed, raw);
  if (version !== TRUTH_SCHEMA_VERSION) {
    throw new TruthLineError(`schemaVersion ${JSON.stringify(version)} is not one this reader knows (1, 2) — refusing rather than guessing`);
  }
  return decodeV2(parsed, raw);
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/**
 * Checks that decoded v2 lines form one stream: each line's seq follows the
 * one before it and its prevHash is that line's hash. A stream may start
 * part-way (an incremental export), but not skip, repeat, reorder or
 * interleave two writers. With `previous` (the head a reader kept from its
 * last read), the lines must also continue, or still contain, that head —
 * which is how a reader notices lines removed from the end; lines with no
 * v2 line among them (none at all, or only version 1 lines) do neither.
 * Returns the index and error of each break (index -1: the lines as a
 * whole); null entries (refused lines) are skipped.
 */
export function checkTruthChain(
  lines: Array<DecodedTruthLine | null>,
  previous: StreamHead | null = null,
): Array<{ index: number; error: string }> {
  const breaks: Array<{ index: number; error: string }> = [];
  let prev: { seq: number; hash: string } | null = null;
  let firstIndex = -1;
  let lastIndex = -1;
  let sawPrevious = false;
  lines.forEach((d, index) => {
    if (!d) {
      prev = null; // a refused line: don't pile chain errors on top of its own
      return;
    }
    if (d.version !== 2) return;
    const seq = d.seq!;
    if (firstIndex === -1) {
      firstIndex = index;
      if (previous && seq > previous.seq + 1) {
        breaks.push({ index, error: `chain broken: seq ${seq} follows ${previous.seq}, the last line read before — lines are missing` });
      } else if (previous && seq === previous.seq + 1 && d.prevHash !== previous.hash) {
        breaks.push({
          index,
          error: `chain broken: prevHash ${d.prevHash} is not ${previous.hash}, the hash of line ${previous.seq} read before — another stream, or a rewritten one`,
        });
      }
    }
    lastIndex = index;
    if (previous && seq === previous.seq) {
      sawPrevious = true;
      if (d.hash !== previous.hash) breaks.push({ index, error: `chain broken: line ${seq} hashes to ${d.hash}, not ${previous.hash} as read before — the stream was rewritten` });
    }
    if (prev && seq !== prev.seq + 1) {
      breaks.push({ index, error: `chain broken: seq ${seq} follows ${prev.seq} — a line is missing, repeated or out of order` });
    } else if (prev && d.prevHash !== prev.hash) {
      breaks.push({
        index,
        error: `chain broken: prevHash ${d.prevHash} is not the previous line's hash ${prev.hash} — two writers' lines, or an edited one`,
      });
    }
    prev = { seq, hash: d.hash! };
  });
  if (previous && firstIndex === -1 && !lines.some((d) => d === null)) {
    breaks.push({
      index: -1,
      error: `chain broken: the input holds no line of the stream read before (it ended at seq ${previous.seq}) — it was emptied or rewritten`,
    });
  }
  if (previous && firstIndex !== -1 && !sawPrevious) {
    if (lines[firstIndex]!.seq! <= previous.seq) {
      breaks.push({
        index: lastIndex,
        error: `chain broken: the stream no longer holds line ${previous.seq} (${previous.hash}) read before — it was truncated or rewritten`,
      });
    }
  }
  return breaks;
}
