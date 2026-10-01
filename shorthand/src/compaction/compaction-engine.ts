/**
 * CompactionEngine — orchestrates compaction across tiers and levels.
 *
 * Manages the LSM-tree lifecycle: messages enter L0, get compacted to L1,
 * and progressively merge into deeper levels as the conversation grows.
 *
 * Every state-changing operation (addMessage's compaction, flush,
 * recompact, correct, revertCorrection, retract) runs on one internal
 * queue, so concurrent callers never lose each other's updates.
 */

import type {
  CodeSpan,
  Compactor,
  CompactedState,
  CompactionConfig,
  CompactionLevel,
  ConversationMessage,
  ContextFrame,
  ContextItem,
  ContextSection,
  ContextSectionKind,
  Tombstone,
} from '../types.js';
import { CompactionLevel as CL, DEFAULT_COMPACTION_CONFIG, normalizeTimestamp } from '../types.js';
import { estimateTokens } from '../utils.js';
import { RegexCompactor } from './regex-compactor.js';
import { applyTombstone, retractMessages, revertTombstone } from './corrections.js';
import { isValidCorrectionSubject, normalizeForMatch, supersededMatcher, tombstoneId } from './matching.js';
import { FrameBudget, escapeUntrusted, renderEntry, spanRef } from './frame.js';
import type { ActiveEngramStore } from '../crdt/active-engram-store.js';
import type { TruthLedgerEntry, TruthSelection, TruthSyncResult } from '../truth/types.js';
import { parseWikiLines, selectCurrentTruth, type TruthReadOptions, type WikiParseResult } from '../truth/wiki.js';
import { TRUTH_SECTION_HEADING, renderTruthItems } from '../truth/compaction-bridge.js';
import { displaceStaleInvariants } from '../truth/ledger-sync.js';

/**
 * Share of the context budget held back for the most recent raw (L0)
 * messages before L3–L1 fill, so a large L1 can't crowd them out.
 */
const L0_RESERVE_SHARE = 0.25;

/** Characters of recent conversation interpolated into engram templates. */
const ENGRAM_CONTEXT_CHARS = 240;

/** A host-declared correction (see `CompactionEngine.correct`). */
export interface CorrectionInput {
  /** The value that no longer holds, e.g. "us-east-1". Must name something (not "it", "that", …). */
  from: string;
  /** The value that replaces it. */
  to: string;
  /** Message (or external event) the correction comes from. */
  sourceMessageId: string;
  /** What is being corrected, e.g. "region". Defaults to `from`. */
  key?: string;
  /** Why; defaults to a note naming the source message. */
  reason?: string;
  /** Epoch ms of the correction; defaults to the source message's timestamp, else now. */
  timestamp?: number;
}

const SECTION_LEVEL: Record<ContextSectionKind, CompactionLevel> = {
  truth: CL.L4_INVARIANTS,
  correction: CL.L4_INVARIANTS,
  invariant: CL.L4_INVARIANTS,
  memory: CL.L4_INVARIANTS,
  code: CL.L1_COMPACTED,
  graph: CL.L3_GRAPH,
  summary: CL.L2_SUMMARIES,
  history: CL.L1_COMPACTED,
  recent: CL.L0_MEMTABLE,
};

const SECTION_ORDER: ContextSectionKind[] = [
  'truth', 'correction', 'invariant', 'memory', 'code', 'graph', 'summary', 'history', 'recent',
];

function line(text: string): string {
  return escapeUntrusted(text, { singleLine: true });
}

/** The seq a read's stream (or one of its files) starts at, when it starts part-way. */
function partialStart(read: WikiParseResult): number | undefined {
  const seen = new Set<string | undefined>();
  for (const l of read.lines) {
    if (l.version !== 2 || seen.has(l.file)) continue;
    seen.add(l.file);
    if (l.seq !== 1) return l.seq!;
  }
  return undefined;
}

function uniq(ids: Array<string | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))];
}

export class CompactionEngine {
  private config: CompactionConfig;
  private compactor: Compactor;
  private state: CompactedState;
  private activeEngramStore?: ActiveEngramStore;
  private truthSelection?: TruthSelection;
  /** Serializes every state-replacing operation. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Arrival order of every message added through this engine. */
  private readonly seqOf = new Map<string, number>();
  private nextSeq = 0;
  /**
   * Explicit corrections that still have older messages waiting in L0;
   * applied to those messages' items when they compact.
   */
  private pendingCorrections: Array<{ tombstone: Tombstone; seq: number }> = [];

  constructor(config: Partial<CompactionConfig> = {}) {
    this.config = { ...DEFAULT_COMPACTION_CONFIG, ...config };
    this.compactor = this.resolveCompactor();
    this.state = {
      l0_messages: [],
      l1_compacted: [],
      l2_summaries: [],
      l3_graph: { entities: new Map(), edges: [] },
      l4_invariants: [],
      tombstones: [],
      totalTokenEstimate: 0,
      archive: [],
      spans: {},
    };
  }

  /**
   * Add a new message. It joins L0 immediately (in call order); compaction
   * of any L0 overflow is queued behind earlier operations, so concurrent
   * calls never lose messages.
   */
  addMessage(message: ConversationMessage): Promise<void> {
    this.state.l0_messages.push(message);
    if (!this.seqOf.has(message.id)) this.seqOf.set(message.id, this.nextSeq++);
    return this.enqueue(async () => {
      const overflow = this.state.l0_messages.length - this.config.memtableSize;
      if (overflow > 0) await this.compactHead(overflow);
    });
  }

  /** Add multiple messages at once. */
  async addMessages(messages: ConversationMessage[]): Promise<void> {
    for (const msg of messages) {
      await this.addMessage(msg);
    }
  }

  /** Force a compaction pass, flushing all of L0 into L1+. */
  flush(): Promise<void> {
    return this.enqueue(() => this.compactHead(this.state.l0_messages.length));
  }

  /** Trigger a deeper recompaction (L1→L2, L2→L3, etc.). */
  recompact(targetLevel: CompactionLevel): Promise<void> {
    return this.enqueue(async () => {
      this.replaceState(await this.compactor.recompact(this.state, targetLevel));
      this.redisplaceTruth();
    });
  }

  /**
   * Declare a correction: `from` no longer holds, `to` replaces it. This is
   * the deterministic path (pattern-inferred corrections are only
   * suggestions): the tombstone is `explicit`, its id derives from the
   * inputs (declaring the same correction twice returns the existing
   * tombstone), and it is applied to every level at once — L1 entries, L2
   * summaries and decisions, L3 entities and edges, and L4 invariants that
   * state only `from` are archived under the tombstone id, never deleted.
   * Messages older than the correction that are still in L0 get it when
   * they compact.
   *
   * Throws TypeError when `from` is empty or names nothing (a pronoun,
   * determiner or function word), when `to` is empty or equal to `from`,
   * or when `sourceMessageId` is empty.
   */
  correct(input: CorrectionInput): Promise<Tombstone> {
    const from = input.from?.trim() ?? '';
    const to = input.to?.trim() ?? '';
    if (!isValidCorrectionSubject(from)) {
      return Promise.reject(new TypeError(`correct(): "from" must name the superseded value, got ${JSON.stringify(input.from)}`));
    }
    if (!to || normalizeForMatch(to) === normalizeForMatch(from)) {
      return Promise.reject(new TypeError('correct(): "to" must be a non-empty value different from "from"'));
    }
    if (!input.sourceMessageId) {
      return Promise.reject(new TypeError('correct(): "sourceMessageId" is required'));
    }
    // Messages after the correction may legitimately restate the old value.
    // The cutoff is where correct() was called: a message added right after
    // it, before the queued job runs, is after the correction.
    const seq = this.seqOf.get(input.sourceMessageId) ?? this.nextSeq;

    return this.enqueue(async () => {
      const key = input.key?.trim() || from;
      const id = tombstoneId(['explicit', normalizeForMatch(key), normalizeForMatch(from), normalizeForMatch(to), input.sourceMessageId]);
      const existing = this.state.tombstones.find((t) => t.id === id);
      if (existing) return existing;

      const appliesToSource = (msgId: string) => this.isBefore(msgId, seq);

      const tombstone: Tombstone = {
        id,
        supersededContent: from,
        originalMessageId: this.findStatementOf(from, to, appliesToSource) ?? input.sourceMessageId,
        correctionMessageId: input.sourceMessageId,
        reason: input.reason?.trim() || `Declared correction (message ${input.sourceMessageId})`,
        timestamp: input.timestamp ?? this.timestampOf(input.sourceMessageId) ?? Date.now(),
        key,
        correctedValue: to,
        confidence: 'explicit',
      };
      this.state.tombstones.push(tombstone);
      applyTombstone(this.state, tombstone, { appliesToSource });
      if (this.state.l0_messages.some((m) => this.isBefore(m.id, seq))) {
        this.pendingCorrections.push({ tombstone, seq });
      }
      return tombstone;
    });
  }

  /**
   * Undo a correction (explicit or inferred): remove its tombstone and
   * restore everything archived under it. Resolves false for an unknown id.
   */
  revertCorrection(tombstoneId: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.pendingCorrections = this.pendingCorrections.filter((p) => p.tombstone.id !== tombstoneId);
      return revertTombstone(this.state, tombstoneId);
    });
  }

  /**
   * Retract messages (e.g. the chunks of a document that was re-ingested):
   * corrections they made are reverted, they leave L0, and every L1–L4
   * item derived only from them is archived with reason `retracted`.
   * Resolves to the number of items archived.
   */
  retract(messageIds: string[], label = 'retracted'): Promise<number> {
    return this.enqueue(async () => retractMessages(this.state, messageIds, label));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Compact the oldest `count` L0 messages. Messages added while the
   * compactor runs stay in L0; if the compactor throws, nothing leaves L0.
   */
  private async compactHead(count: number): Promise<void> {
    if (count <= 0) return;
    const overflow = this.state.l0_messages.slice(0, count);
    const view: CompactedState = { ...this.state, l0_messages: this.state.l0_messages.slice(count) };
    const next = await this.compactor.compact(overflow, CL.L1_COMPACTED, view);
    const compacted = new Set(overflow);
    next.l0_messages = this.state.l0_messages.filter((m) => !compacted.has(m));
    this.replaceState(next);
    this.applyPendingCorrections(overflow);
    this.redisplaceTruth();
  }

  /** Swap in a compactor's result, keeping span pins set while it ran. */
  private replaceState(next: CompactedState): void {
    for (const [hash, span] of Object.entries(this.state.spans ?? {})) {
      const carried = next.spans?.[hash];
      if (span.pinned && carried) carried.pinned = true;
    }
    this.state = next;
  }

  private applyPendingCorrections(compacted: ConversationMessage[]): void {
    if (this.pendingCorrections.length === 0) return;
    for (const { tombstone, seq } of this.pendingCorrections) {
      const older = new Set(compacted.filter((m) => this.isBefore(m.id, seq)).map((m) => m.id));
      if (older.size > 0) applyTombstone(this.state, tombstone, { appliesToSource: (id) => older.has(id) });
    }
    this.pendingCorrections = this.pendingCorrections.filter(({ seq }) =>
      this.state.l0_messages.some((m) => this.isBefore(m.id, seq)),
    );
  }

  /** Re-run ledger displacement after a compaction replaced the state. */
  private redisplaceTruth(): void {
    if (!this.truthSelection) return;
    this.state.l4_invariants = displaceStaleInvariants(this.state.l4_invariants, this.truthSelection).kept;
  }

  private isBefore(messageId: string, seq: number): boolean {
    const own = this.seqOf.get(messageId);
    return own === undefined || own < seq;
  }

  private timestampOf(messageId: string): number | undefined {
    const inL0 = this.state.l0_messages.find((m) => m.id === messageId);
    if (inL0) return normalizeTimestamp(inL0.timestamp);
    return this.state.l1_compacted.find((e) => e.originalMessageId === messageId)?.timestamp;
  }

  /** Most recent earlier message that states only `from` — the statement being corrected. */
  private findStatementOf(from: string, to: string, isEarlier: (messageId: string) => boolean): string | undefined {
    const statesOnlyOld = supersededMatcher({ supersededContent: from, correctedValue: to });
    const candidates = [
      ...this.state.l1_compacted.map((e) => ({ id: e.originalMessageId, text: e.compacted })),
      ...this.state.l0_messages.map((m) => ({ id: m.id, text: m.content })),
    ];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const { id, text } = candidates[i];
      if (isEarlier(id) && statesOnlyOld(text)) return id;
    }
    return undefined;
  }

  /**
   * Sync the truth ledger: a stenographer truth stream (JSONL text or
   * lines, read with `parseWikiLines(input, options)`), a stream or merged
   * files already read (`parseWikiLines` / `parseWikiFiles`), or entries.
   * Each sync replaces the selection, so it needs the whole stream: to sync
   * only the lines after the last sync (stenographer's `sinceSeq` export),
   * pass that sync's `read` as `{ base }`, and the increment folds into it.
   * A stream that starts part-way without its base is refused: its
   * TRANSITIONs would miss the entries they change.
   *
   * The synced selection lives beside the LSM levels, not inside them:
   * recompaction can rewrite L4, but it can never rewrite ledger truth,
   * and a UV must never compact into something that reads as proven.
   * Syncing also displaces any L4 invariant projected from an entry that
   * is no longer ground truth (overridden, struck, contested, refuted,
   * inadmissible). A refused stream (a bad hash, identity or chain) syncs
   * as no truth at all — `result.refused` and `result.errors` say why —
   * rather than as whatever its readable lines claim.
   */
  syncTruthLedger(
    input: string | string[] | TruthLedgerEntry[] | WikiParseResult,
    options: TruthReadOptions = {},
  ): TruthSyncResult {
    let entries: TruthLedgerEntry[];
    let errors: TruthSyncResult['errors'] = [];
    let refused = false;
    let read: WikiParseResult | null = null;

    if (typeof input === 'string' || (Array.isArray(input) && (input.length === 0 || typeof input[0] === 'string'))) {
      input = parseWikiLines(input as string | string[], options);
    }
    if (Array.isArray(input)) {
      entries = input as TruthLedgerEntry[];
    } else {
      read = input;
      entries = input.entries;
      errors = input.errors;
      refused = input.refused;
      const start = refused ? undefined : partialStart(input);
      if (start !== undefined) {
        refused = true;
        errors = [
          ...errors,
          { line: 0, error: `the stream starts at seq ${start}, part-way: pass the read it continues as { base } (or the whole stream)` },
        ];
      }
    }

    const selection = selectCurrentTruth(refused ? [] : entries);
    const { kept, displacedKeys } = displaceStaleInvariants(this.state.l4_invariants, selection);
    this.state.l4_invariants = kept;
    this.truthSelection = selection;

    return { selection, displacedInvariantKeys: displacedKeys, errors, refused, read: refused ? null : read };
  }

  /** The most recently synced truth-ledger selection, if any. */
  getTruthSelection(): TruthSelection | undefined {
    return this.truthSelection;
  }

  /**
   * Build a context frame within the token budget.
   *
   * Guarantee: `frame.tokenUsage <= tokenBudget`, where tokenUsage is
   * `estimateTokens(renderContextFrame(frame))` (the package's ~4
   * characters per token estimate — not a model tokenizer count).
   *
   * Sections fill item by item in priority order — ledger truth (a
   * contested TB and its disputing UVs as one unit), corrections (newest
   * first), L4 invariants, then, after holding back up to 25% of the budget
   * for the newest raw messages, memories, pinned code, L3, L2 and L1 —
   * skipping any item that does not fit and continuing with the next.
   * `section.omitted` / `frame.omitted` count what was left out. L0 fills
   * newest-first and stops at the first message that does not fit, so the
   * raw tail stays contiguous.
   */
  buildContextFrame(tokenBudget?: number): ContextFrame {
    const requested = tokenBudget ?? this.config.contextBudget;
    const budgetTokens = Number.isNaN(requested) ? 0 : Math.max(0, Math.floor(requested));
    const budget = new FrameBudget(budgetTokens);
    const built = new Map<ContextSectionKind, { lines: string[]; items: ContextItem[]; omitted: number }>();
    const section = (kind: ContextSectionKind) => {
      let s = built.get(kind);
      if (!s) {
        s = { lines: [], items: [], omitted: 0 };
        built.set(kind, s);
      }
      return s;
    };
    /** Add one item if it fits (with any extra lines, e.g. a heading, first). */
    const offer = (kind: ContextSectionKind, text: string, sources: string[], reserveChars = 0, extra: string[] = []): boolean => {
      const s = section(kind);
      const lines = s.lines.length === 0 ? [...extra, text] : [text];
      if (!budget.fits(lines, reserveChars)) {
        s.omitted += 1;
        return false;
      }
      budget.take(lines);
      s.lines.push(...lines);
      s.items.push({ text, sources });
      return true;
    };

    // Truth ledger: asserted truth outranks everything derived.
    if (this.truthSelection) {
      for (const item of renderTruthItems(this.truthSelection)) {
        offer('truth', item.text, item.sources, 0, [TRUTH_SECTION_HEADING]);
      }
    }

    // Corrections outrank every derived level: newest selected first,
    // emitted oldest first.
    const corrections: Array<{ index: number; item: ContextItem }> = [];
    this.state.tombstones.forEach((t, index) => {
      if (!t.supersededContent) return;
      const confidence = t.confidence === 'inferred' ? ' (inferred)' : '';
      const text = `[correction] ${line(
        `"${t.supersededContent}" was corrected to "${t.correctedValue ?? '(unspecified)'}"${confidence} — ${t.reason}`,
      )}`;
      corrections.push({ index, item: { text, sources: uniq([t.id, t.correctionMessageId]) } });
    });
    this.fillNewestFirst('correction', corrections, offer, built);

    // L4 invariants: newest selected first, emitted in state order
    const invariants = this.state.l4_invariants.map((inv, index) => ({
      index,
      item: { text: `[invariant] ${line(`${inv.key}: ${inv.value}`)}`, sources: [inv.sourceMessage] },
    }));
    this.fillNewestFirst('invariant', invariants, offer, built);

    // L0 reservation: hold back up to L0_RESERVE_SHARE of the budget for
    // the most recent raw messages so derived levels can't starve them.
    const recentLines = [...this.state.l0_messages].reverse().map((m) => ({
      text: `${m.role}: ${escapeUntrusted(m.content)}`,
      sources: [m.id],
    }));
    const reserveTokens = Math.floor(budgetTokens * L0_RESERVE_SHARE);
    let reserveChars = 0;
    for (const { text } of recentLines) {
      if (Math.ceil((reserveChars + text.length + 1) / 4) > reserveTokens) break;
      reserveChars += text.length + 1;
    }

    // Active engrams — interpreter step runs here, before injection. Only
    // memories that make it into the frame count against maxRetrievals.
    if (this.activeEngramStore) {
      const recentContext = this.state.l0_messages.slice(-3).map((m) => m.content).join(' ');
      const results = this.activeEngramStore.select(recentContext, Date.now(), { maxContextChars: ENGRAM_CONTEXT_CHARS });
      const surfaced = results.filter((r) =>
        offer('memory', `[memory] ${line(r.interpreted)}`, uniq([r.engramId, r.shadows]), reserveChars),
      );
      this.activeEngramStore.markSurfaced(surfaced);
    }

    // Pinned code spans, verbatim
    const spans = this.state.spans ?? {};
    const shownSpans = new Set<string>();
    for (const span of Object.values(spans) as CodeSpan[]) {
      if (!span.pinned) continue;
      const text = `[code sha256:${spanRef(span.hash)}]\n${escapeUntrusted(span.text)}`;
      if (offer('code', text, [span.hash, span.sourceMessageId], reserveChars)) shownSpans.add(span.hash);
    }

    // L3: entity-relationship graph
    for (const entity of this.state.l3_graph.entities.values()) {
      offer('graph', `[entity] ${line(`${entity.name} (${entity.type})`)}`, uniq([entity.firstMention, entity.lastMention]), reserveChars);
    }
    for (const edge of this.state.l3_graph.edges) {
      offer('graph', `[edge] ${line(`${edge.source} --${edge.relation}--> ${edge.target}`)}`, [edge.sourceMessage], reserveChars);
    }

    // L2: topic summaries (most recent first)
    for (const summary of [...this.state.l2_summaries].reverse()) {
      // A decision summary whose decisions were all superseded is history
      if (summary.decisions.length > 0 && summary.decisions.every((d) => d.superseded)) continue;
      const sources = summary.decisions.length > 0
        ? uniq(summary.decisions.map((d) => d.messageId))
        : uniq([summary.messageRange.first, summary.messageRange.last]);
      offer('summary', `[summary] ${line(`${summary.topic}: ${summary.summary}`)}`, sources, reserveChars);
    }

    // L1: compacted history. Selected high importance first (ties: most
    // recent first), then emitted in conversation order. An entry whose
    // code does not fit is shown with `[code sha256:…]` references.
    const rankedL1 = this.state.l1_compacted
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => b.entry.importance - a.entry.importance || b.index - a.index);
    const historyItems: Array<{ index: number; item: ContextItem }> = [];
    for (const { entry, index } of rankedL1) {
      const sources = [entry.originalMessageId, ...(entry.foldedMessageIds ?? [])];
      const full = renderEntry(entry, spans, shownSpans);
      const candidates = entry.spanIds?.length ? [full, renderEntry(entry, spans, true)] : [full];
      const text = candidates.find((c) => budget.fits([c], reserveChars));
      if (text === undefined) {
        section('history').omitted += 1;
        continue;
      }
      budget.take([text]);
      historyItems.push({ index, item: { text, sources } });
    }
    if (historyItems.length > 0) {
      const s = section('history');
      historyItems.sort((a, b) => a.index - b.index);
      s.items = historyItems.map((h) => h.item);
      s.lines = s.items.map((i) => i.text);
    }

    // L0: raw recent messages — newest first, contiguous, emitted in order
    const recent: ContextItem[] = [];
    for (const item of recentLines) {
      if (!budget.fits([item.text])) {
        section('recent').omitted = recentLines.length - recent.length;
        break;
      }
      budget.take([item.text]);
      recent.unshift(item);
    }
    if (recent.length > 0) {
      const s = section('recent');
      s.items = recent;
      s.lines = recent.map((i) => i.text);
    }

    const sections: ContextSection[] = [];
    const omitted: ContextFrame['omitted'] = {};
    for (const kind of SECTION_ORDER) {
      const s = built.get(kind);
      if (!s) continue;
      if (s.omitted > 0) omitted[kind] = s.omitted;
      if (s.items.length === 0) continue;
      const content = s.lines.join('\n');
      sections.push({
        kind,
        level: SECTION_LEVEL[kind],
        content,
        tokenEstimate: estimateTokens(content),
        items: s.items,
        omitted: s.omitted,
      });
    }

    return { tokenBudget: budgetTokens, tokenUsage: budget.tokens(), sections, omitted };
  }

  /** Select items newest (highest index) first; emit them in index order. */
  private fillNewestFirst(
    kind: ContextSectionKind,
    candidates: Array<{ index: number; item: ContextItem }>,
    offer: (kind: ContextSectionKind, text: string, sources: string[]) => boolean,
    built: Map<ContextSectionKind, { lines: string[]; items: ContextItem[]; omitted: number }>,
  ): void {
    const chosen: Array<{ index: number; item: ContextItem }> = [];
    for (const candidate of [...candidates].reverse()) {
      if (offer(kind, candidate.item.text, candidate.item.sources)) chosen.push(candidate);
    }
    const s = built.get(kind);
    if (!s || chosen.length === 0) return;
    chosen.sort((a, b) => a.index - b.index);
    s.items = chosen.map((c) => c.item);
    s.lines = s.items.map((i) => i.text);
  }

  /** Get the current compacted state. */
  getState(): CompactedState {
    return this.state;
  }

  /** Get the current L0 messages. */
  getMemtable(): ConversationMessage[] {
    return this.state.l0_messages;
  }

  /**
   * Look up a code span by its sha256 hash, or by the 12-character prefix
   * frames show in `[code sha256:…]` references.
   */
  getSpan(hashOrPrefix: string): CodeSpan | undefined {
    const spans = this.state.spans ?? {};
    if (spans[hashOrPrefix]) return spans[hashOrPrefix];
    if (hashOrPrefix.length < 8) return undefined;
    const matches = Object.keys(spans).filter((h) => h.startsWith(hashOrPrefix));
    return matches.length === 1 ? spans[matches[0]] : undefined;
  }

  /** Pin a code span: it gets its own frame section, budgeted before L3–L1. */
  pinSpan(hashOrPrefix: string): boolean {
    const span = this.getSpan(hashOrPrefix);
    if (!span) return false;
    span.pinned = true;
    return true;
  }

  /** Undo `pinSpan`. */
  unpinSpan(hashOrPrefix: string): boolean {
    const span = this.getSpan(hashOrPrefix);
    if (!span) return false;
    delete span.pinned;
    return true;
  }

  /** Replace the compactor (e.g., when upgrading from regex to host LLM). */
  setCompactor(compactor: Compactor): void {
    this.compactor = compactor;
  }

  /** Attach an ActiveEngramStore so agential memories participate in context frames. */
  attachActiveEngrams(store: ActiveEngramStore): void {
    this.activeEngramStore = store;
  }

  private resolveCompactor(): Compactor {
    // For v0.1.0, only regex is implemented
    switch (this.config.preferredTier) {
      case 'regex':
        return new RegexCompactor();
      case 'local':
      case 'host':
        if (this.config.autoFallback) {
          return new RegexCompactor();
        }
        throw new Error(`Compactor tier "${this.config.preferredTier}" not yet implemented`);
      default:
        return new RegexCompactor();
    }
  }
}
