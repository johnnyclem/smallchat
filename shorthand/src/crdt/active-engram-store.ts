/**
 * ActiveEngramStore — manages agential memory entries (ActiveEngrams).
 *
 * Three design rules encoded here:
 *   1. Interpret before inject: interpret(context) is called on every matched
 *      engram before its text enters a context frame.
 *   2. Activation policy is declarative data evaluated by the store, never
 *      by the engram itself.
 *   3. Safety boundary: activation policies cannot write to importanceScore.
 *      Only setImportance() (a host-controlled method) may do so, and the
 *      engrams handed out by get()/all() are frozen copies.
 *
 * Replication (mergeFrom) is a union of engrams by id plus a union of
 * removal tombstones. The trust model — what a peer can and cannot change —
 * is documented on `mergeFrom` and in docs/crdt-format.md.
 */

import { randomUUID } from 'node:crypto';
import type { ActiveEngram, ActiveEngramResult, ActivationPolicy } from '../types.js';
import {
  RegexInterpreter,
  resolveTemplate,
} from '../interpreter/regex-interpreter.js';
import {
  silentLogger,
  type Interpreter,
  type InterpretOptions,
  type InterpreterLogger,
} from '../interpreter/types.js';
import {
  CRDT_SCHEMA_VERSION,
  canonicalJson,
  checkState,
  checkStringArray,
  compareStrings,
  fail,
  isRecord,
} from './wire.js';

// ---------------------------------------------------------------------------
// Default interpreter template
// ---------------------------------------------------------------------------

/**
 * The default restates the payload once and never interpolates the
 * current context: a template that pastes {{context}} into every memory
 * duplicates the recent conversation once per engram. Supply your own
 * template to use {{context}}.
 */
const DEFAULT_INTERPRETER_TEMPLATE = 'Earlier note, still relevant: {{payload}}';

const DEFAULT_INTERPRET_OPTIONS: InterpretOptions = {
  maxOutputTokens: 120,
  timeoutMs: 4_000,
};

const DEFAULT_FAILED_RETRIEVAL_WEIGHT = 0.25;

/** Origin stamped on engrams by a store constructed without one. */
const DEFAULT_ORIGIN = 'local';

const KIND = 'ActiveEngramStore';

// ---------------------------------------------------------------------------
// Activation policy evaluation (pure function, no side-effects on the engram)
// ---------------------------------------------------------------------------

function isExpired(engram: ActiveEngram, now: number): boolean {
  const { expiresAt } = engram.activationPolicy;
  return expiresAt !== undefined && now >= expiresAt;
}

function withinBudget(engram: ActiveEngram): boolean {
  const { maxRetrievals } = engram.activationPolicy;
  return maxRetrievals === undefined || engram.retrievalCount < maxRetrievals;
}

function isEligible(
  engram: ActiveEngram,
  context: string,
  now: number,
): boolean {
  const { activationPolicy } = engram;

  if (isExpired(engram, now)) return false;
  if (!withinBudget(engram)) return false;

  if (activationPolicy.surfaceWhenTopics.length > 0) {
    const lower = context.toLowerCase();
    const matches = activationPolicy.surfaceWhenTopics.some((topic) =>
      lower.includes(topic.toLowerCase()),
    );
    if (!matches) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Schema (validation of engrams coming from callers, peers and saved state)
// ---------------------------------------------------------------------------

function clampImportance(score: number): number {
  return Math.max(0, Math.min(1, score));
}

/** Copy the declared policy fields, or explain why the policy is invalid. */
function parsePolicy(raw: unknown): ActivationPolicy | string {
  if (!isRecord(raw)) return 'activationPolicy must be an object';
  const topics = raw.surfaceWhenTopics;
  if (!Array.isArray(topics) || topics.some((t) => typeof t !== 'string')) {
    return 'activationPolicy.surfaceWhenTopics must be an array of strings';
  }
  const policy: ActivationPolicy = { surfaceWhenTopics: [...(topics as string[])] };
  if (raw.maxRetrievals !== undefined) {
    if (typeof raw.maxRetrievals !== 'number' || !Number.isFinite(raw.maxRetrievals) || raw.maxRetrievals < 0) {
      return 'activationPolicy.maxRetrievals must be a finite number >= 0';
    }
    policy.maxRetrievals = raw.maxRetrievals;
  }
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)) {
      return 'activationPolicy.expiresAt must be a finite number';
    }
    policy.expiresAt = raw.expiresAt;
  }
  if (raw.shadowsEngramId !== undefined) {
    if (typeof raw.shadowsEngramId !== 'string') return 'activationPolicy.shadowsEngramId must be a string';
    policy.shadowsEngramId = raw.shadowsEngramId;
  }
  return policy;
}

/**
 * Validate an engram and return a normalized copy (declared fields only,
 * importance clamped to [0, 1]), or the reason it is rejected. Untrusted
 * input (a peer's state) never carries its retrieval count over.
 */
function parseEngram(
  raw: unknown,
  defaults: { origin?: string; trusted: boolean },
): ActiveEngram | string {
  if (!isRecord(raw)) return 'engram must be an object';
  if (typeof raw.id !== 'string' || raw.id.length === 0) return 'id must be a non-empty string';
  if (typeof raw.payload !== 'string') return 'payload must be a string';
  if (typeof raw.interpreterTemplate !== 'string') return 'interpreterTemplate must be a string';
  const policy = parsePolicy(raw.activationPolicy);
  if (typeof policy === 'string') return policy;
  if (typeof raw.importanceScore !== 'number' || !Number.isFinite(raw.importanceScore)) {
    return 'importanceScore must be a finite number';
  }
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) {
    return 'createdAt must be a finite number';
  }
  if (raw.derivedFrom !== undefined && typeof raw.derivedFrom !== 'string') {
    return 'derivedFrom must be a string';
  }
  const origin = raw.origin ?? defaults.origin;
  if (typeof origin !== 'string' || origin.length === 0) return 'origin must be a non-empty string';

  const count = raw.retrievalCount;
  const engram: ActiveEngram = {
    id: raw.id,
    payload: raw.payload,
    interpreterTemplate: raw.interpreterTemplate,
    activationPolicy: policy,
    importanceScore: clampImportance(raw.importanceScore),
    createdAt: raw.createdAt,
    retrievalCount:
      defaults.trusted && typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0,
    origin,
  };
  if (raw.derivedFrom !== undefined) engram.derivedFrom = raw.derivedFrom;
  return engram;
}

/** The replicated, immutable part of an engram (what replicas agree on). */
function contentKey(e: ActiveEngram): string {
  return canonicalJson({
    id: e.id,
    payload: e.payload,
    interpreterTemplate: e.interpreterTemplate,
    activationPolicy: e.activationPolicy,
    createdAt: e.createdAt,
    derivedFrom: e.derivedFrom,
    origin: e.origin,
  });
}

function copyEngram(e: ActiveEngram): ActiveEngram {
  return {
    ...e,
    activationPolicy: { ...e.activationPolicy, surfaceWhenTopics: [...e.activationPolicy.surfaceWhenTopics] },
  };
}

function frozenCopy(e: ActiveEngram): Readonly<ActiveEngram> {
  const copy = copyEngram(e);
  Object.freeze(copy.activationPolicy.surfaceWhenTopics);
  Object.freeze(copy.activationPolicy);
  return Object.freeze(copy);
}

// ---------------------------------------------------------------------------
// ActiveEngramStore
// ---------------------------------------------------------------------------

export interface SerializedActiveEngramStore {
  /** Wire-format version (absent on pre-1.0 states). */
  schemaVersion?: typeof CRDT_SCHEMA_VERSION;
  engrams: ActiveEngram[];
  /** Ids of removed engrams (tombstones); a tombstoned id never comes back. */
  removed?: string[];
}

export interface ActiveEngramStoreOptions {
  /**
   * Interpreter used by retrieveAsync / interpretAsync.
   * Defaults to RegexInterpreter (the regex tier).
   * The synchronous retrieve / interpret methods always use the regex tier
   * regardless of this setting — they are the zero-dep fast path.
   */
  interpreter?: Interpreter;
  /**
   * Cost (against maxRetrievals) of a failed interpretation in retrieveAsync.
   * Default: 0.25 — four failures equal one successful surface.
   * The engram is still dropped from the result set on failure; this only
   * affects how aggressively a flaky LM burns through the retrieval budget.
   */
  failedRetrievalWeight?: number;
  /** Logger for interpreter-failure warnings. */
  logger?: InterpreterLogger;
  /**
   * Agent id stamped as `origin` on the engrams this store creates.
   * Default: 'local'. `AgentMemory` passes its agent id.
   */
  origin?: string;
  /**
   * Id generator for new engrams. Ids must be globally unique across every
   * replica the store syncs with. Default: crypto.randomUUID.
   */
  generateId?: () => string;
}

/** Options for `mergeFrom`. */
export interface EngramMergeOptions {
  /**
   * Agent id of the peer the state came from, as authenticated by the
   * transport. Engrams serialized before 1.0 carry no origin and take this
   * one; without it they are rejected.
   */
  from?: string;
}

/** What a `mergeFrom` / `loadFrom` call did. */
export interface EngramMergeReport {
  /** Ids of engrams added to this store. */
  added: string[];
  /** Ids of local engrams deleted by the state's tombstones. */
  removed: string[];
  /** Engrams that failed validation or conflict with the local copy. */
  rejected: Array<{ id: string | null; reason: string }>;
}

/** One recall slot: the corrected engram and the engram that speaks for it. */
interface Slot {
  /** Root of the correction chain — the slot is addressed under its id. */
  root: ActiveEngram;
  /** The newest correction in the chain (the root itself when uncorrected). */
  head: ActiveEngram;
}

export class ActiveEngramStore {
  private engrams = new Map<string, ActiveEngram>();
  private removedIds = new Set<string>();
  private readonly interpreter: Interpreter;
  private readonly failedRetrievalWeight: number;
  private readonly logger: InterpreterLogger;
  private readonly newId: () => string;
  /** Agent id stamped as `origin` on engrams created here. */
  readonly origin: string;

  constructor(opts: ActiveEngramStoreOptions = {}) {
    this.interpreter = opts.interpreter ?? new RegexInterpreter();
    this.failedRetrievalWeight =
      opts.failedRetrievalWeight ?? DEFAULT_FAILED_RETRIEVAL_WEIGHT;
    this.logger = opts.logger ?? silentLogger;
    this.origin = opts.origin ?? DEFAULT_ORIGIN;
    this.newId = opts.generateId ?? randomUUID;
  }

  // -----------------------------------------------------------------------
  // Write path (host-controlled)
  // -----------------------------------------------------------------------

  /**
   * Add a new ActiveEngram. Returns the assigned ID. Throws TypeError on an
   * invalid policy or a non-finite importance score (finite scores are
   * clamped to [0, 1]).
   */
  add(
    payload: string,
    options: {
      interpreterTemplate?: string;
      activationPolicy?: Partial<ActivationPolicy>;
      importanceScore?: number;
      derivedFrom?: string;
    } = {},
  ): string {
    const id = this.newId();
    if (this.engrams.has(id) || this.removedIds.has(id)) {
      throw new Error(`ActiveEngramStore: generated id ${id} is already in use`);
    }
    const parsed = parseEngram(
      {
        id,
        payload,
        interpreterTemplate: options.interpreterTemplate ?? DEFAULT_INTERPRETER_TEMPLATE,
        activationPolicy: { surfaceWhenTopics: [], ...options.activationPolicy },
        importanceScore: options.importanceScore ?? 0.5,
        createdAt: Date.now(),
        derivedFrom: options.derivedFrom,
      },
      { origin: this.origin, trusted: true },
    );
    if (typeof parsed === 'string') throw new TypeError(`ActiveEngramStore.add: ${parsed}`);
    this.engrams.set(id, parsed);
    return id;
  }

  /**
   * Set the importance score for an engram, clamped to [0, 1].
   * This is the ONLY path by which importanceScore may change.
   * Activation policies cannot call this — enforced by the type system
   * (ActivationPolicy has no method access to the store).
   */
  setImportance(id: string, score: number): void {
    if (!Number.isFinite(score)) {
      throw new TypeError('ActiveEngramStore.setImportance: score must be a finite number');
    }
    const engram = this.engrams.get(id);
    if (!engram) return;
    engram.importanceScore = clampImportance(score);
  }

  /**
   * Remove an engram. The removal is recorded as a tombstone that travels
   * with `serialize()`, so merges never bring the engram back and peers
   * that merge this store's state drop it too.
   */
  remove(id: string): boolean {
    if (!this.engrams.delete(id)) return false;
    this.removedIds.add(id);
    return true;
  }

  /** A frozen copy of an engram (mutating it throws in strict mode). */
  get(id: string): Readonly<ActiveEngram> | undefined {
    const engram = this.engrams.get(id);
    return engram ? frozenCopy(engram) : undefined;
  }

  /** Frozen copies of every engram. */
  all(): Readonly<ActiveEngram>[] {
    return Array.from(this.engrams.values(), frozenCopy);
  }

  // -----------------------------------------------------------------------
  // Read path (retrieval + interpretation)
  // -----------------------------------------------------------------------

  /**
   * Retrieve all active engrams eligible for the given context, then apply
   * each engram's interpreter to produce contextualized results.
   *
   * Shadow resolution: if engram B shadows (corrects) engram A, A never
   * surfaces; B's interpretation takes A's slot (`engramId` A, `shadows`
   * B) whenever A or B would have surfaced. See `select`.
   *
   * Results are sorted descending by importanceScore. Every returned
   * engram counts as surfaced (`select` + `markSurfaced`).
   */
  retrieve(context: string, now: number = Date.now()): ActiveEngramResult[] {
    const results = this.select(context, now);
    this.markSurfaced(results);
    return results;
  }

  /**
   * The pure half of `retrieve`: the same results, with no side effects —
   * retrieval counts are untouched. Callers that may not show every result
   * (a token-budgeted context frame) call `markSurfaced` with the ones they
   * actually used, so `maxRetrievals` is only spent on memories that were
   * surfaced.
   *
   * Corrections: engrams linked by `shadowsEngramId` (same origin, the
   * correcting engram not expired) form a chain rooted at the corrected
   * engram. A chain yields at most one result, addressed under the root's
   * id and interpreted from its newest correction (latest `createdAt`, then
   * greatest id). The chain surfaces when any member would be eligible on
   * its own and the newest correction is within its `maxRetrievals`. A
   * corrected engram therefore never surfaces with its stale text, in any
   * context.
   *
   * Results are ordered by importance (descending), then by the slot's
   * `createdAt` and id, so converged replicas list them identically.
   *
   * `maxContextChars` bounds the context interpolated into templates
   * (eligibility still matches against the whole context).
   */
  select(
    context: string,
    now: number = Date.now(),
    options: { maxContextChars?: number } = {},
  ): ActiveEngramResult[] {
    const templateContext =
      options.maxContextChars !== undefined && context.length > options.maxContextChars
        ? context.slice(context.length - options.maxContextChars)
        : context;

    return this.resolveSlots(context, now).map(({ root, head }) =>
      toResult(root, head, resolveTemplate(head.interpreterTemplate, head.payload, templateContext)),
    );
  }

  /**
   * Count results as surfaced: bumps retrievalCount once for each engram a
   * result came from — the slot's engram and, for a shadowed slot, the
   * shadowing engram too (side effect owned by the store, not the policy).
   */
  markSurfaced(results: ActiveEngramResult[]): void {
    const ids = new Set<string>();
    for (const r of results) {
      ids.add(r.engramId);
      if (r.shadows) ids.add(r.shadows);
    }
    for (const id of ids) {
      const engram = this.engrams.get(id);
      if (engram) engram.retrievalCount += 1;
    }
  }

  /**
   * Interpret a single engram against the given context without modifying
   * retrieval counts. Useful for preview/testing.
   */
  interpret(id: string, context: string): ActiveEngramResult | undefined {
    const engram = this.engrams.get(id);
    if (!engram) return undefined;
    return {
      engramId: id,
      interpreted: resolveTemplate(engram.interpreterTemplate, engram.payload, context),
      payload: engram.payload,
      importanceScore: engram.importanceScore,
    };
  }

  // -----------------------------------------------------------------------
  // Async read path (LM-tier interpreter)
  // -----------------------------------------------------------------------

  /**
   * Retrieve all eligible engrams against the given context, calling the
   * configured Interpreter for each slot's speaking engram. Same shadow +
   * ordering semantics as retrieve(); the only difference is that
   * interpretation is async and may fail per-slot. A failed correction
   * drops its slot — the corrected engram is never shown in its place.
   *
   * retrievalCount accounting:
   *   - On success:  retrievalCount += 1 (slot engram and correction)
   *   - On failure:  retrievalCount += failedRetrievalWeight (default 0.25)
   *                  on the engram that failed, and the slot is dropped.
   *
   * Safety boundary: importanceScore is read-only here. The interpreter
   * receives only { template, payload, context } — never importanceScore,
   * activationPolicy, id, or retrievalCount.
   */
  async retrieveAsync(
    context: string,
    now: number = Date.now(),
    opts: Partial<InterpretOptions> = {},
  ): Promise<ActiveEngramResult[]> {
    const interpretOpts: InterpretOptions = {
      ...DEFAULT_INTERPRET_OPTIONS,
      ...opts,
    };

    const slots = this.resolveSlots(context, now);
    const settled = await Promise.allSettled(
      slots.map(({ head }) =>
        this.interpreter.interpret(
          { template: head.interpreterTemplate, payload: head.payload, context },
          interpretOpts,
        ),
      ),
    );

    const results: ActiveEngramResult[] = [];
    for (let i = 0; i < slots.length; i++) {
      const { root, head } = slots[i];
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        for (const engram of new Set([root, head])) engram.retrievalCount += 1;
        results.push(toResult(root, head, outcome.value));
      } else {
        head.retrievalCount += this.failedRetrievalWeight;
        this.logger.warn('interpret_failed', {
          engramId: head.id,
          error: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        });
      }
    }
    return results;
  }

  /**
   * Async preview: interpret one engram against the given context using the
   * configured Interpreter, without modifying retrievalCount. Rethrows
   * interpreter errors verbatim — preview should surface failure rather than
   * silently fall back.
   */
  async interpretAsync(
    id: string,
    context: string,
    opts: Partial<InterpretOptions> = {},
  ): Promise<ActiveEngramResult | undefined> {
    const engram = this.engrams.get(id);
    if (!engram) return undefined;

    const interpretOpts: InterpretOptions = {
      ...DEFAULT_INTERPRET_OPTIONS,
      ...opts,
    };

    const interpreted = await this.interpreter.interpret(
      {
        template: engram.interpreterTemplate,
        payload: engram.payload,
        context,
      },
      interpretOpts,
    );

    return {
      engramId: id,
      interpreted,
      payload: engram.payload,
      importanceScore: engram.importanceScore,
    };
  }

  // -----------------------------------------------------------------------
  // Serialization and replication
  // -----------------------------------------------------------------------

  /** Serialize engrams (by id) and removal tombstones. */
  serialize(): SerializedActiveEngramStore {
    const ids = [...this.engrams.keys()].sort(compareStrings);
    return {
      schemaVersion: CRDT_SCHEMA_VERSION,
      engrams: ids.map((id) => copyEngram(this.engrams.get(id)!)),
      removed: [...this.removedIds].sort(compareStrings),
    };
  }

  /**
   * Merge a peer's serialized engrams into this store: the union of engrams
   * by id, minus the union of removal tombstones.
   *
   * Trust model — what a peer's state can do here:
   *   - Add engrams this store has never seen. Each one is schema-validated
   *     (invalid ones are reported in `rejected`, not stored), its
   *     importance clamped to [0, 1], unknown fields dropped, and its
   *     retrieval count starts at 0 (counts are per replica).
   *   - Delete any engram, by tombstoning its id. Removal is not
   *     authority-checked: a "forget X" on any replica reaches every replica.
   *   - Correct only its own memories: `shadowsEngramId` takes effect only
   *     between engrams of the same `origin`.
   * What it cannot do:
   *   - Change an engram this store already holds (content is immutable by
   *     id; a differing copy is rejected), its importance score (only
   *     `setImportance` changes it once stored) or its retrieval count.
   *   - Resurrect a tombstoned engram.
   * `origin` is asserted by the state, not authenticated: a peer that forges
   * raw state can claim any origin. Authenticate peers at the transport and
   * merge only from peers you trust to add and delete memories.
   *
   * Throws TypeError on a state that is not an object, has a newer
   * `schemaVersion`, or lacks an `engrams` array.
   */
  mergeFrom(data: SerializedActiveEngramStore, options: EngramMergeOptions = {}): EngramMergeReport {
    const { engrams, removed } = parseStoreState(data);
    const report: EngramMergeReport = { added: [], removed: [], rejected: [] };

    for (const id of removed) {
      if (this.removedIds.has(id)) continue;
      this.removedIds.add(id);
      if (this.engrams.delete(id)) report.removed.push(id);
    }

    for (const raw of engrams) {
      const parsed = parseEngram(raw, { origin: options.from, trusted: false });
      if (typeof parsed === 'string') {
        report.rejected.push({ id: idOf(raw), reason: parsed });
        continue;
      }
      if (this.removedIds.has(parsed.id)) continue;
      const local = this.engrams.get(parsed.id);
      if (local) {
        if (contentKey(local) !== contentKey(parsed)) {
          report.rejected.push({ id: parsed.id, reason: 'differs from the copy this store holds' });
        }
        continue;
      }
      this.engrams.set(parsed.id, parsed);
      report.added.push(parsed.id);
    }
    return report;
  }

  /**
   * Restore this store from its own saved state, replacing all current
   * entries and tombstones. Unlike `mergeFrom` this trusts the state's
   * retrieval counts and importance scores (still validated and clamped);
   * engrams without an origin take this store's.
   */
  loadFrom(data: SerializedActiveEngramStore): EngramMergeReport {
    const { engrams, removed } = parseStoreState(data);
    const report: EngramMergeReport = { added: [], removed: [], rejected: [] };
    this.engrams.clear();
    this.removedIds = new Set(removed);
    for (const raw of engrams) {
      const parsed = parseEngram(raw, { origin: this.origin, trusted: true });
      if (typeof parsed === 'string') {
        report.rejected.push({ id: idOf(raw), reason: parsed });
        continue;
      }
      if (this.removedIds.has(parsed.id)) continue;
      const existing = this.engrams.get(parsed.id);
      if (existing) {
        if (contentKey(existing) !== contentKey(parsed)) {
          report.rejected.push({ id: parsed.id, reason: 'duplicate id with different content' });
        }
        continue;
      }
      this.engrams.set(parsed.id, parsed);
      report.added.push(parsed.id);
    }
    return report;
  }

  static deserialize(
    data: SerializedActiveEngramStore,
    opts: ActiveEngramStoreOptions = {},
  ): ActiveEngramStore {
    const store = new ActiveEngramStore(opts);
    store.loadFrom(data);
    return store;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * The recall slots that surface for a context, in result order. Builds
   * the correction forest over unexpired engrams (an edge needs the same
   * origin; engrams on a correction cycle are their own roots), then keeps
   * the chains where some member is eligible and the newest correction is
   * within budget.
   */
  private resolveSlots(context: string, now: number): Slot[] {
    const live = new Map<string, ActiveEngram>();
    for (const e of this.engrams.values()) {
      if (!isExpired(e, now)) live.set(e.id, e);
    }

    const targetOf = (e: ActiveEngram): ActiveEngram | undefined => {
      const targetId = e.activationPolicy.shadowsEngramId;
      if (targetId === undefined || targetId === e.id) return undefined;
      const target = live.get(targetId);
      return target && target.origin === e.origin ? target : undefined;
    };

    const rootOf = new Map<string, ActiveEngram>();
    for (const start of live.values()) {
      if (rootOf.has(start.id)) continue;
      const path: ActiveEngram[] = [];
      const onPath = new Set<string>();
      let current: ActiveEngram = start;
      let root: ActiveEngram;
      for (;;) {
        const known = rootOf.get(current.id);
        if (known) {
          root = known;
          break;
        }
        if (onPath.has(current.id)) {
          // A correction cycle: each engram on it is its own root.
          const cycleStart = path.indexOf(current);
          for (const member of path.slice(cycleStart)) rootOf.set(member.id, member);
          path.length = cycleStart;
          root = current;
          break;
        }
        onPath.add(current.id);
        path.push(current);
        const next = targetOf(current);
        if (!next) {
          root = current;
          break;
        }
        current = next;
      }
      for (const member of path) rootOf.set(member.id, root);
    }

    const groups = new Map<string, ActiveEngram[]>();
    const corrected = new Set<string>();
    for (const e of live.values()) {
      const root = rootOf.get(e.id)!;
      const members = groups.get(root.id);
      if (members) members.push(e);
      else groups.set(root.id, [e]);
      const target = targetOf(e);
      if (target && rootOf.get(target.id) === root) corrected.add(target.id);
    }

    const slots: Slot[] = [];
    for (const [rootId, members] of groups) {
      const root = live.get(rootId)!;
      // The newest engram nothing in the chain corrects.
      let head: ActiveEngram | undefined;
      for (const m of members) {
        if (corrected.has(m.id)) continue;
        if (!head || m.createdAt > head.createdAt || (m.createdAt === head.createdAt && m.id > head.id)) head = m;
      }
      head ??= root;
      if (!withinBudget(head)) continue;
      if (!members.some((m) => isEligible(m, context, now))) continue;
      slots.push({ root, head });
    }

    return slots.sort(
      (a, b) =>
        b.head.importanceScore - a.head.importanceScore ||
        a.root.createdAt - b.root.createdAt ||
        compareStrings(a.root.id, b.root.id),
    );
  }
}

function toResult(root: ActiveEngram, head: ActiveEngram, interpreted: string): ActiveEngramResult {
  const result: ActiveEngramResult = {
    engramId: root.id,
    interpreted,
    payload: head.payload,
    importanceScore: head.importanceScore,
  };
  if (head !== root) result.shadows = head.id;
  return result;
}

function idOf(raw: unknown): string | null {
  return isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
}

function parseStoreState(data: unknown): { engrams: unknown[]; removed: string[] } {
  const s = checkState(KIND, data);
  if (!Array.isArray(s.engrams)) fail(KIND, 'engrams', 'must be an array');
  const removed = s.removed === undefined ? [] : checkStringArray(KIND, 'removed', s.removed);
  return { engrams: s.engrams, removed };
}
