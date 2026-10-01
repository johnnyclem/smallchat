/**
 * Property tests (fast-check) for every CRDT in this module: LWW-Register,
 * OR-Set, G-Set, RGA, AgentMemory and the ActiveEngramStore merge.
 *
 * For each one, random histories of local operations and pairwise syncs
 * run on three replicas. The tests then check:
 *   - convergence: after a full sync every replica holds the same state;
 *   - the join laws on reachable states: commutative, associative,
 *     idempotent (merging a state twice changes nothing);
 *   - serialize → deserialize → continue: a replica restored from its own
 *     serialized state behaves exactly like the original from then on.
 *
 * States always cross a JSON round trip, as they would between processes.
 * Histories include concurrent head inserts (RGA), equal-counter ties
 * between agents and, for the LWW-Register, replicas that share an agent id
 * (identical timestamps).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { LWWRegister } from './lww-register.js';
import type { LWWRegisterState } from './lww-register.js';
import { ORSet } from './or-set.js';
import type { ORSetState } from './or-set.js';
import { GSet } from './g-set.js';
import type { GSetState } from './g-set.js';
import { RGA } from './rga.js';
import type { RGAState } from './rga.js';
import { AgentMemory } from './memory/agent-memory.js';
import type { AgentMemoryState } from './memory/types.js';
import { ConflictDetector } from './memory/conflict-detector.js';
import { ActiveEngramStore } from './active-engram-store.js';
import type { SerializedActiveEngramStore } from './active-engram-store.js';
import { canonicalJson } from './wire.js';
import type { ActiveEngram } from '../types.js';

const RUNS = { numRuns: 150 };

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Freeze Date so wall-clock fields (summary timestamps, engram createdAt)
// are reproducible; each step advances it by 1 ms.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_700_000_000_000);
});
afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Generic harness
// ---------------------------------------------------------------------------

interface Harness<R, S, Op> {
  /** Replica ids for the three replicas. */
  ids: fc.Arbitrary<string[]>;
  op: fc.Arbitrary<Op>;
  create(id: string): R;
  restore(id: string, state: S): R;
  apply(replica: R, op: Op): void;
  serialize(replica: R): S;
  /** Merge a state; returns whether anything replicated changed. */
  merge(replica: R, state: S, fromId: string): boolean;
  /** Canonical form of the replicated part of a state. */
  project(state: S): string;
  /** Ops allowed after a restore (default: all). */
  continuable?(op: Op): boolean;
}

type Step<Op> =
  | { kind: 'op'; replica: number; op: Op }
  | { kind: 'sync'; from: number; to: number };

function steps<Op>(op: fc.Arbitrary<Op>, maxLength = 30): fc.Arbitrary<Step<Op>[]> {
  const replica = fc.integer({ min: 0, max: 2 });
  return fc.array(
    fc.oneof(
      { weight: 3, arbitrary: fc.record({ kind: fc.constant('op' as const), replica, op }) },
      { weight: 1, arbitrary: fc.record({ kind: fc.constant('sync' as const), from: replica, to: replica }) },
    ),
    { maxLength },
  );
}

function run<R, S, Op>(h: Harness<R, S, Op>, ids: string[], history: Step<Op>[], replicas = ids.map((id) => h.create(id))): R[] {
  for (const step of history) {
    vi.setSystemTime(Date.now() + 1);
    if (step.kind === 'op') h.apply(replicas[step.replica], step.op);
    else if (step.from !== step.to) {
      h.merge(replicas[step.to], wire(h.serialize(replicas[step.from])), ids[step.from]);
    }
  }
  return replicas;
}

function join<R, S, Op>(h: Harness<R, S, Op>, a: S, b: S, bId: string): S {
  const r = h.restore('observer', wire(a));
  h.merge(r, wire(b), bId);
  return wire(h.serialize(r));
}

function lawSuite<R, S, Op>(name: string, h: Harness<R, S, Op>): void {
  describe(`${name} laws`, () => {
    it('converges after a full sync, whatever the history', () => {
      fc.assert(
        fc.property(h.ids, steps(h.op), (ids, history) => {
          const replicas = run(h, ids, history);
          for (let i = 1; i < replicas.length; i++) h.merge(replicas[0], wire(h.serialize(replicas[i])), ids[i]);
          for (let i = 1; i < replicas.length; i++) h.merge(replicas[i], wire(h.serialize(replicas[0])), ids[0]);
          const projections = replicas.map((r) => h.project(h.serialize(r)));
          expect(projections[1]).toBe(projections[0]);
          expect(projections[2]).toBe(projections[0]);
        }),
        RUNS,
      );
    });

    it('merge is commutative, associative and idempotent on reachable states', () => {
      fc.assert(
        fc.property(h.ids, steps(h.op), (ids, history) => {
          const [a, b, c] = run(h, ids, history).map((r) => wire(h.serialize(r)));
          // Commutative
          expect(h.project(join(h, a, b, ids[1]))).toBe(h.project(join(h, b, a, ids[0])));
          // Associative
          expect(h.project(join(h, join(h, a, b, ids[1]), c, ids[2]))).toBe(
            h.project(join(h, a, join(h, b, c, ids[2]), ids[1])),
          );
          // Idempotent
          expect(h.project(join(h, a, a, ids[0]))).toBe(h.project(a));
          const again = h.restore('observer', wire(a));
          h.merge(again, wire(b), ids[1]);
          expect(h.merge(again, wire(b), ids[1])).toBe(false);
        }),
        RUNS,
      );
    });

    it('a restored replica continues exactly like the original', () => {
      fc.assert(
        fc.property(h.ids, steps(h.op), steps(h.op, 15), (ids, before, after) => {
          const replicas = run(h, ids, before);
          const twin = h.restore(ids[0], wire(h.serialize(replicas[0])));
          for (const step of after) {
            vi.setSystemTime(Date.now() + 1);
            if (step.kind === 'op') {
              if (step.replica === 0) {
                if (h.continuable && !h.continuable(step.op)) continue;
                h.apply(replicas[0], step.op);
                h.apply(twin, step.op);
              } else {
                h.apply(replicas[step.replica], step.op);
              }
            } else if (step.from !== step.to) {
              const state = wire(h.serialize(replicas[step.from]));
              h.merge(replicas[step.to], state, ids[step.from]);
              if (step.to === 0) h.merge(twin, wire(state), ids[step.from]);
            }
          }
          // The whole state, replica-local fields (clocks, counters) included.
          expect(canonicalJson(h.serialize(twin))).toBe(canonicalJson(h.serialize(replicas[0])));
        }),
        RUNS,
      );
    });
  });
}

const uniqueIds = fc.constantFrom<string[]>(['a', 'b', 'c'], ['agent-2', 'agent-10', 'agent-1'], ['z', 'y', 'x']);

// ---------------------------------------------------------------------------
// LWW-Register — including replicas that share an agent id
// ---------------------------------------------------------------------------

type LWWOp = { kind: 'set'; key: string; value: string } | { kind: 'delete'; key: string };

const lwwHarness: Harness<LWWRegister<string>, LWWRegisterState<string>, LWWOp> = {
  ids: fc.oneof(uniqueIds, fc.constantFrom<string[]>(['a', 'a', 'b'], ['p', 'p', 'p'])),
  op: fc.oneof(
    fc.record({ kind: fc.constant('set' as const), key: fc.constantFrom('k1', 'k2', 'k3'), value: fc.constantFrom('x', 'y', 'z', 'w') }),
    fc.record({ kind: fc.constant('delete' as const), key: fc.constantFrom('k1', 'k2', 'k3') }),
  ),
  create: (id) => new LWWRegister<string>(id),
  restore: (id, state) => LWWRegister.from<string>(id, state),
  apply: (r, op) => (op.kind === 'set' ? r.set(op.key, op.value) : r.delete(op.key)),
  serialize: (r) => r.serialize(),
  merge: (r, s) => r.merge(s),
  project: (s) => canonicalJson(s),
};

lawSuite('LWW-Register', lwwHarness);

// ---------------------------------------------------------------------------
// OR-Set
// ---------------------------------------------------------------------------

type ORSetOp = { kind: 'add' | 'remove'; element: string | { id: number; tag: string } };

const orElement = fc.oneof(
  fc.constantFrom('x', 'y', 'z'),
  fc.record({ id: fc.integer({ min: 1, max: 2 }), tag: fc.constantFrom('t', 'u') }),
);

const orSetHarness: Harness<ORSet<ORSetOp['element']>, ORSetState<ORSetOp['element']>, ORSetOp> = {
  ids: uniqueIds,
  op: fc.record({ kind: fc.constantFrom('add' as const, 'remove' as const), element: orElement }),
  create: (id) => new ORSet(id),
  restore: (id, state) => ORSet.from(id, state),
  apply: (r, op) => (op.kind === 'add' ? void r.add(op.element) : r.remove(op.element)),
  serialize: (r) => r.serialize(),
  merge: (r, s) => r.merge(s),
  project: (s) => canonicalJson(s),
};

lawSuite('OR-Set', orSetHarness);

// ---------------------------------------------------------------------------
// G-Set — keyed entries with equal-length ties, and keyless entries
// ---------------------------------------------------------------------------

type GSetOp = { key: string | null; value: string; direct: boolean; source: string };

const gSetHarness: Harness<GSet<string>, GSetState<string>, GSetOp> = {
  ids: uniqueIds,
  op: fc.record({
    key: fc.constantFrom('topic-1', 'topic-2', null),
    value: fc.constantFrom('aa', 'bb', 'cc', 'ddd'),
    direct: fc.boolean(),
    source: fc.constantFrom('s1', 's2'),
  }),
  create: (id) => new GSet<string>({ replicaId: id }),
  restore: (id, state) => GSet.from<string>(state, { replicaId: id }),
  apply: (r, op) =>
    void r.add({
      value: op.value,
      sourceAgent: op.source,
      isDirectParticipant: op.direct,
      ...(op.key === null ? {} : { dedupeKey: op.key }),
    }),
  serialize: (r) => r.serialize(),
  merge: (r, s) => r.merge(s),
  project: (s) => canonicalJson(s),
};

lawSuite('G-Set', gSetHarness);

// ---------------------------------------------------------------------------
// RGA — appends, inserts anywhere (head included) and deletes
// ---------------------------------------------------------------------------

type RGAOp =
  | { kind: 'append'; value: string }
  | { kind: 'insert'; pos: number; value: string }
  | { kind: 'delete'; pos: number };

function applyRGA(r: RGA<string>, op: RGAOp): void {
  const ids = r.nodeIds();
  if (op.kind === 'append') r.append(op.value);
  else if (op.kind === 'insert') {
    const slot = op.pos % (ids.length + 1);
    r.insertAfter(op.value, slot === 0 ? null : ids[slot - 1]);
  } else if (ids.length > 0) {
    r.delete(ids[op.pos % ids.length]);
  }
}

const rgaHarness: Harness<RGA<string>, RGAState<string>, RGAOp> = {
  ids: uniqueIds,
  op: fc.oneof(
    fc.record({ kind: fc.constant('append' as const), value: fc.constantFrom('m1', 'm2', 'm3') }),
    fc.record({ kind: fc.constant('insert' as const), pos: fc.nat(8), value: fc.constantFrom('h', 'i') }),
    fc.record({ kind: fc.constant('delete' as const), pos: fc.nat(8) }),
  ),
  create: (id) => new RGA<string>(id),
  restore: (id, state) => RGA.from<string>(id, state),
  apply: applyRGA,
  serialize: (r) => r.serialize(),
  merge: (r, s) => r.merge(s),
  project: (s) => canonicalJson(s),
};

lawSuite('RGA', rgaHarness);

describe('RGA concurrent head inserts', () => {
  it('replicas that insert at the head and append after their own inserts converge', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ replica: fc.integer({ min: 0, max: 2 }), head: fc.boolean(), sync: fc.boolean() }),
          { maxLength: 25 },
        ),
        (history) => {
          const ids = ['a', 'b', 'c'];
          const replicas = ids.map((id) => new RGA<string>(id));
          history.forEach(({ replica, head, sync }, i) => {
            if (head) replicas[replica].insertAfter(`v${i}`, null);
            else replicas[replica].append(`v${i}`);
            if (sync) replicas[(replica + 1) % 3].merge(wire(replicas[replica].serialize()));
          });
          const states = replicas.map((r) => wire(r.serialize()));
          const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0]];
          const values = orders.map((order) => {
            const observer = new RGA<string>('observer');
            for (const i of order) observer.merge(wire(states[i]));
            return observer.value();
          });
          expect(values[1]).toEqual(values[0]);
          expect(values[2]).toEqual(values[0]);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// AgentMemory — every layer plus active engrams
// ---------------------------------------------------------------------------

type MemoryOp =
  | { kind: 'invariant'; key: string; value: string }
  | { kind: 'entity'; remove: boolean; name: string }
  | { kind: 'edge'; key: string; relation: string }
  | { kind: 'summary'; topic: string; content: string; direct: boolean }
  | { kind: 'context'; summary: string }
  | { kind: 'message'; content: string }
  | { kind: 'engram'; payload: string }
  | { kind: 'forget'; index: number };

function applyMemory(m: AgentMemory, op: MemoryOp): void {
  switch (op.kind) {
    case 'invariant':
      return m.setInvariant(op.key, op.value);
    case 'entity': {
      const entity = { id: op.name.toLowerCase(), type: 'service', name: op.name };
      return op.remove ? m.removeEntity(entity) : m.addEntity(entity);
    }
    case 'edge':
      return m.setEdge(op.key, { from: 'api', to: op.key, relation: op.relation });
    case 'summary':
      return m.addSummary(op.topic, op.content, op.direct);
    case 'context':
      return m.appendContext(op.summary);
    case 'message':
      // Id from the replica's own clock, so a restored twin issues the same one.
      return m.appendMessage(`${m.agentId}-${m.getVectorClock()[m.agentId] ?? 0}`, 'user', op.content);
    case 'engram':
      void m.activeEngrams.add(op.payload);
      return;
    case 'forget': {
      const all = m.activeEngrams.all().map((e) => e.id).sort();
      if (all.length > 0) m.activeEngrams.remove(all[op.index % all.length]);
      return;
    }
  }
}

/**
 * The replicated part of a memory state: no owner id, no per-replica engram
 * fields, and zero vector-clock entries dropped (a zero entry equals none).
 */
function projectMemory(state: AgentMemoryState): string {
  const { agentId: _owner, activeEngrams, vectorClock, ...layers } = state;
  return canonicalJson({
    ...layers,
    vectorClock: Object.fromEntries(Object.entries(vectorClock).filter(([, n]) => n > 0)),
    activeEngrams: activeEngrams && {
      ...activeEngrams,
      engrams: activeEngrams.engrams.map(({ retrievalCount: _r, importanceScore: _i, ...rest }) => rest),
    },
  });
}

const memoryHarness: Harness<AgentMemory, AgentMemoryState, MemoryOp> = {
  ids: uniqueIds,
  op: fc.oneof(
    fc.record({ kind: fc.constant('invariant' as const), key: fc.constantFrom('db', 'cache'), value: fc.constantFrom('pg', 'mysql', 'redis') }),
    fc.record({ kind: fc.constant('entity' as const), remove: fc.boolean(), name: fc.constantFrom('Auth', 'Billing') }),
    fc.record({ kind: fc.constant('edge' as const), key: fc.constantFrom('db', 'queue'), relation: fc.constantFrom('reads', 'writes') }),
    fc.record({ kind: fc.constant('summary' as const), topic: fc.constantFrom('api', 'deploy'), content: fc.constantFrom('use REST', 'use gRPC', 'ship it'), direct: fc.boolean() }),
    fc.record({ kind: fc.constant('context' as const), summary: fc.constantFrom('c1', 'c2') }),
    fc.record({ kind: fc.constant('message' as const), content: fc.constantFrom('hi', 'ok') }),
    fc.record({ kind: fc.constant('engram' as const), payload: fc.constantFrom('note-1', 'note-2') }),
    fc.record({ kind: fc.constant('forget' as const), index: fc.nat(4) }),
  ),
  create: (id) => new AgentMemory(id),
  restore: (id, state) => AgentMemory.from({ ...state, agentId: id }),
  apply: applyMemory,
  serialize: (m) => m.serialize(),
  merge: (m, s) => m.mergeFrom(s),
  project: projectMemory,
  // Engram ids are random UUIDs, so a twin cannot reproduce a new engram's id.
  continuable: (op) => op.kind !== 'engram',
};

lawSuite('AgentMemory', memoryHarness);

describe('ConflictDetector on causal histories', () => {
  it('reports no L4 conflict when every write follows a sync of everything before it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ replica: fc.integer({ min: 0, max: 2 }), value: fc.constantFrom('pg', 'mysql', 'redis') }), { minLength: 1, maxLength: 12 }),
        (writes) => {
          const replicas = ['a', 'b', 'c'].map((id) => new AgentMemory(id));
          let latest: AgentMemoryState | undefined;
          for (const { replica, value } of writes) {
            if (latest) replicas[replica].mergeFrom(wire(latest));
            replicas[replica].setInvariant('db', value);
            latest = replicas[replica].serialize();
          }
          const detector = new ConflictDetector();
          const states = replicas.map((r) => wire(r.serialize()));
          for (const x of states) {
            for (const y of states) {
              expect(detector.detectConflicts(x, y).filter((c) => c.layer === 'L4')).toEqual([]);
            }
          }
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// ActiveEngramStore merge
// ---------------------------------------------------------------------------

type EngramOp =
  | { kind: 'add'; payload: string; topics: string[]; shadow: number | null }
  | { kind: 'remove'; index: number }
  | { kind: 'importance'; index: number; score: number }
  | { kind: 'retrieve'; context: string };

/** Deterministic ids `<replica>-<n>`, continuing after the ids in a state. */
function idSource(replica: string, state?: SerializedActiveEngramStore): () => string {
  const mine = (id: string) => id.startsWith(`${replica}-`) ? Number(id.slice(replica.length + 1)) : 0;
  let n = state ? Math.max(0, ...state.engrams.map((e) => mine(e.id)), ...(state.removed ?? []).map(mine)) : 0;
  return () => `${replica}-${++n}`;
}

function sortedIds(store: ActiveEngramStore): string[] {
  return store.all().map((e) => e.id).sort();
}

function applyEngram(store: ActiveEngramStore, op: EngramOp): void {
  const ids = sortedIds(store);
  switch (op.kind) {
    case 'add': {
      const shadowsEngramId = op.shadow === null || ids.length === 0 ? undefined : ids[op.shadow % ids.length];
      store.add(op.payload, { activationPolicy: { surfaceWhenTopics: op.topics, shadowsEngramId } });
      return;
    }
    case 'remove':
      if (ids.length > 0) store.remove(ids[op.index % ids.length]);
      return;
    case 'importance':
      if (ids.length > 0) store.setImportance(ids[op.index % ids.length], op.score);
      return;
    case 'retrieve':
      store.retrieve(op.context);
      return;
  }
}

/** Replicated part: engram content and tombstones (counts and scores are per replica). */
function projectEngrams(state: SerializedActiveEngramStore): string {
  return canonicalJson({
    ...state,
    engrams: state.engrams.map(({ retrievalCount: _r, importanceScore: _i, ...rest }) => rest),
  });
}

const contexts = ['billing question', 'deploy now', 'billing and deploy', 'nothing relevant'];

const engramHarness: Harness<ActiveEngramStore, SerializedActiveEngramStore, EngramOp> = {
  ids: uniqueIds,
  op: fc.oneof(
    fc.record({
      kind: fc.constant('add' as const),
      payload: fc.constantFrom('free tier', 'upgraded', 'needs approval'),
      topics: fc.subarray(['billing', 'deploy']),
      shadow: fc.option(fc.nat(5), { nil: null }),
    }),
    fc.record({ kind: fc.constant('remove' as const), index: fc.nat(5) }),
    fc.record({ kind: fc.constant('importance' as const), index: fc.nat(5), score: fc.double({ min: -1, max: 2, noNaN: true }) }),
    fc.record({ kind: fc.constant('retrieve' as const), context: fc.constantFrom(...contexts) }),
  ),
  create: (id) => new ActiveEngramStore({ origin: id, generateId: idSource(id) }),
  restore: (id, state) => ActiveEngramStore.deserialize(state, { origin: id, generateId: idSource(id, state) }),
  apply: applyEngram,
  serialize: (s) => s.serialize(),
  merge: (s, state, from) => {
    const report = s.mergeFrom(state, { from });
    expect(report.rejected).toEqual([]);
    return report.added.length > 0 || report.removed.length > 0;
  },
  project: projectEngrams,
};

lawSuite('ActiveEngramStore', engramHarness);

describe('ActiveEngramStore retrieval after convergence', () => {
  it('converged replicas surface the same slots, and no corrected engram speaks for itself', () => {
    fc.assert(
      fc.property(uniqueIds, steps(engramHarness.op), (ids, history) => {
        const stores = run(engramHarness, ids, history);
        for (let i = 1; i < 3; i++) stores[0].mergeFrom(wire(stores[i].serialize()), { from: ids[i] });
        for (let i = 1; i < 3; i++) stores[i].mergeFrom(wire(stores[0].serialize()), { from: ids[0] });

        for (const context of contexts) {
          const slots = stores.map((s) =>
            s.select(context).map((r) => `${r.engramId}<${r.shadows ?? ''}:${r.payload}`).sort(),
          );
          expect(slots[1]).toEqual(slots[0]);
          expect(slots[2]).toEqual(slots[0]);

          const engrams = new Map<string, Readonly<ActiveEngram>>(stores[0].all().map((e) => [e.id, e]));
          for (const result of stores[0].select(context)) {
            if (result.shadows !== undefined) continue;
            const correctedBy = [...engrams.values()].filter(
              (e) =>
                e.activationPolicy.shadowsEngramId === result.engramId &&
                e.origin === engrams.get(result.engramId)!.origin &&
                e.id !== result.engramId,
            );
            expect(correctedBy).toEqual([]);
          }
        }
      }),
      RUNS,
    );
  });
});
