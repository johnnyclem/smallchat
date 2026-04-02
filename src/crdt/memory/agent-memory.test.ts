import { describe, it, expect } from 'vitest';
import { AgentMemory } from './agent-memory.js';
import { MemoryMerge } from './memory-merge.js';
import { ConflictDetector } from './conflict-detector.js';
import type { L3Entity, L3Edge } from './types.js';

// ===========================================================================
// Feature: AgentMemory — per-agent memory across all compaction levels
// ===========================================================================

describe('AgentMemory', () => {
  // -------------------------------------------------------------------------
  // L4: Core invariants
  // -------------------------------------------------------------------------

  describe('L4 invariants', () => {
    it('stores and retrieves invariants', () => {
      const mem = new AgentMemory('coder');
      mem.setInvariant('database', 'PostgreSQL');
      mem.setInvariant('framework', 'Next.js');

      expect(mem.getInvariant('database')).toBe('PostgreSQL');
      expect(mem.getInvariant('framework')).toBe('Next.js');
    });

    it('getInvariants returns all current values', () => {
      const mem = new AgentMemory('coder');
      mem.setInvariant('lang', 'TypeScript');
      mem.setInvariant('runtime', 'Node.js');

      const all = mem.getInvariants();
      expect(all.size).toBe(2);
      expect(all.get('lang')).toBe('TypeScript');
    });
  });

  // -------------------------------------------------------------------------
  // L3: Knowledge graph
  // -------------------------------------------------------------------------

  describe('L3 knowledge graph', () => {
    it('adds and retrieves entities', () => {
      const mem = new AgentMemory('reviewer');
      const entity: L3Entity = { id: 'svc-1', type: 'service', name: 'AuthService' };
      mem.addEntity(entity);

      const entities = mem.getEntities();
      expect(entities.size).toBe(1);
      expect([...entities][0].name).toBe('AuthService');
    });

    it('removes entities', () => {
      const mem = new AgentMemory('reviewer');
      const entity: L3Entity = { id: 'svc-1', type: 'service', name: 'AuthService' };
      mem.addEntity(entity);
      mem.removeEntity(entity);

      expect(mem.getEntities().size).toBe(0);
    });

    it('stores and retrieves edges', () => {
      const mem = new AgentMemory('planner');
      const edge: L3Edge = {
        from: 'api-gateway',
        to: 'auth-service',
        relation: 'depends-on',
      };
      mem.setEdge('api->auth', edge);

      const edges = mem.getEdges();
      expect(edges.size).toBe(1);
      expect(edges.get('api->auth')!.relation).toBe('depends-on');
    });
  });

  // -------------------------------------------------------------------------
  // L2: Topic summaries
  // -------------------------------------------------------------------------

  describe('L2 summaries', () => {
    it('adds and retrieves summaries', () => {
      const mem = new AgentMemory('coder');
      mem.addSummary('auth', 'Implemented JWT token validation', true);
      mem.addSummary('database', 'Set up connection pooling', true);

      const summaries = mem.getSummaries();
      expect(summaries.length).toBe(2);
    });

    it('deduplicates summaries on same topic', () => {
      const mem = new AgentMemory('coder');
      mem.addSummary('auth', 'Brief auth note', false);
      mem.addSummary('auth', 'Detailed auth implementation covering JWT, refresh tokens, and session management', true);

      const summaries = mem.getSummaries();
      expect(summaries.length).toBe(1);
      expect(summaries[0].isDirectParticipant).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // L1: Session context
  // -------------------------------------------------------------------------

  describe('L1 session context', () => {
    it('appends and retrieves context entries in order', () => {
      const mem = new AgentMemory('coder');
      mem.appendContext('Started working on auth module');
      mem.appendContext('Completed JWT validation');

      const ctx = mem.getContext();
      expect(ctx.length).toBe(2);
      expect(ctx[0].summary).toBe('Started working on auth module');
      expect(ctx[1].summary).toBe('Completed JWT validation');
    });
  });

  // -------------------------------------------------------------------------
  // L0: Raw messages
  // -------------------------------------------------------------------------

  describe('L0 messages', () => {
    it('appends and retrieves messages in order', () => {
      const mem = new AgentMemory('coder');
      mem.appendMessage('m1', 'user', 'Fix the auth bug');
      mem.appendMessage('m2', 'assistant', 'Looking at the auth module now', ['m1']);

      const msgs = mem.getMessages();
      expect(msgs.length).toBe(2);
      expect(msgs[0].content).toBe('Fix the auth bug');
      expect(msgs[1].causalPredecessors).toEqual(['m1']);
    });
  });

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  describe('serialization', () => {
    it('round-trips through serialize/from', () => {
      const mem = new AgentMemory('coder');
      mem.setInvariant('database', 'PostgreSQL');
      mem.addEntity({ id: 'e1', type: 'service', name: 'API' });
      mem.addSummary('auth', 'Auth implementation', true);
      mem.appendContext('Did auth work');
      mem.appendMessage('m1', 'user', 'hello');

      const state = mem.serialize();
      const restored = AgentMemory.from(state);

      expect(restored.getInvariant('database')).toBe('PostgreSQL');
      expect(restored.getEntities().size).toBe(1);
      expect(restored.getSummaries().length).toBe(1);
      expect(restored.getContext().length).toBe(1);
      expect(restored.getMessages().length).toBe(1);
    });

    it('vector clock advances with each operation', () => {
      const mem = new AgentMemory('agent-A');
      const vc0 = mem.getVectorClock();

      mem.setInvariant('x', 'y');
      const vc1 = mem.getVectorClock();

      expect(vc1['agent-A']).toBeGreaterThan(vc0['agent-A'] ?? 0);
    });
  });
});

// ===========================================================================
// Feature: Multi-agent memory merge
// ===========================================================================

describe('AgentMemory merge', () => {
  it('merges L4 invariants from another agent', () => {
    const coder = new AgentMemory('coder');
    const reviewer = new AgentMemory('reviewer');

    coder.setInvariant('database', 'PostgreSQL');
    reviewer.setInvariant('orm', 'Prisma');

    coder.mergeFrom(reviewer.serialize());

    expect(coder.getInvariant('database')).toBe('PostgreSQL');
    expect(coder.getInvariant('orm')).toBe('Prisma');
  });

  it('merges L3 entities from another agent', () => {
    const coder = new AgentMemory('coder');
    const reviewer = new AgentMemory('reviewer');

    coder.addEntity({ id: 'e1', type: 'service', name: 'API' });
    reviewer.addEntity({ id: 'e2', type: 'service', name: 'Worker' });

    coder.mergeFrom(reviewer.serialize());

    expect(coder.getEntities().size).toBe(2);
  });

  it('merges L2 summaries from another agent', () => {
    const coder = new AgentMemory('coder');
    const reviewer = new AgentMemory('reviewer');

    coder.addSummary('api', 'Built REST endpoints', true);
    reviewer.addSummary('tests', 'Wrote integration tests', true);

    coder.mergeFrom(reviewer.serialize());

    expect(coder.getSummaries().length).toBe(2);
  });

  it('three-way merge converges regardless of order', () => {
    const agentA = new AgentMemory('agent-A');
    const agentB = new AgentMemory('agent-B');
    const agentC = new AgentMemory('agent-C');

    agentA.setInvariant('key-A', 'val-A');
    agentB.setInvariant('key-B', 'val-B');
    agentC.setInvariant('key-C', 'val-C');

    const stateA = agentA.serialize();
    const stateB = agentB.serialize();
    const stateC = agentC.serialize();

    // Observer 1: merge A, B, C
    const obs1 = new AgentMemory('obs-1');
    obs1.mergeFrom(stateA);
    obs1.mergeFrom(stateB);
    obs1.mergeFrom(stateC);

    // Observer 2: merge C, A, B (different order)
    const obs2 = new AgentMemory('obs-2');
    obs2.mergeFrom(stateC);
    obs2.mergeFrom(stateA);
    obs2.mergeFrom(stateB);

    // Both should have all three invariants
    expect(obs1.getInvariant('key-A')).toBe('val-A');
    expect(obs1.getInvariant('key-B')).toBe('val-B');
    expect(obs1.getInvariant('key-C')).toBe('val-C');

    expect(obs2.getInvariant('key-A')).toBe('val-A');
    expect(obs2.getInvariant('key-B')).toBe('val-B');
    expect(obs2.getInvariant('key-C')).toBe('val-C');
  });
});

// ===========================================================================
// Feature: MemoryMerge — orchestrated multi-agent merge with conflict detection
// ===========================================================================

describe('MemoryMerge', () => {
  it('merges multiple agents and reports changes', () => {
    const merger = new MemoryMerge();
    const target = new AgentMemory('target');
    const remote1 = new AgentMemory('remote-1');
    const remote2 = new AgentMemory('remote-2');

    remote1.setInvariant('key1', 'val1');
    remote2.setInvariant('key2', 'val2');

    const report = merger.mergeAll(target, [remote1.serialize(), remote2.serialize()]);

    expect(report.hadChanges).toBe(true);
    expect(report.mergedAgents).toContain('remote-1');
    expect(report.mergedAgents).toContain('remote-2');
    expect(report.layerChanges.l4).toBe(true);
  });

  it('detects L4 semantic conflicts', () => {
    const merger = new MemoryMerge();
    const target = new AgentMemory('target');
    const remote1 = new AgentMemory('coder');
    const remote2 = new AgentMemory('reviewer');

    remote1.setInvariant('api-style', 'REST');
    remote2.setInvariant('api-style', 'GraphQL');

    const report = merger.mergeAll(target, [remote1.serialize(), remote2.serialize()]);

    expect(report.conflicts.length).toBeGreaterThan(0);
    const conflict = report.conflicts.find(c => c.key === 'api-style');
    expect(conflict).toBeDefined();
    expect(conflict!.layer).toBe('L4');
    expect(conflict!.severity).toBe('critical');
  });

  it('dry run detects conflicts without merging', () => {
    const merger = new MemoryMerge();
    const target = new AgentMemory('target');
    const remote = new AgentMemory('remote');

    remote.setInvariant('key', 'val');

    const report = merger.mergeAll(target, [remote.serialize()], { dryRun: true });

    expect(report.hadChanges).toBe(false);
    expect(target.getInvariant('key')).toBeUndefined(); // not merged
  });

  it('pairwise merge works for two-agent scenario', () => {
    const merger = new MemoryMerge();
    const target = new AgentMemory('target');
    const remote = new AgentMemory('remote');

    remote.setInvariant('lang', 'TypeScript');

    const report = merger.mergePair(target, remote.serialize());

    expect(report.hadChanges).toBe(true);
    expect(target.getInvariant('lang')).toBe('TypeScript');
  });

  it('causalRelation detects concurrent states', () => {
    const merger = new MemoryMerge();
    const agentA = new AgentMemory('agent-A');
    const agentB = new AgentMemory('agent-B');

    agentA.setInvariant('x', '1');
    agentB.setInvariant('y', '2');

    const rel = merger.causalRelation(agentA.serialize(), agentB.serialize());
    expect(rel).toBe('concurrent');
  });
});

// ===========================================================================
// Feature: ConflictDetector — semantic conflict detection
// ===========================================================================

describe('ConflictDetector', () => {
  const detector = new ConflictDetector();

  it('detects L4 invariant conflicts', () => {
    const memA = new AgentMemory('agent-A');
    const memB = new AgentMemory('agent-B');

    memA.setInvariant('database', 'PostgreSQL');
    memB.setInvariant('database', 'SQLite');

    const conflicts = detector.detectConflicts(memA.serialize(), memB.serialize());
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].key).toBe('database');
    expect(conflicts[0].valueA).toBe('PostgreSQL');
    expect(conflicts[0].valueB).toBe('SQLite');
  });

  it('does not flag matching L4 values', () => {
    const memA = new AgentMemory('agent-A');
    const memB = new AgentMemory('agent-B');

    memA.setInvariant('database', 'PostgreSQL');
    memB.setInvariant('database', 'PostgreSQL');

    const conflicts = detector.detectConflicts(memA.serialize(), memB.serialize());
    const dbConflicts = conflicts.filter(c => c.key === 'database');
    expect(dbConflicts.length).toBe(0);
  });

  it('detects L3 edge relation conflicts', () => {
    const memA = new AgentMemory('agent-A');
    const memB = new AgentMemory('agent-B');

    memA.setEdge('api->data', {
      from: 'api',
      to: 'data-layer',
      relation: 'uses-REST',
    });

    memB.setEdge('api->data', {
      from: 'api',
      to: 'data-layer',
      relation: 'uses-GraphQL',
    });

    const conflicts = detector.detectConflicts(memA.serialize(), memB.serialize());
    const edgeConflicts = conflicts.filter(c => c.layer === 'L3');
    expect(edgeConflicts.length).toBeGreaterThan(0);
    expect(edgeConflicts[0].key).toBe('api->data');
  });

  it('detects L2 summary divergence', () => {
    const memA = new AgentMemory('agent-A');
    const memB = new AgentMemory('agent-B');

    // Same topic, completely different content
    memA.addSummary('architecture', 'Monolithic Rails application with PostgreSQL', true);
    memB.addSummary('architecture', 'Microservices with gRPC and event sourcing', true);

    const conflicts = detector.detectConflicts(memA.serialize(), memB.serialize());
    const summaryConflicts = conflicts.filter(c => c.layer === 'L2');
    expect(summaryConflicts.length).toBe(1);
    expect(summaryConflicts[0].key).toBe('architecture');
  });

  it('does not flag identical summaries', () => {
    const memA = new AgentMemory('agent-A');
    const memB = new AgentMemory('agent-B');

    memA.addSummary('auth', 'JWT-based authentication with refresh tokens', true);
    memB.addSummary('auth', 'JWT-based authentication with refresh tokens', true);

    const conflicts = detector.detectConflicts(memA.serialize(), memB.serialize());
    const authConflicts = conflicts.filter(c => c.key === 'auth');
    expect(authConflicts.length).toBe(0);
  });
});
