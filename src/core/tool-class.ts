import type { ToolIMP, ToolMethod, ToolProtocol, ToolSchema, ToolSelector, ToolResult, TransportType, ArgumentConstraints, ValidationResult } from './types.js';

/**
 * ToolClass — a group of related tools from one provider.
 *
 * Equivalent to an Objective-C class: has a dispatch table, protocol
 * conformances, and an optional superclass for inheritance chains.
 */
export class ToolClass {
  readonly name: string;
  readonly protocols: ToolProtocol[] = [];
  readonly dispatchTable: Map<string, ToolIMP> = new Map();
  superclass: ToolClass | null = null;

  constructor(name: string) {
    this.name = name;
  }

  /** Register a method (selector → IMP mapping) */
  addMethod(selector: ToolSelector, imp: ToolIMP): void {
    this.dispatchTable.set(selector.canonical, imp);
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

  private realized = false;

  constructor(
    providerId: string,
    toolName: string,
    transportType: TransportType,
    schemaLoader: () => Promise<ToolSchema>,
    constraints?: ArgumentConstraints,
  ) {
    this.providerId = providerId;
    this.toolName = toolName;
    this.transportType = transportType;
    this.schemaLoader = schemaLoader;
    this.constraints = constraints ?? createPassthroughConstraints();
  }

  /** Load full schema on first use */
  private async realize(): Promise<void> {
    if (this.realized) return;
    this.schema = await this.schemaLoader();
    this.realized = true;
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

    // In v0.0.1, actual transport execution is stubbed.
    // Real implementations will route through MCP/REST/gRPC transports.
    return {
      content: null,
      isError: true,
      metadata: { error: `Transport '${this.transportType}' not yet implemented for ${this.toolName}` },
    };
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
