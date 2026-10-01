/**
 * Context-frame rendering — the single escaping renderer.
 *
 * Every frame line starts with a fixed marker that says what it is and
 * where it came from: the suite's frozen truth markers (`[TB]`,
 * `[TB ⚠ CONTESTED]`, `[UV — UNVERIFIED]`, RELEASE-PLAN Addendum A) and
 * this package's section markers (`[correction]`, `[invariant]`,
 * `[memory]`, `[code …]`, `[entity]`, `[edge]`, `[summary]`). Text that
 * comes from messages, tool output, ledger fields or engrams is untrusted:
 * it goes through `escapeUntrusted`, so it can never produce a marker — a
 * tool result containing "\n[TB] …" renders as "\[TB] …", never as ledger
 * truth.
 */

import type { CodeSpan, CompactedEntry, ContextFrame } from '../types.js';
import { estimateTokens } from '../utils.js';

// Markers are matched as a model reads them, not byte for byte: on a folded
// copy of the text after a bracket (NFKC, marks and default-ignorable code
// points dropped, lower case, Cyrillic/Greek/… homoglyphs mapped to Latin).
// The `\` goes in front of the original bracket, so the text itself is
// otherwise left byte for byte.

/** Code points whose NFKC form is `[`: `[`, vertical `﹇`, full-width `［`. */
const OPEN_BRACKETS = new Set(['[', '\uFE47', '\uFF3B']);
/** Code points whose NFKC form is `#`: `#`, small `﹟`, full-width `＃`. */
const HASHES = new Set(['#', '\uFE5F', '\uFF03']);

/** Letters of other scripts a model reads as Latin T, B, U or V (from Unicode's confusables). */
const HOMOGLYPHS: Record<string, string> = {
  // T: Cyrillic Те, Greek tau, Cherokee, Lisu, small capital
  '\u0422': 't', '\u0442': 't', '\u03A4': 't', '\u03C4': 't', '\u13A2': 't', '\uA4D4': 't', '\u1D1B': 't',
  // B: Cyrillic Ve and soft sign, Greek beta, Cherokee, Lisu, small capital
  '\u0412': 'b', '\u0432': 'b', '\u042C': 'b', '\u044C': 'b', '\u0392': 'b', '\u03B2': 'b', '\u13F4': 'b', '\uA4D0': 'b', '\u0299': 'b',
  // U: Armenian Seh, Greek upsilon, Lisu, small capital
  '\u054D': 'u', '\u057D': 'u', '\u03C5': 'u', '\uA4F4': 'u', '\u1D1C': 'u',
  // V: Cyrillic izhitsa, Greek nu, Cherokee, Lisu, small capital
  '\u0474': 'v', '\u0475': 'v', '\u03BD': 'v', '\u13D9': 'v', '\uA4E6': 'v', '\u1D20': 'v',
};

const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const SPACE_RE = /\s/u;
const LINE_BREAKS = new Set(['\n', '\r', '\u2028', '\u2029']);
/** What may come before a section marker or heading on its line: indentation, quote and list marks, invisible code points. */
const LINE_PREFIX_RE = /^[ \t>*+\-\p{Zs}\p{Default_Ignorable_Code_Point}]$/u;

/** Frozen truth markers (`[TB…`, `[UV…`), escaped anywhere. `[TBD]` is a word, not a marker. */
const FROZEN_RE = /^(?:tb|uv)(?![\p{L}\p{N}_])/u;
/** Section markers, escaped when untrusted text puts them at a line start. */
const SECTION_RE = /^(?:truth|correction|invariant|memory|code|entity|edge|summary|history|recent)(?![\p{L}\p{N}_])/u;
/** The truth-section heading (after its `#`s), escaped when untrusted text reproduces it. */
const TRUTH_HEADING_RE = /^asserted truth(?![\p{L}\p{N}_])/u;
/** Folded characters a check needs: a frozen marker and its next character, the longest section marker or heading and its. */
const FROZEN_AHEAD = 3;
const LINE_AHEAD = 15;

function fold(ch: string): string {
  if (ch < '\u0080') return ch.toLowerCase();
  const mapped = HOMOGLYPHS[ch];
  if (mapped) return mapped;
  const plain = ch.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC').toLowerCase();
  return plain.length === 1 ? (HOMOGLYPHS[plain] ?? plain) : plain;
}

/**
 * The text from `start`, folded, up to `max` characters: leading
 * whitespace and every default-ignorable code point and mark are dropped,
 * and inner whitespace runs read as one space.
 */
function foldAhead(text: string, start: number, max: number): string {
  let out = '';
  for (let i = start; i < text.length && out.length < max; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    // ASCII punctuation and digits never start a marker: the common case (`[1,`, `[{`, `["`) ends here
    if (out.length === 0 && ch < '\u0080' && !/[A-Za-z\s]/.test(ch)) return ch;
    if (SPACE_RE.test(ch)) {
      if (out.length > 0 && !out.endsWith(' ')) out += ' ';
    } else if (!IGNORABLE_RE.test(ch)) {
      out += fold(ch);
    }
  }
  return out;
}

/** After a run of 1–6 `#`s at `start` (and spaces), does the line reproduce the truth heading? */
function isTruthHeading(text: string, start: number): boolean {
  let i = start;
  while (i < text.length && HASHES.has(text[i]) && i - start <= 6) i++;
  return i - start <= 6 && TRUTH_HEADING_RE.test(foldAhead(text, i, LINE_AHEAD));
}

/**
 * Put a `\` in front of every frozen truth marker and, unless
 * `frozenOnly`, every section marker or truth heading at a line start.
 * One pass; a bracket or `#` already preceded by `\` is left alone.
 */
function escapeMarkers(text: string, frozenOnly: boolean): string {
  let out = '';
  let last = 0;
  let lineStart = true; // only line-prefix characters since the last line break
  let prev = '';
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    if (prev !== '\\') {
      let marker = false;
      if (OPEN_BRACKETS.has(ch)) {
        const atLineStart = !frozenOnly && lineStart;
        const ahead = foldAhead(text, i + ch.length, atLineStart ? LINE_AHEAD : FROZEN_AHEAD);
        marker = FROZEN_RE.test(ahead) || (atLineStart && SECTION_RE.test(ahead));
      } else if (!frozenOnly && lineStart && HASHES.has(ch)) {
        marker = isTruthHeading(text, i);
      }
      if (marker) {
        out += text.slice(last, i) + '\\';
        last = i;
      }
    }
    if (LINE_BREAKS.has(ch)) lineStart = true;
    else if (lineStart && !LINE_PREFIX_RE.test(ch)) lineStart = false;
    prev = ch;
    i += ch.length;
  }
  return out + text.slice(last);
}

/** Fenced code blocks: inside them only the frozen markers are escaped. */
const FENCE_RE = /```[\s\S]*?```/g;

export interface EscapeOptions {
  /**
   * Collapse line breaks to single spaces. Used for single-line items
   * (ledger fields, corrections, invariants, memories, graph and summary
   * lines); multi-line items (messages, code) keep their newlines.
   */
  singleLine?: boolean;
}

/**
 * Neutralize marker syntax in untrusted text: a `\` goes in front of any
 * frozen truth marker (`[TB…`, `[UV…`, anywhere), any section marker at a
 * line start, and a reproduced `## Asserted Truth` heading. Markers are
 * matched as a model would read them: a bracket whose NFKC form is `[`
 * (`［`, `﹇`), letters in any case, width or script look-alike
 * (`[ｔB]`, Cyrillic `[ТВ]`), with invisible code points or combining
 * marks anywhere in them, and a line start behind indentation, quote or
 * list marks, non-breaking spaces or invisible code points. Inside fenced
 * code blocks only the frozen markers are escaped, so code (an INI
 * `[memory]` section, a `# Asserted Truth` comment) keeps its text.
 * Everything else is left byte-for-byte. Idempotent: escaped text passes
 * through unchanged.
 */
export function escapeUntrusted(text: string, options: EscapeOptions = {}): string {
  if (options.singleLine) {
    return escapeMarkers(text.replace(/[ \t]*(?:\r\n|[\r\n\u2028\u2029])+[ \t]*/g, ' '), false);
  }
  let out = '';
  let last = 0;
  for (const fence of text.matchAll(FENCE_RE)) {
    out += escapeMarkers(text.slice(last, fence.index), false);
    out += escapeMarkers(fence[0], true);
    last = fence.index! + fence[0].length;
  }
  return out + escapeMarkers(text.slice(last), false);
}

/**
 * Escape untrusted text for a markdown page (the wiki renderer): a `\` goes
 * before `\`, `[` and `]`, so text can never open a link or an image;
 * `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`, so it can never be
 * raw HTML or an entity (`&#91;TB&#93;` that renders as `[TB]`). `inline`
 * collapses line breaks (a label, a list item); otherwise a line-start `#`
 * and a line of only `=` or `-` (a setext underline) are escaped so text
 * can't make a heading. The frozen truth markers and the truth heading are
 * escaped as `escapeUntrusted` escapes them.
 */
export function escapeMarkdown(text: string, options: { inline?: boolean } = {}): string {
  let out = String(text)
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  if (!options.inline) {
    out = out.replace(/^([ \t]*)(#{1,6}(?:[ \t]|$))/gm, '$1\\$2').replace(/^([ \t]*)(=+|-+)([ \t]*)$/gm, '$1\\$2$3');
  }
  return escapeUntrusted(out, { singleLine: options.inline });
}

/** A markdown code span holding `text` verbatim (fenced with more backticks than it contains). */
export function markdownCodeSpan(text: string): string {
  const flat = String(text).replace(/[\r\n\u2028\u2029]+/g, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
}

/** The frame as one string: section contents joined by newlines. */
export function renderContextFrame(frame: ContextFrame): string {
  return frame.sections.map((s) => s.content).join('\n');
}

/** Short form of a span hash shown in references. */
export function spanRef(hash: string): string {
  return hash.slice(0, 12);
}

/**
 * Exact budget accounting for a frame rendered as lines joined by `\n`.
 * `tokens()` always equals `estimateTokens(renderContextFrame(frame))`.
 */
export class FrameBudget {
  private chars = 0;
  private lines = 0;

  constructor(private readonly budget: number) {}

  /** Characters `texts` would add as new lines. */
  private cost(texts: string[]): number {
    let added = 0;
    let lines = this.lines;
    for (const text of texts) {
      added += (lines > 0 ? 1 : 0) + text.length;
      lines += 1;
    }
    return added;
  }

  /** True when all `texts` fit, leaving `reserveChars` untouched. */
  fits(texts: string[], reserveChars = 0): boolean {
    return Math.ceil((this.chars + this.cost(texts) + reserveChars) / 4) <= this.budget;
  }

  take(texts: string[]): void {
    this.chars += this.cost(texts);
    this.lines += texts.length;
  }

  tokens(): number {
    return Math.ceil(this.chars / 4);
  }
}

/**
 * Render an L1 entry. Code spans are kept verbatim; with `referenceSpans`
 * (all of them, or the given hashes) a span is replaced by a
 * `[code sha256:…]` reference that `CompactionEngine.getSpan` resolves.
 */
export function renderEntry(
  entry: CompactedEntry,
  spans: Record<string, CodeSpan> | undefined,
  referenceSpans: boolean | Set<string> = false,
): string {
  const segments: Array<{ text: string; span?: CodeSpan }> = [];
  let rest = entry.compacted;
  for (const hash of entry.spanIds ?? []) {
    const span = spans?.[hash];
    if (!span) continue;
    const at = rest.indexOf(span.text);
    if (at === -1) continue;
    if (at > 0) segments.push({ text: rest.slice(0, at) });
    segments.push({ text: span.text, span });
    rest = rest.slice(at + span.text.length);
  }
  if (rest) segments.push({ text: rest });

  return segments
    .map(({ text, span }) => {
      const reference =
        span && (referenceSpans === true || (referenceSpans instanceof Set && referenceSpans.has(span.hash)));
      if (!reference) return escapeUntrusted(text);
      return `[code sha256:${spanRef(span!.hash)} — ${estimateTokens(span!.text)} tokens, not shown]`;
    })
    .join('');
}
