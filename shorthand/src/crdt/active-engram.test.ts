/**
 * Tests for ActiveEngramStore — the agential memory layer.
 *
 * Covers:
 *   - Three-field contract (payload, interpreter, activation policy)
 *   - Interpreter step: contextualized output differs from raw payload when
 *     context has shifted between write-time and read-time
 *   - Activation policy evaluation (topics, maxRetrievals, expiry)
 *   - Shadow/correction mechanic
 *   - Safety boundary: activation policies cannot write importanceScore
 *   - Serialization round-trip
 *   - AgentMemory integration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ActiveEngramStore } from './active-engram-store.js';
import { AgentMemory } from './memory/agent-memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function futureMs(offsetMs: number): number {
  return Date.now() + offsetMs;
}

function pastMs(offsetMs: number): number {
  return Date.now() - offsetMs;
}

// ---------------------------------------------------------------------------
// Three-field contract
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — three-field contract', () => {
  it('stores payload, interpreterTemplate, and activationPolicy', () => {
    const store = new ActiveEngramStore();
    const id = store.add('database is PostgreSQL', {
      interpreterTemplate:
        'Given context "{{context}}", the fact "{{payload}}" means the DB choice is confirmed.',
      activationPolicy: { surfaceWhenTopics: ['database', 'storage'] },
    });

    const engram = store.get(id)!;
    expect(engram.payload).toBe('database is PostgreSQL');
    expect(engram.interpreterTemplate).toContain('{{payload}}');
    expect(engram.activationPolicy.surfaceWhenTopics).toEqual(['database', 'storage']);
  });

  it('assigns importanceScore default of 0.5', () => {
    const store = new ActiveEngramStore();
    const id = store.add('some fact');
    expect(store.get(id)!.importanceScore).toBe(0.5);
  });

  it('accepts a custom importanceScore', () => {
    const store = new ActiveEngramStore();
    const id = store.add('critical fact', { importanceScore: 0.9 });
    expect(store.get(id)!.importanceScore).toBe(0.9);
  });

  it('starts with retrievalCount of zero', () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact');
    expect(store.get(id)!.retrievalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Interpreter step: salience over fidelity
// The key thesis: when context shifts between write and read, the interpreted
// output carries the engram's meaning into the new context, while raw payload
// would still reference the old framing.
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — interpreter step', () => {
  it('produces contextualized output distinct from raw payload', () => {
    const store = new ActiveEngramStore();
    const id = store.add('user prefers CLI tools', {
      interpreterTemplate:
        'Given that we are now building {{context}}, remember: {{payload}}',
      activationPolicy: { surfaceWhenTopics: [] },
    });

    const writeTimeContext = 'a command-line utility';
    const readTimeContext = 'a web dashboard';

    const atWrite = store.interpret(id, writeTimeContext)!;
    const atRead = store.interpret(id, readTimeContext)!;

    // Both interpretations include the payload
    expect(atWrite.interpreted).toContain('user prefers CLI tools');
    expect(atRead.interpreted).toContain('user prefers CLI tools');

    // But the interpreted form reflects the current context, not just the payload
    expect(atWrite.interpreted).toContain(writeTimeContext);
    expect(atRead.interpreted).toContain(readTimeContext);

    // The two interpretations differ — the engram has re-stated itself
    expect(atWrite.interpreted).not.toBe(atRead.interpreted);

    // Payload is preserved verbatim in the result for diffing
    expect(atRead.payload).toBe('user prefers CLI tools');
  });

  it('interpret() does not increment retrievalCount', () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact', {
      activationPolicy: { surfaceWhenTopics: [] },
    });
    store.interpret(id, 'some context');
    store.interpret(id, 'other context');
    expect(store.get(id)!.retrievalCount).toBe(0);
  });

  it('retrieve() increments retrievalCount', () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    store.retrieve('any context');
    store.retrieve('any context');
    expect(store.get(id)!.retrievalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Activation policy — topic gating
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — activation policy / topics', () => {
  it('surfaces engram when context matches a topic', () => {
    const store = new ActiveEngramStore();
    store.add('use Redis for caching', {
      activationPolicy: { surfaceWhenTopics: ['cache', 'redis'] },
    });

    const results = store.retrieve('we need to set up the cache layer');
    expect(results).toHaveLength(1);
    expect(results[0].payload).toBe('use Redis for caching');
  });

  it('does not surface engram when context lacks required topics', () => {
    const store = new ActiveEngramStore();
    store.add('use Redis for caching', {
      activationPolicy: { surfaceWhenTopics: ['cache', 'redis'] },
    });

    const results = store.retrieve('discuss the authentication flow');
    expect(results).toHaveLength(0);
  });

  it('surfaces with empty surfaceWhenTopics (always eligible)', () => {
    const store = new ActiveEngramStore();
    store.add('always-relevant fact', {
      activationPolicy: { surfaceWhenTopics: [] },
    });

    expect(store.retrieve('anything at all')).toHaveLength(1);
  });

  it('topic match is case-insensitive', () => {
    const store = new ActiveEngramStore();
    store.add('fact', { activationPolicy: { surfaceWhenTopics: ['POSTGRES'] } });
    expect(store.retrieve('we chose postgres for the main store')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Activation policy — maxRetrievals
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — activation policy / maxRetrievals', () => {
  it('stops surfacing after maxRetrievals', () => {
    const store = new ActiveEngramStore();
    store.add('one-shot hint', {
      activationPolicy: { surfaceWhenTopics: [], maxRetrievals: 1 },
    });

    const first = store.retrieve('context');
    expect(first).toHaveLength(1);

    const second = store.retrieve('context');
    expect(second).toHaveLength(0);
  });

  it('surfaces exactly maxRetrievals times', () => {
    const store = new ActiveEngramStore();
    store.add('limited hint', {
      activationPolicy: { surfaceWhenTopics: [], maxRetrievals: 3 },
    });

    for (let i = 0; i < 3; i++) {
      expect(store.retrieve('ctx')).toHaveLength(1);
    }
    expect(store.retrieve('ctx')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Activation policy — expiry
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — activation policy / expiry', () => {
  it('surfaces before expiry', () => {
    const store = new ActiveEngramStore();
    store.add('fact', {
      activationPolicy: { surfaceWhenTopics: [], expiresAt: futureMs(60_000) },
    });
    expect(store.retrieve('ctx', Date.now())).toHaveLength(1);
  });

  it('does not surface after expiry', () => {
    const store = new ActiveEngramStore();
    store.add('fact', {
      activationPolicy: { surfaceWhenTopics: [], expiresAt: pastMs(1) },
    });
    expect(store.retrieve('ctx', Date.now())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shadow / correction mechanic
// A correction is just an ActiveEngram whose activationPolicy.shadowsEngramId
// points at the engram being corrected. Same mechanism, no special case.
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — shadow / correction mechanic', () => {
  it('correction shadows the original engram output', () => {
    const store = new ActiveEngramStore();

    const originalId = store.add('database is MySQL', {
      activationPolicy: { surfaceWhenTopics: [] },
      importanceScore: 0.6,
    });

    const correctionId = store.add('database is actually PostgreSQL', {
      interpreterTemplate:
        'Correction: the earlier note about {{context}} was wrong. It is: {{payload}}',
      activationPolicy: {
        surfaceWhenTopics: [],
        shadowsEngramId: originalId,
      },
      importanceScore: 0.8,
    });

    const results = store.retrieve('the database choice');

    // Only one result — the correction has replaced the original's slot
    expect(results).toHaveLength(1);

    // The result carries the corrected interpretation
    expect(results[0].interpreted).toContain('PostgreSQL');
    expect(results[0].interpreted).not.toContain('MySQL');

    // The result carries provenance metadata
    expect(results[0].shadows).toBe(correctionId);

    // The slot is addressed under the original's ID
    expect(results[0].engramId).toBe(originalId);

    void correctionId; // consumed via shadowsEngramId
  });

  it('non-shadowing engrams are unaffected', () => {
    const store = new ActiveEngramStore();
    const aId = store.add('fact A', { activationPolicy: { surfaceWhenTopics: [] } });
    store.add('fact B', { activationPolicy: { surfaceWhenTopics: [] } });

    const results = store.retrieve('context');
    expect(results).toHaveLength(2);

    void aId;
  });

  it('correction inherits the importance score it was added with', () => {
    const store = new ActiveEngramStore();
    const originalId = store.add('old fact', {
      activationPolicy: { surfaceWhenTopics: [] },
      importanceScore: 0.3,
    });
    store.add('new fact', {
      activationPolicy: { surfaceWhenTopics: [], shadowsEngramId: originalId },
      importanceScore: 0.9,
    });

    const results = store.retrieve('ctx');
    expect(results[0].importanceScore).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// Safety boundary: activation policies cannot write importanceScore
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — safety boundary', () => {
  it('setImportance() is the only path to change importanceScore', () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact', { importanceScore: 0.5 });

    store.setImportance(id, 0.95);

    expect(store.get(id)!.importanceScore).toBe(0.95);
  });

  it('ActivationPolicy has no method to write importanceScore (type-level)', () => {
    // This is a structural check: ActivationPolicy must not contain a field
    // that references the store or any write mechanism.
    const store = new ActiveEngramStore();
    const id = store.add('fact', {
      activationPolicy: {
        surfaceWhenTopics: [],
        maxRetrievals: 5,
      },
    });

    const engram = store.get(id)!;
    const policy = engram.activationPolicy;

    // The policy is a plain data object — no callable properties beyond the
    // declared interface fields.
    const policyKeys = Object.keys(policy);
    const writeMethods = policyKeys.filter((k) => typeof (policy as Record<string, unknown>)[k] === 'function');
    expect(writeMethods).toHaveLength(0);
  });

  it('clamps importanceScore to [0, 1]', () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact');

    store.setImportance(id, 1.5);
    expect(store.get(id)!.importanceScore).toBe(1.0);

    store.setImportance(id, -0.3);
    expect(store.get(id)!.importanceScore).toBe(0.0);
  });

  it('retrieve() does not allow policy to influence its own importance', () => {
    // If retrieval could feed back into importance via the policy, we'd have
    // an addiction loop. Verify that retrievalCount increments but
    // importanceScore remains unchanged after retrieval.
    const store = new ActiveEngramStore();
    const id = store.add('fact', {
      activationPolicy: { surfaceWhenTopics: [], maxRetrievals: 10 },
      importanceScore: 0.5,
    });

    for (let i = 0; i < 5; i++) {
      store.retrieve('any context');
    }

    expect(store.get(id)!.retrievalCount).toBe(5);
    expect(store.get(id)!.importanceScore).toBe(0.5); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Results sorted by importance
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — result ordering', () => {
  it('returns results sorted descending by importanceScore', () => {
    const store = new ActiveEngramStore();
    store.add('low priority', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.2 });
    store.add('high priority', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.9 });
    store.add('medium priority', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.5 });

    const results = store.retrieve('context');
    expect(results[0].importanceScore).toBe(0.9);
    expect(results[1].importanceScore).toBe(0.5);
    expect(results[2].importanceScore).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// Serialization round-trip
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — serialization', () => {
  it('round-trips all engram fields', () => {
    const store = new ActiveEngramStore();
    const id = store.add('critical constraint', {
      interpreterTemplate: 'When doing {{context}}: {{payload}}',
      activationPolicy: {
        surfaceWhenTopics: ['deploy'],
        maxRetrievals: 3,
        expiresAt: futureMs(10_000),
      },
      importanceScore: 0.8,
    });
    store.retrieve('deploy the service'); // bump retrievalCount

    const serialized = store.serialize();
    const restored = ActiveEngramStore.deserialize(serialized);

    const original = store.get(id)!;
    const copy = restored.get(id)!;

    expect(copy.payload).toBe(original.payload);
    expect(copy.interpreterTemplate).toBe(original.interpreterTemplate);
    expect(copy.activationPolicy).toEqual(original.activationPolicy);
    expect(copy.importanceScore).toBe(original.importanceScore);
    expect(copy.retrievalCount).toBe(original.retrievalCount);
  });
});

// ---------------------------------------------------------------------------
// AgentMemory integration
// ---------------------------------------------------------------------------

describe('AgentMemory — ActiveEngramStore integration', () => {
  it('exposes activeEngrams store', () => {
    const memory = new AgentMemory('agent-a');
    expect(memory.activeEngrams).toBeDefined();
  });

  it('active engrams survive serialize/deserialize round-trip', () => {
    const memory = new AgentMemory('agent-a');
    const id = memory.activeEngrams.add('the stack uses TypeScript', {
      activationPolicy: { surfaceWhenTopics: ['types', 'typescript'] },
      importanceScore: 0.7,
    });

    const serialized = memory.serialize();
    const restored = AgentMemory.from(serialized);

    const engram = restored.activeEngrams.get(id)!;
    expect(engram).toBeDefined();
    expect(engram.payload).toBe('the stack uses TypeScript');
    expect(engram.importanceScore).toBe(0.7);
  });

  it('active engrams are independent per-agent (no shared state)', () => {
    const a = new AgentMemory('agent-a');
    const b = new AgentMemory('agent-b');

    a.activeEngrams.add('agent-a fact', { activationPolicy: { surfaceWhenTopics: [] } });

    expect(a.activeEngrams.all()).toHaveLength(1);
    expect(b.activeEngrams.all()).toHaveLength(0);
  });
});
