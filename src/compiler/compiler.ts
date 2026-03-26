import type {
  ArgumentConstraints,
  CompilationResult,
  Embedder,
  OverloadEntryData,
  OverloadTableData,
  ProviderManifest,
  SelectorCollision,
  SemanticOverloadGroup,
  ToolIMP,
  ToolProtocol,
  ToolSchema,
  ToolSelector,
  ValidationResult,
  VectorIndex,
} from '../core/types.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { OverloadTable } from '../core/overload-table.js';
import { createSignature, param, SCType } from '../core/sc-types.js';
import type { SCTypeDescriptor, SCParameterSlot } from '../core/sc-types.js';
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
  private generateSemanticOverloads: boolean;
  private semanticOverloadThreshold: number;

  constructor(
    embedder: Embedder,
    vectorIndex: VectorIndex,
    options?: CompilerOptions,
  ) {
    this.embedder = embedder;
    this.vectorIndex = vectorIndex;
    this.collisionThreshold = options?.collisionThreshold ?? 0.89;
    this.generateSemanticOverloads = options?.generateSemanticOverloads ?? false;
    this.semanticOverloadThreshold = options?.semanticOverloadThreshold ?? 0.82;
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
    const toolEmbeddings: Map<ParsedTool, Float32Array> = new Map();
    let mergedCount = 0;
    const selectorsBefore = this.selectorTable.size;

    for (const tool of allTools) {
      const text = `${tool.name}: ${tool.description}`;
      const embedding = await this.embedder.embed(text);
      const canonical = `${tool.providerId}.${tool.name}`;

      toolEmbeddings.set(tool, embedding);
      const selector = await this.selectorTable.intern(embedding, canonical);

      // If the selector already existed, this tool was merged (deduplicated)
      if (this.selectorTable.size === selectorsBefore + toolSelectors.size) {
        mergedCount++;
      }

      toolSelectors.set(tool, selector);
    }

    // Phase 2.5: SEMANTIC OVERLOAD GENERATION (optional compiler pass)
    const overloadTables: Map<string, OverloadTableData> = new Map();
    const semanticOverloads: SemanticOverloadGroup[] = [];

    if (this.generateSemanticOverloads) {
      const groups = this.findSemanticGroups(allTools, toolEmbeddings);

      for (const group of groups) {
        const canonicalSelector = group.tools[0].providerId + '.' + group.tools[0].name;
        const overloadEntries: OverloadEntryData[] = [];

        for (const tool of group.tools) {
          const slots = toolArgsToParameterSlots(tool);
          const sig = createSignature(slots);

          overloadEntries.push({
            signatureKey: sig.signatureKey,
            parameterNames: slots.map(s => s.name),
            parameterTypes: slots.map(s => typeDescriptorToString(s.type)),
            arity: sig.arity,
            toolName: tool.name,
            providerId: tool.providerId,
            isSemanticOverload: true,
          });
        }

        overloadTables.set(canonicalSelector, {
          selectorCanonical: canonicalSelector,
          overloads: overloadEntries,
        });

        semanticOverloads.push({
          canonicalSelector,
          tools: group.tools.map((t, i) => ({
            providerId: t.providerId,
            toolName: t.name,
            similarity: i === 0 ? 1.0 : group.similarities[i - 1],
          })),
          reason: `Tools grouped by semantic similarity above ${(this.semanticOverloadThreshold * 100).toFixed(0)}% threshold`,
        });
      }
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

    // Detect selector collisions (skip pairs that are now overloaded)
    const overloadedCanonicals = new Set(overloadTables.keys());
    const allSelectors = this.selectorTable.all();
    for (let i = 0; i < allSelectors.length; i++) {
      for (let j = i + 1; j < allSelectors.length; j++) {
        const a = allSelectors[i];
        const b = allSelectors[j];

        // Skip collisions between overloaded selectors
        if (overloadedCanonicals.has(a.canonical) || overloadedCanonicals.has(b.canonical)) {
          continue;
        }

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
      overloadTables,
      semanticOverloads,
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

  /**
   * Phase 2.5: Find groups of semantically similar tools that can be
   * overloaded under a single canonical selector.
   *
   * Uses union-find to cluster tools where pairwise similarity exceeds
   * the semantic overload threshold. Each cluster becomes one overload group.
   */
  private findSemanticGroups(
    tools: ParsedTool[],
    embeddings: Map<ParsedTool, Float32Array>,
  ): SemanticGroup[] {
    const n = tools.length;
    if (n < 2) return [];

    // Union-Find
    const parent = Array.from({ length: n }, (_, i) => i);
    const rank = new Array(n).fill(0);

    function find(x: number): number {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    }

    function union(a: number, b: number): void {
      const ra = find(a), rb = find(b);
      if (ra === rb) return;
      if (rank[ra] < rank[rb]) { parent[ra] = rb; }
      else if (rank[ra] > rank[rb]) { parent[rb] = ra; }
      else { parent[rb] = ra; rank[ra]++; }
    }

    // Pairwise similarity check
    const similarities: Map<string, number> = new Map();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const vecA = embeddings.get(tools[i]);
        const vecB = embeddings.get(tools[j]);
        if (!vecA || !vecB) continue;

        const sim = cosineSim(vecA, vecB);
        if (sim >= this.semanticOverloadThreshold) {
          union(i, j);
          similarities.set(`${i}:${j}`, sim);
        }
      }
    }

    // Collect groups (only groups with 2+ tools)
    const groupMap: Map<number, number[]> = new Map();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const group = groupMap.get(root) ?? [];
      group.push(i);
      groupMap.set(root, group);
    }

    const groups: SemanticGroup[] = [];
    for (const indices of groupMap.values()) {
      if (indices.length < 2) continue;

      // Ensure different argument signatures (otherwise it's a true duplicate, not an overload)
      const sigSet = new Set(indices.map(i => {
        const slots = toolArgsToParameterSlots(tools[i]);
        return createSignature(slots).signatureKey;
      }));
      if (sigSet.size < 2) continue;

      const groupTools = indices.map(i => tools[i]);
      const sims = indices.slice(1).map(i => {
        const key = `${indices[0]}:${i}`;
        const reverseKey = `${i}:${indices[0]}`;
        return similarities.get(key) ?? similarities.get(reverseKey) ?? 0;
      });

      groups.push({ tools: groupTools, similarities: sims });
    }

    return groups;
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
  /** Enable compiler-generated overloads for semantically similar tools */
  generateSemanticOverloads?: boolean;
  /** Similarity threshold for grouping tools as overloads (default 0.82) */
  semanticOverloadThreshold?: number;
  /** Priority hints from dream analysis — tools to boost, demote, or exclude. */
  priorityHints?: {
    boosted: Map<string, number>;
    demoted: Map<string, number>;
    excluded: Set<string>;
  };
}

/** Internal representation of a semantic group during compilation */
interface SemanticGroup {
  tools: ParsedTool[];
  similarities: number[]; // similarity of tool[i] to tool[0] for i > 0
}

/** Convert a ParsedTool's arguments to SCParameterSlots */
function toolArgsToParameterSlots(tool: ParsedTool): SCParameterSlot[] {
  return tool.arguments.map((arg, index) =>
    param(arg.name, index, jsonSchemaTypeToSCType(arg.type), arg.required, arg.default),
  );
}

/** Convert a JSONSchemaType to an SCTypeDescriptor */
function jsonSchemaTypeToSCType(schema: { type: string }): SCTypeDescriptor {
  switch (schema.type) {
    case 'string': return SCType.string();
    case 'number': case 'integer': return SCType.number();
    case 'boolean': return SCType.boolean();
    case 'null': return SCType.null();
    case 'object': return SCType.object('SCData');
    case 'array': return SCType.object('SCArray');
    default: return SCType.any();
  }
}

/** Convert an SCTypeDescriptor to a human-readable string */
function typeDescriptorToString(type: SCTypeDescriptor): string {
  switch (type.kind) {
    case 'primitive': return type.type;
    case 'object': return type.className;
    case 'union': return type.types.map(typeDescriptorToString).join(' | ');
    case 'any': return 'id';
  }
}
