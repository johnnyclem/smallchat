import type { ToolIMP, ToolMethod, ToolProtocol, ToolSchema, ToolSelector, ToolResult, TransportType, ArgumentConstraints, ValidationResult, InferenceDelta } from './types.js';
import { OverloadTable } from './overload-table.js';
import type { OverloadResolutionResult } from './overload-table.js';
import type { SCMethodSignature } from './sc-types.js';
import { MCPTransport, getTransport, type TransportOptions } from '../mcp/transport.js';

/**
 * ToolClass — a group of related tools from one provider.
 *
 * Equivalent to an Objective-C class: has a dispatch table, protocol
 * conformances, and an optional superclass for inheritance chains.
 *
 * Now supports overloaded methods: the same selector can dispatch to
 * different IMPs depending on the types and number of arguments.
 */
export class ToolClass {
  readonly name: string;
  readonly protocols: ToolProtocol[] = [];
  readonly dispatchTable: Map<string, ToolIMP> = new Map();
  /** Overload tables keyed by selector canonical name */
  readonly overloadTables: Map<string, OverloadTable> = new Map();
  superclass: ToolClass | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** Register a method (selector → IMP mapping) */
  addMethod(selector: ToolSelector, imp: ToolIMP): void {
    this.dispatchTable.set(selector.canonical, imp);
  }

  /**
   * Register an overloaded method — same selector, different signature.
   * The first overload registered also becomes the default IMP in the dispatch table.
   */
  addOverload(
    selector: ToolSelector,
    signature: SCMethodSignature,
    imp: ToolIMP,
    options?: { originalToolName?: string; isSemanticOverload?: boolean },
  ): void {
    let table = this.overloadTables.get(selector.canonical);
    if (!table) {
      table = new OverloadTable(selector.canonical);
      this.overloadTables.set(selector.canonical, table);
    }

    table.register(signature, imp, options);

    // First overload becomes the default IMP
    if (!this.dispatchTable.has(selector.canonical)) {
      this.dispatchTable.set(selector.canonical, imp);
    }
  }

  /** Declare conformance to a protocol */
  addProtocol(protocol: ToolProtocol): void {
    this.protocols.push(protocol);
  }

  /** Check protocol conformance */
  conformsTo(protocol: ToolProtocol): boolean {
    return this.protocols.some(p => p.name === protocol.name);
  }

  /**
   * Resolve a selector by walking the dispatch table and isa chain.
   * Like Obj-C method resolution: own table → superclass → null (triggers forwarding).
   */
  resolveSelector(selector: ToolSelector): ToolIMP | null {
    // Check own dispatch table
    const direct = this.dispatchTable.get(selector.canonical);
    if (direct) return direct;

    // Walk superclass chain
    if (this.superclass) {
      return this.superclass.resolveSelector(selector);
    }

    return null; // will trigger forwarding
  }

  /**
   * Resolve a selector with argument types — uses overload tables when available.
   * Falls back to standard resolveSelector if no overloads are registered.
   */
  resolveSelectorWithArgs(
    selector: ToolSelector,
    args: unknown[],
  ): OverloadResolutionResult | null {
    const table = this.overloadTables.get(selector.canonical);
    if (table && table.size > 0) {
      return table.resolve(args);
    }

    // Fall back to checking superclass overload tables
    if (this.superclass) {
      return this.superclass.resolveSelectorWithArgs(selector, args);
    }

    return null;
  }

  /**
   * Resolve a selector with named arguments — maps names to positions
   * using the overload signatures.
   */
  resolveSelectorWithNamedArgs(
    selector: ToolSelector,
    namedArgs: Record<string, unknown>,
  ): OverloadResolutionResult | null {
    const table = this.overloadTables.get(selector.canonical);
    if (table && table.size > 0) {
      return table.resolveNamed(namedArgs);
    }

    if (this.superclass) {
      return this.superclass.resolveSelectorWithNamedArgs(selector, namedArgs);
    }

    return null;
  }

  /**
   * Resolve a selector with strict signature validation (hardened path).
   *
   * Like resolveSelectorWithNamedArgs, but after resolving the overload,
   * strictly validates every argument against the winning signature's
   * SCObject type hierarchy. Throws SignatureValidationError on mismatch.
   *
   * Use this to prevent Type Confusion attacks from LLM-suggested arguments.
   */
  validateAndResolveSelectorWithNamedArgs(
    selector: ToolSelector,
    namedArgs: Record<string, unknown>,
  ): OverloadResolutionResult | null {
    const table = this.overloadTables.get(selector.canonical);
    if (table && table.size > 0) {
      return table.validateAndResolveNamed(namedArgs);
    }

    if (this.superclass) {
      return this.superclass.validateAndResolveSelectorWithNamedArgs(selector, namedArgs);
    }

    return null;
  }

  /**
   * Resolve a selector with strict positional argument validation (hardened path).
   *
   * Throws SignatureValidationError if arguments violate the type hierarchy.
   */
  validateAndResolveSelectorWithArgs(
    selector: ToolSelector,
    args: unknown[],
  ): OverloadResolutionResult | null {
    const table = this.overloadTables.get(selector.canonical);
    if (table && table.size > 0) {
      return table.validateAndResolve(args);
    }

    if (this.superclass) {
      return this.superclass.validateAndResolveSelectorWithArgs(selector, args);
    }

    return null;
  }

  /** Check if a selector has overloads */
  hasOverloads(selector: ToolSelector): boolean {
    const table = this.overloadTables.get(selector.canonical);
    return table !== undefined && table.size > 1;
  }

  /** respondsToSelector: equivalent */
  canHandle(selector: ToolSelector): boolean {
    return this.resolveSelector(selector) !== null;
  }

  /** All selectors this class responds to */
  allSelectors(): string[] {
    const selectors = Array.from(this.dispatchTable.keys());
    if (this.superclass) {
      selectors.push(...this.superclass.allSelectors());
    }
    return selectors;
  }
}

/**
 * ToolProxy — lazy-loaded tool that loads its full schema only on first dispatch.
 *
 * Equivalent to NSProxy: exists as a lightweight stand-in until someone
 * actually sends it a message, at which point it realizes itself.
 */
export class ToolProxy implements ToolIMP {
  providerId: string;
  toolName: string;
  transportType: TransportType;
  schema: ToolSchema | null = null;
  schemaLoader: () => Promise<ToolSchema>;
  constraints: ArgumentConstraints;

  /** Optional endpoint for remote transports */
  endpoint?: string;
  /** Optional headers for remote transports */
  headers?: Record<string, string>;

  private realized = false;
  private transport: MCPTransport | null = null;

  constructor(
    providerId: string,
    toolName: string,
    transportType: TransportType,
    schemaLoader: () => Promise<ToolSchema>,
    constraints?: ArgumentConstraints,
    transportOptions?: { endpoint?: string; headers?: Record<string, string> },
  ) {
    this.providerId = providerId;
    this.toolName = toolName;
    this.transportType = transportType;
    this.schemaLoader = schemaLoader;
    this.constraints = constraints ?? createPassthroughConstraints();
    this.endpoint = transportOptions?.endpoint;
    this.headers = transportOptions?.headers;
  }

  /** Load full schema on first use */
  private async realize(): Promise<void> {
    if (this.realized) return;
    this.schema = await this.schemaLoader();
    this.realized = true;
  }

  /** Get or create the transport instance */
  private getTransport(): MCPTransport {
    if (!this.transport) {
      this.transport = getTransport(this.providerId, {
        transportType: this.transportType,
        endpoint: this.endpoint,
        headers: this.headers,
      });
    }
    return this.transport;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    await this.realize();

    const validation = this.constraints.validate(args);
    if (!validation.valid) {
      return {
        content: { errors: validation.errors },
        isError: true,
        metadata: { validationErrors: validation.errors },
      };
    }

    // Route through the real MCP transport engine
    const transport = this.getTransport();
    return transport.execute(this.toolName, args);
  }

  /**
   * Chunk-level streaming execution.
   * Falls back to single-shot if the transport doesn't support streaming.
   */
  async *executeStream(args: Record<string, unknown>): AsyncGenerator<ToolResult> {
    await this.realize();

    const validation = this.constraints.validate(args);
    if (!validation.valid) {
      yield {
        content: { errors: validation.errors },
        isError: true,
        metadata: { validationErrors: validation.errors },
      };
      return;
    }

    const transport = this.getTransport();
    yield* transport.executeStream(this.toolName, args);
  }

  /**
   * Token-level inference streaming.
   * Only supported by MCP transport — other transports return nothing.
   */
  async *executeInference(args: Record<string, unknown>): AsyncGenerator<InferenceDelta> {
    await this.realize();

    const validation = this.constraints.validate(args);
    if (!validation.valid) return;

    const transport = this.getTransport();
    yield* transport.executeInference(this.toolName, args);
  }
}

/** Creates constraints that accept any arguments (used as default) */
function createPassthroughConstraints(): ArgumentConstraints {
  return {
    required: [],
    optional: [],
    validate(_args: Record<string, unknown>): ValidationResult {
      return { valid: true, errors: [] };
    },
  };
}
