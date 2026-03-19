import type {
  ArgumentConstraints,
  CompilationResult,
  Embedder,
  ProviderManifest,
  SelectorCollision,
  ToolIMP,
  ToolProtocol,
  ToolSchema,
  ToolSelector,
  ValidationResult,
  VectorIndex,
} from '../core/types.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { parseMCPManifest, type ParsedTool } from './parser.js';

/**
 * ToolCompiler — the build-time tool that produces dispatch tables,
 * selector tables, protocol conformances, and the embedding index.
 *
 * Equivalent to clang producing Obj-C metadata tables.
 *
 * Pipeline: PARSE → EMBED → LINK → OUTPUT
 */
export class ToolCompiler {
  private embedder: Embedder;
  private vectorIndex: VectorIndex;
  private selectorTable: SelectorTable;
  private collisionThreshold: number;

  constructor(
    embedder: Embedder,
    vectorIndex: VectorIndex,
    options?: CompilerOptions,
  ) {
    this.embedder = embedder;
    this.vectorIndex = vectorIndex;
    this.collisionThreshold = options?.collisionThreshold ?? 0.89;
    this.selectorTable = new SelectorTable(
      vectorIndex,
      embedder,
      options?.deduplicationThreshold ?? 0.95,
    );
  }

  /**
   * Compile tool definitions from provider manifests into a compiled artifact.
   */
  async compile(manifests: ProviderManifest[]): Promise<CompilationResult> {
    // Phase 1: PARSE
    const allTools: ParsedTool[] = [];
    for (const manifest of manifests) {
      allTools.push(...parseMCPManifest(manifest));
    }

    // Phase 2: EMBED — generate embeddings and intern selectors
    const toolSelectors: Map<ParsedTool, ToolSelector> = new Map();
    let mergedCount = 0;
    const selectorsBefore = this.selectorTable.size;

    for (const tool of allTools) {
      const text = `${tool.name}: ${tool.description}`;
      const embedding = await this.embedder.embed(text);
      const canonical = `${tool.providerId}.${tool.name}`;

      const selector = this.selectorTable.intern(embedding, canonical);

      // If the selector already existed, this tool was merged (deduplicated)
      if (this.selectorTable.size === selectorsBefore + toolSelectors.size) {
        mergedCount++;
      }

      toolSelectors.set(tool, selector);
    }

    // Phase 3: LINK — build dispatch tables and detect collisions
    const dispatchTables: Map<string, Map<string, ToolIMP>> = new Map();
    const collisions: SelectorCollision[] = [];

    // Group tools by provider
    const providerTools: Map<string, ParsedTool[]> = new Map();
    for (const tool of allTools) {
      const tools = providerTools.get(tool.providerId) ?? [];
      tools.push(tool);
      providerTools.set(tool.providerId, tools);
    }

    // Build dispatch table per provider (ToolClass)
    for (const [providerId, tools] of providerTools) {
      const table: Map<string, ToolIMP> = new Map();

      for (const tool of tools) {
        const selector = toolSelectors.get(tool)!;
        const imp = this.createIMP(tool);
        table.set(selector.canonical, imp);
      }

      dispatchTables.set(providerId, table);
    }

    // Detect selector collisions
    const allSelectors = this.selectorTable.all();
    for (let i = 0; i < allSelectors.length; i++) {
      for (let j = i + 1; j < allSelectors.length; j++) {
        const a = allSelectors[i];
        const b = allSelectors[j];
        const similarity = cosineSim(a.vector, b.vector);

        if (similarity > this.collisionThreshold && similarity < 0.95) {
          collisions.push({
            selectorA: a.canonical,
            selectorB: b.canonical,
            similarity,
            hint: `Disambiguation needed: "${a.canonical}" and "${b.canonical}" are similar (${(similarity * 100).toFixed(1)}%).`,
          });
        }
      }
    }

    return {
      selectors: new Map(allSelectors.map(s => [s.canonical, s])),
      dispatchTables,
      protocols: [],
      toolCount: allTools.length,
      uniqueSelectorCount: this.selectorTable.size,
      mergedCount,
      collisions,
    };
  }

  /**
   * Build ToolClass instances from a compilation result.
   */
  buildClasses(result: CompilationResult): ToolClass[] {
    const classes: ToolClass[] = [];

    for (const [providerId, table] of result.dispatchTables) {
      const toolClass = new ToolClass(providerId);

      for (const [canonical, imp] of table) {
        const selector = result.selectors.get(canonical);
        if (selector) {
          toolClass.addMethod(selector, imp);
        }
      }

      classes.push(toolClass);
    }

    return classes;
  }

  /** Create a ToolIMP (as a ToolProxy) from a parsed tool */
  private createIMP(tool: ParsedTool): ToolIMP {
    const constraints = createConstraints(tool);
    return new ToolProxy(
      tool.providerId,
      tool.name,
      tool.transportType,
      async (): Promise<ToolSchema> => ({
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object', properties: {} },
        arguments: tool.arguments,
      }),
      constraints,
    );
  }
}

/** Create argument constraints from a parsed tool */
function createConstraints(tool: ParsedTool): ArgumentConstraints {
  const required = tool.arguments.filter(a => a.required);
  const optional = tool.arguments.filter(a => !a.required);

  return {
    required,
    optional,
    validate(args: Record<string, unknown>): ValidationResult {
      const errors = [];
      for (const arg of required) {
        if (!(arg.name in args)) {
          errors.push({
            path: arg.name,
            message: `Required argument "${arg.name}" is missing`,
            expected: arg.type.type,
          });
        }
      }
      return { valid: errors.length === 0, errors };
    },
  };
}

/** Cosine similarity between two vectors */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface CompilerOptions {
  collisionThreshold?: number;
  deduplicationThreshold?: number;
}
