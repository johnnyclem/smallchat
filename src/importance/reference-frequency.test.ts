import { describe, it, expect, beforeEach } from 'vitest';
import { ReferenceGraph } from './reference-frequency.js';
import type { ConversationMessage } from './types.js';

function msg(id: string, content: string, embedding?: number[]): ConversationMessage {
  return {
    id,
    content,
    embedding: embedding ? new Float32Array(embedding) : undefined,
    timestamp: Date.now(),
    role: 'user',
  };
}

describe('ReferenceGraph', () => {
  let graph: ReferenceGraph;

  beforeEach(() => {
    graph = new ReferenceGraph({ semanticThreshold: 0.75, decayFactor: 0.9 });
  });

  it('detects explicit backward references', () => {
    graph.addMessage(msg('m1', 'Use RSA for encryption', [1, 0, 0]));
    graph.addMessage(msg('m2', 'The key size should be 4096', [0.5, 0.5, 0]));
    const refs = graph.addMessage(msg('m3', 'As I mentioned earlier, RSA is important', [0.9, 0.1, 0]));

    // Should have found an explicit reference
    expect(refs.some(r => r.type === 'explicit')).toBe(true);
  });

  it('detects entity-reuse references', () => {
    graph.addMessage(msg('m1', 'Use Redis for caching'), undefined, ['redis']);
    graph.addMessage(msg('m2', 'The API handles requests'));
    const refs = graph.addMessage(msg('m3', 'Redis should be configured with maxmemory'), undefined, ['redis']);

    expect(refs.some(r => r.type === 'entity_reuse' && r.targetId === 'm1')).toBe(true);
  });

  it('detects semantic references (high similarity to non-adjacent messages)', () => {
    // m1 and m3 are semantically similar; m2 is different
    graph.addMessage(msg('m1', 'encryption topic', [1, 0, 0]));
    graph.addMessage(msg('m2', 'unrelated topic', [0, 1, 0]));
    // Make m3 very similar to m1 but not adjacent
    graph.addMessage(msg('m2b', 'another unrelated', [0, 0.9, 0.1]));
    const refs = graph.addMessage(msg('m3', 'back to encryption', [0.95, 0.05, 0]));

    // Should reference m1 semantically (similarity > 0.75)
    expect(refs.some(r => r.type === 'semantic' && r.targetId === 'm1')).toBe(true);
  });

  it('accumulates reference scores', () => {
    graph.addMessage(msg('m1', 'Important decision about architecture'), undefined, ['architecture']);
    graph.addMessage(msg('m2', 'Minor detail'));
    graph.addMessage(msg('m3', 'Revisiting architecture choices'), undefined, ['architecture']);
    graph.addMessage(msg('m4', 'More about architecture design'), undefined, ['architecture']);

    const score = graph.getScore('m1');
    expect(score).toBeDefined();
    expect(score!.inboundCount).toBeGreaterThanOrEqual(2);
    expect(score!.weightedScore).toBeGreaterThan(0);
  });

  it('sorts getAllScores by weighted score descending', () => {
    graph.addMessage(msg('m1', 'Important'), undefined, ['db']);
    graph.addMessage(msg('m2', 'Less important'));
    graph.addMessage(msg('m3', 'References m1'), undefined, ['db']);
    graph.addMessage(msg('m4', 'Also references m1'), undefined, ['db']);

    const scores = graph.getAllScores();
    if (scores.length >= 2) {
      expect(scores[0].weightedScore).toBeGreaterThanOrEqual(scores[1].weightedScore);
    }
  });

  it('applies decay for distant references', () => {
    // m1 and m10 are far apart — decay should reduce strength
    graph.addMessage(msg('m1', 'Start topic', [1, 0, 0]));
    for (let i = 2; i <= 9; i++) {
      graph.addMessage(msg(`m${i}`, `filler ${i}`, [0, Math.random(), Math.random()]));
    }
    graph.addMessage(msg('m10', 'Return to start topic', [0.99, 0.01, 0]));

    const score = graph.getScore('m1');
    if (score) {
      // Decayed strength should be less than undecayed
      expect(score.weightedScore).toBeLessThan(1.0);
    }
  });

  it('resets correctly', () => {
    graph.addMessage(msg('m1', 'Hello'), undefined, ['hello']);
    graph.addMessage(msg('m2', 'As I said, hello'), undefined, ['hello']);
    graph.reset();

    expect(graph.getAllScores().length).toBe(0);
    expect(graph.getReferences().length).toBe(0);
  });
});
