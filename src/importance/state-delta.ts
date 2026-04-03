/**
 * Signal 1: State Delta — entity-relationship graph mutation detection.
 *
 * Maintains a running entity-relationship graph and measures how much
 * each new message mutates it. Messages that add/remove/modify entities
 * or relations are high-importance by definition — regardless of domain.
 *
 * The key insight from information theory: a message's importance is
 * proportional to how much it changes the known state, not what domain
 * that state belongs to.
 */

import type {
  ConversationMessage,
  EntityNode,
  EntityRelation,
  StateDelta,
} from './types.js';

// ---------------------------------------------------------------------------
// Entity extraction patterns (domain-agnostic heuristics)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate entity relationships or state changes.
 * These work across domains because they capture structural language
 * patterns, not domain-specific terminology.
 */
const RELATION_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  direction: 'forward' | 'reverse';
}> = [
  { pattern: /(\w[\w\s]*?)\s+(?:uses?|using)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'uses', direction: 'forward' },
  { pattern: /(\w[\w\s]*?)\s+(?:replaces?|replacing|replaced by)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'replaces', direction: 'forward' },
  { pattern: /(\w[\w\s]*?)\s+(?:depends?\s+on|requires?)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'depends_on', direction: 'forward' },
  { pattern: /(\w[\w\s]*?)\s+(?:is|are)\s+(?:not|n't)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'contradicts', direction: 'forward' },
  { pattern: /(?:swap|change|switch)\s+(\w[\w\s]*?)\s+(?:for|to|with)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'replaces', direction: 'reverse' },
  { pattern: /(?:remove|delete|drop)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'removes', direction: 'forward' },
  { pattern: /(?:add|create|introduce|include)\s+(\w[\w\s]*?)(?:\.|,|$)/gi, label: 'adds', direction: 'forward' },
];

/**
 * Contradiction / override indicators — when present, the message
 * is modifying previously established state.
 */
const OVERRIDE_INDICATORS = [
  /\bactually\b/i,
  /\binstead\b/i,
  /\bno,?\s/i,
  /\bwait\b/i,
  /\bscratch that\b/i,
  /\bnot\s+\w+,?\s+but\b/i,
  /\bchange\s+(?:that|this|it)\b/i,
  /\bforget\s+(?:that|what|about)\b/i,
  /\bcorrection\b/i,
  /\bupdate:\s/i,
];

// ---------------------------------------------------------------------------
// Entity-relationship graph
// ---------------------------------------------------------------------------

export class EntityGraph {
  private nodes: Map<string, EntityNode> = new Map();
  private edges: EntityRelation[] = [];

  /** Get a snapshot of all nodes. */
  getNodes(): ReadonlyMap<string, EntityNode> {
    return this.nodes;
  }

  /** Get a snapshot of all edges. */
  getEdges(): ReadonlyArray<EntityRelation> {
    return this.edges;
  }

  /** Total graph size (nodes + edges). */
  get size(): number {
    return this.nodes.size + this.edges.length;
  }

  /** Add or update a node. Returns true if the node was new. */
  addNode(node: EntityNode): boolean {
    const key = node.name.toLowerCase();
    const existing = this.nodes.get(key);
    if (existing) {
      // Merge attributes
      for (const [k, v] of node.attributes) {
        existing.attributes.set(k, v);
      }
      existing.lastModifiedBy = node.lastModifiedBy;
      return false;
    }
    this.nodes.set(key, { ...node, name: key });
    return true;
  }

  /** Remove a node and all its edges. Returns true if the node existed. */
  removeNode(name: string): boolean {
    const key = name.toLowerCase();
    if (!this.nodes.has(key)) return false;
    this.nodes.delete(key);
    this.edges = this.edges.filter(e => e.from !== key && e.to !== key);
    return true;
  }

  /** Check if a node exists. */
  hasNode(name: string): boolean {
    return this.nodes.has(name.toLowerCase());
  }

  /** Get a node by name. */
  getNode(name: string): EntityNode | undefined {
    return this.nodes.get(name.toLowerCase());
  }

  /** Add an edge. Returns true if it was new. */
  addEdge(relation: EntityRelation): boolean {
    const from = relation.from.toLowerCase();
    const to = relation.to.toLowerCase();
    const exists = this.edges.some(
      e => e.from === from && e.to === to && e.label === relation.label,
    );
    if (exists) return false;
    this.edges.push({ ...relation, from, to });
    return true;
  }

  /** Remove edges matching from/to/label. Returns count removed. */
  removeEdges(from: string, to: string, label?: string): number {
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();
    const before = this.edges.length;
    this.edges = this.edges.filter(e => {
      if (e.from !== fromKey || e.to !== toKey) return true;
      if (label && e.label !== label) return true;
      return false;
    });
    return before - this.edges.length;
  }

  /** Find edges involving a given entity. */
  edgesFor(name: string): EntityRelation[] {
    const key = name.toLowerCase();
    return this.edges.filter(e => e.from === key || e.to === key);
  }

  /** Reset the graph. */
  clear(): void {
    this.nodes.clear();
    this.edges = [];
  }
}

// ---------------------------------------------------------------------------
// State delta computation
// ---------------------------------------------------------------------------

/**
 * Extract entities from message text using lightweight heuristics.
 *
 * This is deliberately simple — it catches quoted terms, capitalized phrases,
 * backtick-wrapped identifiers, and terms near relation keywords. It does NOT
 * require NER models or domain dictionaries.
 */
export function extractEntities(text: string, messageId: string): EntityNode[] {
  const entities: Map<string, EntityNode> = new Map();

  const addEntity = (name: string, type: string) => {
    const key = name.toLowerCase().trim();
    if (key.length < 2 || key.length > 60) return;
    // Skip common stopwords that aren't meaningful entities
    if (STOPWORDS.has(key)) return;
    if (!entities.has(key)) {
      entities.set(key, {
        name: key,
        type,
        introducedBy: messageId,
        lastModifiedBy: messageId,
        attributes: new Map(),
      });
    }
  };

  // Backtick-wrapped identifiers (code entities)
  for (const match of text.matchAll(/`([^`]{2,50})`/g)) {
    addEntity(match[1], 'identifier');
  }

  // Quoted terms (named things)
  for (const match of text.matchAll(/"([^"]{2,50})"/g)) {
    addEntity(match[1], 'named');
  }

  // Capitalized multi-word phrases (proper nouns / concepts), but not sentence starts
  for (const match of text.matchAll(/(?:^|[.!?]\s+)(?:\w+\s+)*?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g)) {
    addEntity(match[1], 'concept');
  }

  // Terms near relation keywords (contextual extraction)
  for (const { pattern } of RELATION_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) addEntity(match[1].trim(), 'contextual');
      if (match[2]) addEntity(match[2].trim(), 'contextual');
    }
  }

  return Array.from(entities.values());
}

/**
 * Extract relations from message text.
 */
export function extractRelations(text: string, messageId: string): EntityRelation[] {
  const relations: EntityRelation[] = [];

  for (const { pattern, label, direction } of RELATION_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!match[1] || (label !== 'removes' && label !== 'adds' && !match[2])) continue;
      const first = match[1].trim().toLowerCase();
      const second = match[2]?.trim().toLowerCase();

      if (first.length < 2 || (second && second.length < 2)) continue;
      if (STOPWORDS.has(first) || (second && STOPWORDS.has(second))) continue;

      if (label === 'removes' || label === 'adds') {
        // Unary — no edge, but important for node tracking
        continue;
      }

      const from = direction === 'forward' ? first : second!;
      const to = direction === 'forward' ? second! : first;

      relations.push({ from, to, label, establishedBy: messageId });
    }
  }

  return relations;
}

/**
 * Compute the state delta for a message against the current graph.
 *
 * This is the core of Signal 1: it measures how much a single message
 * changes the running entity-relationship state.
 */
export function computeStateDelta(
  message: ConversationMessage,
  graph: EntityGraph,
): StateDelta {
  const delta: StateDelta = {
    nodesAdded: [],
    nodesRemoved: [],
    nodesModified: [],
    edgesAdded: [],
    edgesRemoved: [],
    magnitude: 0,
  };

  const text = message.content;

  // Check for override / contradiction indicators
  const hasOverride = OVERRIDE_INDICATORS.some(p => p.test(text));

  // Extract entities and relations
  const newEntities = extractEntities(text, message.id);
  const newRelations = extractRelations(text, message.id);

  // Process entities
  for (const entity of newEntities) {
    const existing = graph.getNode(entity.name);
    if (!existing) {
      delta.nodesAdded.push(entity);
      graph.addNode(entity);
    } else {
      // Check for attribute changes
      const changedAttrs: string[] = [];
      for (const [k, v] of entity.attributes) {
        if (existing.attributes.get(k) !== v) {
          changedAttrs.push(k);
        }
      }
      if (changedAttrs.length > 0 || hasOverride) {
        delta.nodesModified.push({ name: entity.name, changedAttributes: changedAttrs });
        graph.addNode(entity); // updates lastModifiedBy
      }
    }
  }

  // Process "replaces" relations — the replaced entity gets removed
  for (const rel of newRelations) {
    if (rel.label === 'replaces' && graph.hasNode(rel.to)) {
      delta.nodesRemoved.push(rel.to);
      // Don't actually remove from graph — mark as superseded
      const removedEdges = graph.edgesFor(rel.to);
      for (const edge of removedEdges) {
        delta.edgesRemoved.push({ from: edge.from, to: edge.to, label: edge.label });
      }
    }
  }

  // Process relations
  for (const rel of newRelations) {
    // If this contradicts an existing edge, count the old one as removed
    if (rel.label === 'contradicts') {
      const existing = graph.getEdges().filter(
        e => (e.from === rel.from && e.to === rel.to) || (e.from === rel.to && e.to === rel.from),
      );
      for (const edge of existing) {
        delta.edgesRemoved.push({ from: edge.from, to: edge.to, label: edge.label });
      }
    }

    const isNew = graph.addEdge(rel);
    if (isNew) {
      delta.edgesAdded.push(rel);
    }
  }

  // Compute magnitude: weighted sum of mutations
  // Node additions and removals are higher impact than modifications
  delta.magnitude =
    delta.nodesAdded.length * 1.0 +
    delta.nodesRemoved.length * 1.5 +  // removals are rarer and more impactful
    delta.nodesModified.length * 0.7 +
    delta.edgesAdded.length * 0.8 +
    delta.edgesRemoved.length * 1.2;    // contradictions are highly informative

  // Override indicators boost magnitude even without extracted entities
  if (hasOverride && delta.magnitude < 1.0) {
    delta.magnitude = Math.max(delta.magnitude, 1.0);
  }

  return delta;
}

// ---------------------------------------------------------------------------
// Stopwords — filtered from entity extraction
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'and', 'but', 'or', 'nor', 'for', 'yet', 'so',
  'in', 'on', 'at', 'to', 'from', 'by', 'with', 'about', 'of',
  'not', 'no', 'yes', 'ok', 'okay', 'sure', 'thanks', 'thank',
  'hello', 'hi', 'hey', 'goodbye', 'bye',
  'please', 'just', 'also', 'very', 'really', 'quite', 'too',
]);
