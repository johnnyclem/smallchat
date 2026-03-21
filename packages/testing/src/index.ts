import type {
  Embedder,
  VectorIndex,
  SelectorMatch,
  ToolIMP,
  ToolResult,
  ToolSchema,
  ToolSelector,
  ArgumentConstraints,
  ValidationResult,
  TransportType,
  DispatchEvent,
} from 'smallchat';

// ---------------------------------------------------------------------------
// MockEmbedder — deterministic embedder for testing
// ---------------------------------------------------------------------------

/**
 * A mock embedder that produces deterministic hash-based embeddings.
 * Useful for testing dispatch logic without requiring ONNX or real models.
 */
export class MockEmbedder implements Embedder {
  readonly dimensions: number;
  private responses: Map<string, Float32Array> = new Map();

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  /**
   * Register a specific embedding response for a given input.
   */
  when(text: string, vector: Float32Array): this {
    this.responses.set(text, vector);
    return this;
  }

  async embed(text: string): Promise<Float32Array> {
    const preset = this.responses.get(text);
    if (preset) return preset;
    return hashEmbed(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ---------------------------------------------------------------------------
// MockVectorIndex — in-memory vector index for testing
// ---------------------------------------------------------------------------

/**
 * A mock vector index that stores vectors in memory and supports
 * configurable search results.
 */
export class MockVectorIndex implements VectorIndex {
  private vectors: Map<string, Float32Array> = new Map();
  private searchOverrides: Map<string, SelectorMatch[]> = new Map();

  insert(id: string, vector: Float32Array): void {
    this.vectors.set(id, vector);
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  size(): number {
    return this.vectors.size;
  }

  /**
   * Override search results for a specific intent (matched by vector hash).
   */
  whenSearch(matches: SelectorMatch[]): this {
    // Use a special key to always return these matches
    this.searchOverrides.set('*', matches);
    return this;
  }

  search(vector: Float32Array, topK: number, threshold: number): SelectorMatch[] {
    // Check for overrides
    const override = this.searchOverrides.get('*');
    if (override) return override.slice(0, topK);

    // Basic cosine similarity search
    const results: SelectorMatch[] = [];
    for (const [id, stored] of this.vectors) {
      const distance = cosineDistance(vector, stored);
      if (distance <= (1 - threshold)) {
        results.push({ id, distance });
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, topK);
  }
}

// ---------------------------------------------------------------------------
// MockToolIMP — mock tool implementation for testing dispatch
// ---------------------------------------------------------------------------

/**
 * A mock tool implementation that records calls and returns preset results.
 */
export class MockToolIMP implements ToolIMP {
  providerId: string;
  toolName: string;
  transportType: TransportType = 'local';
  schema: ToolSchema | null = null;
  schemaLoader: () => Promise<ToolSchema>;
  constraints: ArgumentConstraints;

  /** All calls made to this mock */
  readonly calls: Array<{ args: Record<string, unknown>; timestamp: number }> = [];

  private result: ToolResult;

  constructor(
    providerId: string,
    toolName: string,
    result?: ToolResult,
  ) {
    this.providerId = providerId;
    this.toolName = toolName;
    this.result = result ?? { content: `Mock result from ${toolName}` };
    this.schemaLoader = async () => ({
      name: toolName,
      description: `Mock schema for ${toolName}`,
      inputSchema: { type: 'object' },
      arguments: [],
    });
    this.constraints = {
      required: [],
      optional: [],
      validate: () => ({ valid: true, errors: [] }),
    };
  }

  /**
   * Set the result this mock will return.
   */
  returns(result: ToolResult): this {
    this.result = result;
    return this;
  }

  /**
   * Set the mock to return an error.
   */
  throws(message: string): this {
    this.result = { content: message, isError: true };
    return this;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    this.calls.push({ args, timestamp: Date.now() });
    return this.result;
  }

  /** Check if this mock was called */
  get called(): boolean {
    return this.calls.length > 0;
  }

  /** Number of times this mock was called */
  get callCount(): number {
    return this.calls.length;
  }

  /** Get the arguments from the last call */
  get lastCall(): Record<string, unknown> | undefined {
    return this.calls[this.calls.length - 1]?.args;
  }

  /** Reset call history */
  reset(): void {
    this.calls.length = 0;
  }
}

// ---------------------------------------------------------------------------
// createMockSelector — create a ToolSelector for testing
// ---------------------------------------------------------------------------

/**
 * Create a mock ToolSelector with a deterministic vector.
 */
export function createMockSelector(canonical: string, dimensions: number = 384): ToolSelector {
  return {
    vector: hashEmbed(canonical, dimensions),
    canonical,
    parts: canonical.split(':'),
    arity: canonical.split(':').length - 1,
  };
}

// ---------------------------------------------------------------------------
// assertDispatchResult — assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a ToolResult is not an error and has content.
 */
export function assertSuccess(result: ToolResult): void {
  if (result.isError) {
    throw new Error(`Expected successful result but got error: ${JSON.stringify(result.content)}`);
  }
}

/**
 * Assert that a ToolResult is an error.
 */
export function assertError(result: ToolResult): void {
  if (!result.isError) {
    throw new Error(`Expected error result but got success: ${JSON.stringify(result.content)}`);
  }
}

/**
 * Collect all events from an async generator into an array.
 */
export async function collectEvents(stream: AsyncIterable<DispatchEvent>): Promise<DispatchEvent[]> {
  const events: DispatchEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashEmbed(text: string, dimensions: number): Float32Array {
  const vec = new Float32Array(dimensions);
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dimensions; i++) {
    h = ((h << 5) - h + i) | 0;
    vec[i] = (h & 0xffff) / 0xffff;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) vec[i] /= norm;
  }
  return vec;
}

function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}
