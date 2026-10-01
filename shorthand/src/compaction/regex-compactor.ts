/**
 * Tier 0: RegexCompactor
 *
 * Rule-based extraction using pattern matching. Zero external dependencies.
 * Catches obvious patterns like "chose X," "rejected Y because Z," "actually, use W."
 * Estimated recall: ~20-30% of real-world decisions.
 *
 * Fidelity rules: L1 keeps each message's text verbatim — no words are
 * removed or rewritten, fenced code blocks included (they are also indexed
 * in the content-addressed span store, `state.spans`). The only L1 edits
 * are dropping pure acknowledgements/greetings and folding a short reply
 * into the question it answers ("Which port? → 8080").
 *
 * Corrections the patterns detect are tombstoned as `inferred` (low
 * confidence) and applied reversibly: superseded items at every level are
 * archived under the tombstone id, never deleted. A correction whose
 * superseded value is empty, a pronoun or a function word ("change it to
 * blue") produces no tombstone.
 *
 * Cost: extraction reads at most MAX_EXTRACTION_CHARS of prose per message
 * (code spans excluded), split into sentence windows of at most
 * MAX_SENTENCE_CHARS, with bounded captures — linear in message length.
 */

import type {
  ArchivedItem,
  Compactor,
  CompactedEntry,
  CompactedState,
  CompactionLevel,
  ConversationMessage,
  CodeSpan,
  Decision,
  Entity,
  Tombstone,
  TopicSummary,
  Invariant,
} from '../types.js';
import { normalizeTimestamp } from '../types.js';
import {
  MAX_EXTRACTION_CHARS,
  MAX_SENTENCE_CHARS,
  estimateTokens,
  generateId,
  sha256Hex,
  splitSentences,
} from '../utils.js';
import { applyTombstone, sameEdge } from './corrections.js';
import { isValidCorrectionSubject, normalizeForMatch, supersededMatcher, tombstoneId } from './matching.js';
import { spanRef } from './frame.js';

/** Deep clone a CompactedState, preserving Map types. */
function cloneState(state: CompactedState): CompactedState {
  const cloned: CompactedState = {
    l0_messages: state.l0_messages.map((m) => ({ ...m })),
    l1_compacted: state.l1_compacted.map(cloneEntry),
    l2_summaries: state.l2_summaries.map(cloneSummary),
    l3_graph: {
      entities: new Map(
        Array.from(state.l3_graph.entities.entries()).map(([k, v]) => [
          k,
          { ...v, properties: { ...v.properties } },
        ]),
      ),
      edges: state.l3_graph.edges.map((e) => ({ ...e, properties: { ...e.properties } })),
    },
    l4_invariants: state.l4_invariants.map((i) => ({ ...i })),
    tombstones: state.tombstones.map((t) => ({ ...t })),
    totalTokenEstimate: state.totalTokenEstimate,
    archive: (state.archive ?? []).map(cloneArchived),
    spans: Object.fromEntries(Object.entries(state.spans ?? {}).map(([k, v]) => [k, { ...v }])),
  };
  return cloned;
}

function cloneArchived(a: ArchivedItem): ArchivedItem {
  switch (a.kind) {
    case 'message':
      return { ...a, message: { ...a.message } };
    case 'l1':
      return { ...a, entry: cloneEntry(a.entry) };
    case 'summary':
      return { ...a, summary: cloneSummary(a.summary) };
    case 'entity':
      return { ...a, entity: { ...a.entity, properties: { ...a.entity.properties } } };
    case 'edge':
      return { ...a, edge: { ...a.edge, properties: { ...a.edge.properties } } };
    case 'invariant':
      return { ...a, invariant: { ...a.invariant } };
  }
}

function cloneEntry(e: CompactedEntry): CompactedEntry {
  return {
    ...e,
    ...(e.spanIds ? { spanIds: [...e.spanIds] } : {}),
    ...(e.foldedMessageIds ? { foldedMessageIds: [...e.foldedMessageIds] } : {}),
  };
}

function cloneSummary(s: TopicSummary): TopicSummary {
  return {
    ...s,
    decisions: s.decisions.map((d) => ({
      ...d,
      alternatives: d.alternatives.map((a) => ({ ...a })),
    })),
    entityNames: [...s.entityNames],
    messageRange: { ...s.messageRange },
  };
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface PatternMatch {
  type: 'decision' | 'correction' | 'entity' | 'constraint';
  content: string;
  details: Record<string, string>;
}

type Pattern = { regex: RegExp; extract: (m: RegExpMatchArray) => PatternMatch };

// Captures are bounded (`.{1,N}?`) so a keyword never rescans a whole
// window; windows themselves are at most MAX_SENTENCE_CHARS long. A capture
// ends at sentence punctuation followed by whitespace, or at the window's
// end (`(?:[.!?]+(?=\s|$)|$)`), never at a dot inside a token: `3.12`,
// `10.0.0.5` and `config.prod.yaml` stay whole.

const DECISION_PATTERNS: Pattern[] = [
  {
    regex: /\b(?:let'?s?|we(?:'ll)?|I(?:'ll)?)\s+(?:go with|use|choose|pick|stick with)\s+(.{1,160}?)(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'decision',
      content: m[0],
      details: { chosen: m[1].trim() },
    }),
  },
  {
    regex: /\b(?:chose|decided on|going with|selected|picked)\s+(.{1,160}?)(?:\s+(?:over|instead of|rather than)\s+(.{1,160}?))?(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'decision',
      content: m[0],
      details: { chosen: m[1].trim(), ...(m[2] ? { rejected: m[2].trim() } : {}) },
    }),
  },
  {
    regex: /\b(?:rejected|ruled out|eliminated|won't use|not going with)\s+(.{1,160}?)(?:\s+because\s+(.{1,240}?))?(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'decision',
      content: m[0],
      details: { rejected: m[1].trim(), ...(m[2] ? { reason: m[2].trim() } : {}) },
    }),
  },
];

/** "<new>, not <old>" / "<new> instead of <old>" / "<new> rather than <old>". */
const REPLACEMENT_RE = /^(.+?)(?:,\s*not|,?\s+instead of|,?\s+rather than)\s+(.+)$/i;
const LEADING_FILLER_RE = /^(?:we(?:'re| are) using|it(?:'s| is)|use|using)\s+/i;

/** Split a correction's captured text into from/to when it names both sides. */
function splitReplacement(text: string): { from?: string; to?: string } {
  const m = text.trim().match(REPLACEMENT_RE);
  if (!m) return {};
  const from = m[2].trim();
  let to = m[1].trim();
  const stripped = to.replace(LEADING_FILLER_RE, '').trim();
  if (stripped) to = stripped;
  return from && to ? { from, to } : {};
}

const CORRECTION_PATTERNS: Pattern[] = [
  {
    // Whole-word keywords only ("await" and "Factually" are not
    // corrections). A bare "instead" is a keyword; "instead of" is the
    // replacement form handled by the "use X instead of Y" pattern below.
    regex: /\b(?:actually|wait|correction|no,?\s+(?:let's|we should)|instead(?!\s+of\b)|scratch that|change that to)\b\s*[,:]?\s*(.{1,200}?)(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'correction',
      content: m[0],
      details: { correctedTo: m[1].trim(), ...splitReplacement(m[1]) },
    }),
  },
  {
    // "use X instead of Y" with no correction keyword in front
    regex: /\b(?:use|using|go with|switch to|pick|choose|prefer)\s+(.{1,160}?),?\s+(?:instead of|rather than)\s+(.{1,160}?)(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'correction',
      content: m[0],
      details: { from: m[2].trim(), to: m[1].trim() },
    }),
  },
  {
    regex: /\b(?:swap|change|switch|replace)\s+(.{1,160}?)\s+(?:to|with|for)\s+(.{1,160}?)(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'correction',
      content: m[0],
      details: { from: m[1].trim(), to: m[2].trim() },
    }),
  },
];

const ENTITY_PATTERNS: Pattern[] = [
  {
    regex: /\b(?:using|implement(?:ing)?|build(?:ing)?|creat(?:e|ing))\s+(?:a\s+)?(.{1,120}?)(?:\s+(?:for|to|with|in)\s+(.{1,240}?))?(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'entity',
      content: m[0],
      details: { name: m[1].trim(), ...(m[2] ? { context: m[2].trim() } : {}) },
    }),
  },
];

const CONSTRAINT_PATTERNS: Pattern[] = [
  {
    regex: /\b(?:must not|should not|cannot|must|should|need to|required to|has to)\s+(.{1,200}?)(?:[.!?]+(?=\s|$)|$)/gi,
    extract: (m) => ({
      type: 'constraint',
      content: m[0],
      details: { constraint: m[1].trim() },
    }),
  },
];

// ---------------------------------------------------------------------------
// Noise detection
// ---------------------------------------------------------------------------

const ACK = '(?:ok(?:ay)?|k|kk|sure|thanks?|thank you|got it|sounds good|great|perfect|yes|yeah|no|right|exactly|yep|yup|nope)';

const NOISE_PATTERNS = [
  // One or more bare acks, optionally led by "lol"/"haha": "Thanks!", "lol ok, great"
  new RegExp(`^(?:(?:lol|haha)[,\\s]+)?${ACK}(?:[,\\s]+${ACK})*[.!]*$`, 'i'),
  /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[\s!.]*$/i,
  /^(?:let me know|feel free|no worries|no problem)[\s.]*$/i,
];

/**
 * Pure acknowledgements and greetings. Short messages are not noise by
 * length: "8080" and "v2" are answers.
 */
function isNoise(trimmed: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(trimmed));
}

/** Replies short enough to fold into the question they answer. */
const MAX_FOLDED_REPLY_CHARS = 40;

/** Importance floor of a question with its answer folded in. */
const ANSWERED_QUESTION_IMPORTANCE = 0.3;

function isQuestion(text: string): boolean {
  return /\?\s*$/.test(text);
}

// ---------------------------------------------------------------------------
// Code spans
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = /```[\s\S]*?```/g;

/** Fenced code blocks in order of appearance. */
function findCodeSpans(content: string): string[] {
  return content.match(CODE_BLOCK_RE) ?? [];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Run every pattern over bounded sentence windows of the message prose.
 * Questions never yield decisions, corrections or constraints ("Should we
 * deploy on Friday?" is not an invariant).
 */
function extractPatterns(prose: string): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const windows = splitSentences(prose.slice(0, MAX_EXTRACTION_CHARS), MAX_SENTENCE_CHARS);

  for (const raw of windows) {
    const window = raw.trim();
    if (!window) continue;
    const question = isQuestion(window);
    const groups = question
      ? [ENTITY_PATTERNS]
      : [DECISION_PATTERNS, CORRECTION_PATTERNS, ENTITY_PATTERNS, CONSTRAINT_PATTERNS];
    for (const patterns of groups) {
      for (const { regex, extract } of patterns) {
        regex.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(window)) !== null) {
          matches.push(extract(m));
          if (m[0].length === 0) regex.lastIndex++;
        }
      }
    }
  }

  return matches;
}

function createEmptyState(): CompactedState {
  return {
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

/** L1 entries per L2 discussion block. */
const SUMMARY_WINDOW = 5;
/** Characters of L1 text an L2 discussion block keeps. */
const SUMMARY_CHARS = 500;
/** Id prefix of discussion-block summaries (keyed by message range). */
const DISCUSSION_PREFIX = 'l2:';

export class RegexCompactor implements Compactor {
  readonly tier = 'regex' as const;

  async compact(
    messages: ConversationMessage[],
    targetLevel: CompactionLevel,
    currentState?: CompactedState,
  ): Promise<CompactedState> {
    const state = currentState ? cloneState(currentState) : createEmptyState();

    let previous: ConversationMessage | undefined;
    for (const msg of messages) {
      this.processMessage(msg, state, previous);
      previous = msg;
    }

    state.totalTokenEstimate = this.computeTokenEstimate(state);
    return state;
  }

  async recompact(
    state: CompactedState,
    targetLevel: CompactionLevel,
  ): Promise<CompactedState> {
    const result = cloneState(state);

    if (targetLevel >= 2) {
      this.buildTopicSummaries(result);
    }
    if (targetLevel >= 3) {
      this.promoteToGraph(result);
    }
    if (targetLevel >= 4) {
      this.promoteToInvariants(result);
    }

    result.totalTokenEstimate = this.computeTokenEstimate(result);
    return result;
  }

  // -----------------------------------------------------------------------
  // Internal processing
  // -----------------------------------------------------------------------

  private processMessage(
    msg: ConversationMessage,
    state: CompactedState,
    previous: ConversationMessage | undefined,
  ): void {
    const timestamp = normalizeTimestamp(msg.timestamp);
    const codeSpans = findCodeSpans(msg.content);
    const spanIds = codeSpans.map((text) => this.storeSpan(state, text, msg.id));
    // Code is kept and indexed, not mined: patterns run on the prose only
    const prose = codeSpans.length > 0 ? msg.content.replace(CODE_BLOCK_RE, '\n') : msg.content;
    const patterns = extractPatterns(prose);

    // Corrections → tombstones. Several patterns can match the same
    // correction ("Actually, use X instead of Y"); the content-derived id
    // records it once. Keyword-only corrections ("Wait, …") name no
    // superseded value: they raise importance but are not tombstoned.
    const known = new Set(state.tombstones.map((t) => t.id));
    for (const match of patterns.filter((p) => p.type === 'correction')) {
      const from = match.details.from;
      const to = match.details.to;
      if (!isValidCorrectionSubject(from) || !to?.trim()) continue;
      if (normalizeForMatch(from) === normalizeForMatch(to)) continue;
      const id = tombstoneId(['inferred', normalizeForMatch(from), normalizeForMatch(to), msg.id]);
      if (known.has(id)) continue;
      known.add(id);
      const tombstone: Tombstone = {
        id,
        supersededContent: from,
        originalMessageId: this.findRelatedMessage(from, to, state) ?? msg.id,
        correctionMessageId: msg.id,
        reason: match.content,
        timestamp,
        key: from,
        correctedValue: to,
        confidence: 'inferred',
      };
      state.tombstones.push(tombstone);
      // Runs before this message's own entries are added, so the
      // correction itself is never archived.
      applyTombstone(state, tombstone);
    }

    // Handle decisions
    for (const match of patterns.filter((p) => p.type === 'decision')) {
      const decision: Decision = {
        description: match.content,
        chosen: match.details.chosen ?? '',
        alternatives: match.details.rejected
          ? [{ option: match.details.rejected, reason: match.details.reason ?? '' }]
          : [],
        messageId: msg.id,
        superseded: false,
      };
      // Check if this decision supersedes a previous one
      this.checkDecisionSupersession(decision, state);
      // Store as L2 summary fragment
      const summary: TopicSummary = {
        id: generateId(),
        topic: match.details.chosen ? `Decision: ${match.details.chosen}` : `Rejected: ${match.details.rejected}`,
        summary: match.content,
        decisions: [decision],
        entityNames: [],
        messageRange: { first: msg.id, last: msg.id },
        tokenEstimate: estimateTokens(match.content),
      };
      state.l2_summaries.push(summary);
    }

    // Handle entities → add to L3 graph
    for (const match of patterns.filter((p) => p.type === 'entity')) {
      const entityName = match.details.name;
      if (entityName && entityName.length > 1) {
        const existing = state.l3_graph.entities.get(entityName);
        if (existing) {
          existing.lastMention = msg.id;
        } else {
          const entity: Entity = {
            name: entityName,
            type: 'artifact',
            properties: match.details.context ? { context: match.details.context } : {},
            firstMention: msg.id,
            lastMention: msg.id,
          };
          state.l3_graph.entities.set(entityName, entity);
        }
      }
    }

    // Handle constraints → promote to L4 if strong enough
    for (const match of patterns.filter((p) => p.type === 'constraint')) {
      const invariant: Invariant = {
        key: match.details.constraint.slice(0, 50),
        value: match.content,
        sourceMessage: msg.id,
        timestamp,
      };
      state.l4_invariants.push(invariant);
    }

    // L1: keep the message verbatim; drop only pure acks and greetings, and
    // fold a short reply into the question it answers.
    const trimmed = msg.content.trim();
    if (!trimmed) return;
    const importance = this.quickImportance(patterns, codeSpans.length > 0);

    const last = state.l1_compacted[state.l1_compacted.length - 1];
    const lastIsPrevious = previous === undefined || previous.id === last?.originalMessageId;
    if (
      last &&
      lastIsPrevious &&
      last.role !== undefined &&
      last.role !== msg.role &&
      isQuestion(last.compacted) &&
      trimmed.length <= MAX_FOLDED_REPLY_CHARS &&
      !trimmed.includes('\n')
    ) {
      last.compacted = `${last.compacted} → ${trimmed}`;
      last.foldedMessageIds = [...(last.foldedMessageIds ?? []), msg.id];
      last.importance = Math.max(last.importance, importance, ANSWERED_QUESTION_IMPORTANCE);
      return;
    }

    if (isNoise(trimmed)) return;

    state.l1_compacted.push({
      originalMessageId: msg.id,
      compacted: trimmed,
      importance,
      timestamp,
      role: msg.role,
      ...(spanIds.length > 0 ? { spanIds } : {}),
    });
  }

  private storeSpan(state: CompactedState, text: string, messageId: string): string {
    const hash = sha256Hex(text);
    if (!state.spans) state.spans = {};
    if (!state.spans[hash]) {
      const span: CodeSpan = { hash, text, sourceMessageId: messageId };
      state.spans[hash] = span;
    }
    return hash;
  }

  private quickImportance(patterns: PatternMatch[], hasCode: boolean): number {
    let score = 0;
    if (patterns.some((p) => p.type === 'correction')) score += 0.4;
    if (patterns.some((p) => p.type === 'decision')) score += 0.3;
    if (patterns.some((p) => p.type === 'constraint')) score += 0.2;
    if (patterns.some((p) => p.type === 'entity')) score += 0.1;
    if (hasCode) score += 0.2;
    return Math.min(1.0, score);
  }

  private findRelatedMessage(from: string, to: string, state: CompactedState): string | undefined {
    // Most recent statement of only the old value is the one being corrected
    const statesOnlyOld = supersededMatcher({ supersededContent: from, correctedValue: to });
    for (let i = state.l1_compacted.length - 1; i >= 0; i--) {
      if (statesOnlyOld(state.l1_compacted[i].compacted)) return state.l1_compacted[i].originalMessageId;
    }
    return undefined;
  }

  private checkDecisionSupersession(decision: Decision, state: CompactedState): void {
    // Check if any existing decision covers the same topic and should be superseded
    for (const summary of state.l2_summaries) {
      for (const existingDecision of summary.decisions) {
        if (
          existingDecision.chosen &&
          decision.alternatives.some((a) => a.option === existingDecision.chosen)
        ) {
          existingDecision.superseded = true;
        }
      }
    }
  }

  /**
   * L1 → L2: fold L1 entries into discussion blocks of SUMMARY_WINDOW
   * entries. Summarized entries move from L1 to the archive (reason
   * `summarized`), so recompaction is idempotent and frames never carry the
   * same text twice. Blocks are keyed by their message range. Windows whose
   * average importance is too low to summarize stay in L1.
   */
  private buildTopicSummaries(state: CompactedState): void {
    const archive = state.archive ?? (state.archive = []);
    const existingIds = new Set(state.l2_summaries.map((s) => s.id));
    let blockCount =
      state.l2_summaries.filter((s) => s.id.startsWith(DISCUSSION_PREFIX)).length +
      archive.filter((a) => a.kind === 'summary' && a.summary.id.startsWith(DISCUSSION_PREFIX)).length;

    const entries = state.l1_compacted;
    const summarized = new Set<CompactedEntry>();
    for (let i = 0; i < entries.length; i += SUMMARY_WINDOW) {
      const window = entries.slice(i, i + SUMMARY_WINDOW);
      if (window.length === 0) continue;

      const avgImportance = window.reduce((sum, e) => sum + e.importance, 0) / window.length;
      if (avgImportance <= 0.2) continue;

      const first = window[0].originalMessageId;
      const last = window[window.length - 1].originalMessageId;
      const id = `${DISCUSSION_PREFIX}${first}..${last}`;
      if (!existingIds.has(id)) {
        // Code spans are referenced by hash, never cut mid-block
        const combined = window.map((e) => this.withSpanReferences(e, state)).join(' ');
        const text = combined.slice(0, SUMMARY_CHARS);
        blockCount += 1;
        state.l2_summaries.push({
          id,
          topic: `Discussion block ${blockCount}`,
          summary: text,
          decisions: [],
          entityNames: [],
          messageRange: { first, last },
          tokenEstimate: estimateTokens(text),
        });
        existingIds.add(id);
      }
      for (const entry of window) {
        summarized.add(entry);
        archive.push({ kind: 'l1', reason: 'summarized', by: id, entry });
      }
    }
    state.l1_compacted = entries.filter((e) => !summarized.has(e));
  }

  private withSpanReferences(entry: CompactedEntry, state: CompactedState): string {
    let text = entry.compacted;
    for (const hash of entry.spanIds ?? []) {
      const span = state.spans?.[hash];
      if (span) text = text.split(span.text).join(`[code sha256:${spanRef(hash)}]`);
    }
    return text;
  }

  private promoteToGraph(state: CompactedState): void {
    // Extract entity relationships from L2 summaries
    for (const summary of state.l2_summaries) {
      for (const decision of summary.decisions) {
        if (decision.chosen && !decision.superseded) {
          const entityName = decision.chosen;
          if (!state.l3_graph.entities.has(entityName)) {
            state.l3_graph.entities.set(entityName, {
              name: entityName,
              type: 'decision',
              properties: { description: decision.description },
              firstMention: decision.messageId,
              lastMention: decision.messageId,
            });
          }

          // Add rejection edges, once per (source, relation, target)
          for (const alt of decision.alternatives) {
            if (alt.option) {
              if (!state.l3_graph.entities.has(alt.option)) {
                state.l3_graph.entities.set(alt.option, {
                  name: alt.option,
                  type: 'technology',
                  properties: {},
                  firstMention: decision.messageId,
                  lastMention: decision.messageId,
                });
              }
              const edge = {
                source: entityName,
                target: alt.option,
                relation: 'rejected_in_favor_of' as const,
                properties: { reason: alt.reason },
                sourceMessage: decision.messageId,
              };
              if (!state.l3_graph.edges.some((e) => sameEdge(e, edge))) {
                state.l3_graph.edges.push(edge);
              }
            }
          }
        }
      }
    }
  }

  private promoteToInvariants(state: CompactedState): void {
    // Deduplicate invariants by key, keeping latest
    const byKey = new Map<string, Invariant>();
    for (const inv of state.l4_invariants) {
      const existing = byKey.get(inv.key);
      if (!existing || inv.timestamp > existing.timestamp) {
        byKey.set(inv.key, inv);
      }
    }
    state.l4_invariants = Array.from(byKey.values());
  }

  private computeTokenEstimate(state: CompactedState): number {
    let total = 0;
    for (const msg of state.l0_messages) {
      total += estimateTokens(msg.content);
    }
    for (const entry of state.l1_compacted) {
      total += estimateTokens(entry.compacted);
    }
    for (const summary of state.l2_summaries) {
      total += summary.tokenEstimate;
    }
    for (const [, entity] of state.l3_graph.entities) {
      total += estimateTokens(JSON.stringify(entity));
    }
    for (const inv of state.l4_invariants) {
      total += estimateTokens(inv.value);
    }
    return total;
  }
}
