import type {
  CompilationResult,
  CompiledToolRef,
  CompilerHint,
  DuplicateToolPair,
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
  VectorIndex,
} from '../core/types.js';
import { SelectorTable } from '../core/selector-table.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import { OverloadTable } from '../core/overload-table.js';
import { createSignature, param, SCType } from '../core/sc-types.js';
import type { SCTypeDescriptor, SCParameterSlot } from '../core/sc-types.js';
import { parseMCPManifest, applyManifestOverrides, type ParsedTool } from './parser.js';
import type { SmallChatManifest } from '../core/manifest.js';
import { AppCompiler } from '../app/app-compiler.js';
import { getTransport } from '../mcp/transport.js';
import { toolId } from '../core/tool-id.js';
import { createSchemaConstraints } from '../core/argument-validator.js';

/**
 * Thrown by compile() when two distinct tools embed at or above the
 * duplicate threshold. The compiler never merges tools; it refuses to build
 * a toolkit whose intents could not tell them apart, unless the caller
 * opts in with `allowDuplicates`.
 */
export class DuplicateToolError extends Error {
  readonly pairs: DuplicateToolPair[];

  constructor(pairs: DuplicateToolPair[], threshold: number) {
    const lines = pairs.map(
      p => `  ${p.toolA} <-> ${p.toolB} (cosine ${p.similarity.toFixed(3)}; selectors ${p.selectorA}, ${p.selectorB})`,
    );
    super(
      `${pairs.length} pair(s) of distinct tools embed at cosine >= ${threshold} and cannot be told apart:\n` +
      `${lines.join('\n')}\n` +
      'Disambiguate them with compiler hints (selectorHint, aliases, exclude), or pass ' +
      'allowDuplicates (--allow-duplicates) to keep every tool and accept ambiguous intent resolution.',
    );
    this.name = 'DuplicateToolError';
    this.pairs = pairs;
  }
}

/**
 * Thrown by compile() when two tools claim the same selector canonical
 * (a pinSelector or namespace clash) or the same tool id is declared twice.
 * One selector dispatches to exactly one tool, so this cannot be waived.
 */
export class SelectorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelectorConflictError';
  }
}

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
  private duplicateThreshold: number;
  private allowDuplicates: boolean;
  private collisionThreshold: number;
  private generateSemanticOverloads: boolean;
  private semanticOverloadThreshold: number;
  private compileApps: boolean;
  private appVectorIndex: VectorIndex | undefined;

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
    this.compileApps = options?.compileApps ?? true;
    this.appVectorIndex = options?.appVectorIndex;
    this.duplicateThreshold = options?.duplicateThreshold ?? options?.deduplicationThreshold ?? 0.95;
    this.allowDuplicates = options?.allowDuplicates ?? false;
  }

  /**
   * Compile tool definitions from provider manifests into a compiled artifact.
   *
   * @param manifests - Provider manifests to compile
   * @param projectManifest - Optional smallchat.json project manifest with overrides
   */
  async compile(
    manifests: ProviderManifest[],
    projectManifest?: SmallChatManifest,
  ): Promise<CompilationResult> {
    // Phase 1: PARSE
    let allTools: ParsedTool[] = [];
    for (const manifest of manifests) {
      allTools.push(...parseMCPManifest(manifest));
    }

    // Apply project-level hint overrides from smallchat.json
    if (projectManifest) {
      allTools = applyManifestOverrides(
        allTools,
        projectManifest.providerHints,
        projectManifest.toolHints,
      );
    }

    // Filter out tools marked as excluded via compiler hints
    const excludedTools = allTools.filter(t => t.compilerHints?.exclude);
    allTools = allTools.filter(t => !t.compilerHints?.exclude);

    if (excludedTools.length > 0) {
      for (const t of excludedTools) {
        console.log(`  Excluded (compiler hint): ${t.providerId}.${t.name}`);
      }
    }

    // Phase 2: EMBED — generate embeddings and register selectors.
    // Every tool gets its own selector under its exact canonical name; a
    // selector is never shared between tools, whatever the embeddings say.
    // Compiler hints can steer this phase:
    //   - selectorHint: appended to embedding text
    //   - pinSelector: the tool's canonical, taken literally
    //   - aliases: additional selectors pointing to the same IMP
    const selectorTable = new SelectorTable(this.vectorIndex, this.embedder);
    const toolSelectors: Map<ParsedTool, ToolSelector> = new Map();
    const toolEmbeddings: Map<ParsedTool, Float32Array> = new Map();
    const aliasSelectors: Map<ParsedTool, ToolSelector[]> = new Map();
    const toolIds: Map<ParsedTool, string> = new Map();
    const seenToolIds: Set<string> = new Set();
    const selectorOwners: Map<string, string> = new Map(); // canonical → tool id
    const toolRefs: CompiledToolRef[] = [];

    const claim = (canonical: string, id: string, embedding: Float32Array): ToolSelector => {
      const owner = selectorOwners.get(canonical);
      if (owner !== undefined && owner !== id) {
        throw new SelectorConflictError(
          `Selector "${canonical}" is claimed by both ${owner} and ${id}. ` +
          'Each tool needs its own selector — change the pinSelector, namespace, or alias.',
        );
      }
      selectorOwners.set(canonical, id);
      return selectorTable.register(embedding, canonical);
    };

    // Warn if multiple tools in the same collision group claim "preferred"
    const preferredByProvider: Map<string, string[]> = new Map();

    for (const tool of allTools) {
      const hints = tool.compilerHints;

      const id = toolId(tool.providerId, tool.name);
      if (seenToolIds.has(id)) {
        throw new SelectorConflictError(
          `Tool id "${id}" is declared more than once — tool names must be unique within a provider.`,
        );
      }
      toolIds.set(tool, id);
      seenToolIds.add(id);

      // Build embedding text — selectorHint steers the vector
      let embeddingText = `${tool.name}: ${tool.description}`;
      if (hints?.selectorHint) {
        embeddingText += ` ${hints.selectorHint}`;
      }

      // Determine canonical — pinSelector overrides the default
      const namespace = tool.providerHints?.namespace;
      const defaultCanonical = namespace
        ? `${namespace}.${tool.name}`
        : `${tool.providerId}.${tool.name}`;
      const canonical = hints?.pinSelector ?? defaultCanonical;

      const embedding = await this.embedder.embed(embeddingText);
      toolEmbeddings.set(tool, embedding);

      const selector = claim(canonical, id, embedding);
      toolSelectors.set(tool, selector);

      // Track preferred hints for collision warning
      if (hints?.preferred) {
        const existing = preferredByProvider.get(tool.providerId) ?? [];
        existing.push(tool.name);
        preferredByProvider.set(tool.providerId, existing);
      }

      // Process aliases — each alias gets its own selector pointing to the same tool
      const aliases: ToolSelector[] = [];
      for (const alias of new Set(hints?.aliases ?? [])) {
        const aliasEmbedding = await this.embedder.embed(alias);
        const aliasCanonical = `${canonical}~alias~${alias.replace(/\s+/g, '_')}`;
        aliases.push(claim(aliasCanonical, id, aliasEmbedding));
      }
      if (aliases.length > 0) {
        aliasSelectors.set(tool, aliases);
      }

      toolRefs.push({
        id,
        providerId: tool.providerId,
        toolName: tool.name,
        selector: selector.canonical,
        aliases: aliases.map(a => a.canonical),
      });
    }

    // Phase 2.5: SEMANTIC OVERLOAD GENERATION (optional compiler pass)
    const overloadTables: Map<string, OverloadTableData> = new Map();
    const semanticOverloads: SemanticOverloadGroup[] = [];
    // Tool id → overload group index; tools in one group are deliberately
    // similar, so they are exempt from duplicate detection.
    const overloadGroupOf: Map<string, number> = new Map();

    if (this.generateSemanticOverloads) {
      const groups = this.findSemanticGroups(allTools, toolEmbeddings);

      for (const [groupIndex, group] of groups.entries()) {
        for (const t of group.tools) overloadGroupOf.set(toolIds.get(t)!, groupIndex);
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

    // Phase 2.6: DUPLICATE DETECTION — distinct tools whose selectors embed
    // at or above the duplicate threshold. Reported once per tool pair (the
    // most similar selector pair), in manifest order.
    const allSelectors = selectorTable.all();
    const duplicatesByPair: Map<string, DuplicateToolPair> = new Map();
    for (let i = 0; i < allSelectors.length; i++) {
      for (let j = i + 1; j < allSelectors.length; j++) {
        const a = allSelectors[i];
        const b = allSelectors[j];
        const idA = selectorOwners.get(a.canonical)!;
        const idB = selectorOwners.get(b.canonical)!;
        if (idA === idB) continue;
        const groupA = overloadGroupOf.get(idA);
        if (groupA !== undefined && groupA === overloadGroupOf.get(idB)) continue;

        const similarity = cosineSim(a.vector, b.vector);
        if (similarity < this.duplicateThreshold) continue;

        const key = `${idA}\u0000${idB}`;
        const previous = duplicatesByPair.get(key);
        if (!previous || similarity > previous.similarity) {
          duplicatesByPair.set(key, {
            toolA: idA,
            toolB: idB,
            selectorA: a.canonical,
            selectorB: b.canonical,
            similarity,
          });
        }
      }
    }
    const duplicates = [...duplicatesByPair.values()];
    if (duplicates.length > 0 && !this.allowDuplicates) {
      throw new DuplicateToolError(duplicates, this.duplicateThreshold);
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

        // Wire alias selectors to the same IMP
        const aliases = aliasSelectors.get(tool);
        if (aliases) {
          for (const aliasSel of aliases) {
            table.set(aliasSel.canonical, imp);
          }
        }
      }

      dispatchTables.set(providerId, table);
    }

    // Detect selector collisions (skip pairs that are now overloaded or aliased)
    // 0.4.0 COLLISION FIREWALL: expanded detection to the 0.75-0.95 zone.
    // In --strict mode, collisions in the 0.75-0.89 zone are errors, not warnings.
    const isStrict = this.collisionThreshold < 0.89; // --strict lowers the threshold
    const firewallThreshold = 0.75; // Collision firewall lower bound

    const overloadedCanonicals = new Set(overloadTables.keys());
    const aliasCanonicals = new Set<string>();
    for (const aliases of aliasSelectors.values()) {
      for (const a of aliases) aliasCanonicals.add(a.canonical);
    }

    for (let i = 0; i < allSelectors.length; i++) {
      for (let j = i + 1; j < allSelectors.length; j++) {
        const a = allSelectors[i];
        const b = allSelectors[j];

        // Skip collisions between overloaded or alias selectors
        if (overloadedCanonicals.has(a.canonical) || overloadedCanonicals.has(b.canonical)) {
          continue;
        }
        if (aliasCanonicals.has(a.canonical) || aliasCanonicals.has(b.canonical)) {
          continue;
        }

        const similarity = cosineSim(a.vector, b.vector);

        // 0.4.0: Collision firewall — detect in the 0.75-0.95 zone
        // (pairs at or above the duplicate threshold are reported as duplicates)
        if (similarity > firewallThreshold && similarity < this.duplicateThreshold) {
          const aPreferred = this.isPreferredTool(a.canonical, allTools, toolSelectors);
          const bPreferred = this.isPreferredTool(b.canonical, allTools, toolSelectors);

          // Determine severity: 0.89-0.95 is always a collision,
          // 0.75-0.89 is a collision-zone warning (error in --strict)
          const inCollisionZone = similarity >= this.collisionThreshold;
          const severity = inCollisionZone ? 'collision' : 'collision-zone';

          let hint: string;
          if (aPreferred && bPreferred) {
            hint = `Warning: both "${a.canonical}" and "${b.canonical}" are marked preferred — only one should be.`;
          } else if (aPreferred) {
            hint = `"${a.canonical}" is preferred (compiler hint) over "${b.canonical}" (${(similarity * 100).toFixed(1)}% similar).`;
          } else if (bPreferred) {
            hint = `"${b.canonical}" is preferred (compiler hint) over "${a.canonical}" (${(similarity * 100).toFixed(1)}% similar).`;
          } else if (severity === 'collision-zone') {
            hint = `Collision zone (${(similarity * 100).toFixed(1)}%): "${a.canonical}" and "${b.canonical}" — dispatches will trigger MEDIUM-confidence verification. Consider renaming, merging, or pinning.`;
          } else {
            hint = `Disambiguation needed: "${a.canonical}" and "${b.canonical}" are similar (${(similarity * 100).toFixed(1)}%).`;
          }

          collisions.push({
            selectorA: a.canonical,
            selectorB: b.canonical,
            similarity,
            hint,
          });
        }
      }
    }

    // Phase 2.5: COMPILE APPS — optional AppCompiler pass
    // Runs after LINK so all tool IMPs already carry their uiUri field.
    // Auto-enabled when any tools declare uiResourceUri; suppressible via compileApps: false.
    const toolsWithUI = allTools.filter(t => t.uiResourceUri);
    let appArtifact: CompilationResult['appArtifact'];

    if (this.compileApps && toolsWithUI.length > 0) {
      const appIndex = this.appVectorIndex ?? this.vectorIndex;
      const appCompiler = new AppCompiler(this.embedder, appIndex);
      const appResult = await appCompiler.compile(manifests);
      appArtifact = appResult.appArtifact;
    }

    return {
      selectors: new Map(allSelectors.map(s => [s.canonical, s])),
      dispatchTables,
      protocols: [],
      tools: toolRefs,
      toolCount: allTools.length,
      uniqueSelectorCount: allSelectors.length,
      duplicates,
      collisions,
      overloadTables,
      semanticOverloads,
      appArtifact,
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

  /** Check if a tool is marked as preferred via its compiler hint */
  private isPreferredTool(
    canonical: string,
    tools: ParsedTool[],
    selectorMap: Map<ParsedTool, ToolSelector>,
  ): boolean {
    for (const tool of tools) {
      const sel = selectorMap.get(tool);
      if (sel?.canonical === canonical && tool.compilerHints?.preferred) {
        return true;
      }
    }
    return false;
  }

  /** Create a ToolIMP (as a ToolProxy) from a parsed tool */
  private createIMP(tool: ParsedTool): ToolIMP {
    const constraints = createSchemaConstraints(
      tool.inputSchema as unknown as Record<string, unknown> | undefined,
      tool.arguments,
    );
    const proxy = new ToolProxy(
      tool.providerId,
      tool.name,
      tool.transportType,
      async (): Promise<ToolSchema> => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        arguments: tool.arguments,
      }),
      constraints,
      undefined,
      getTransport,
    );
    proxy.annotations = tool.annotations;
    return proxy;
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
  /**
   * Cosine similarity at or above which two distinct tools are reported as
   * duplicates (default 0.95). Duplicates are a compile error unless
   * `allowDuplicates` is set; tools are never merged.
   */
  duplicateThreshold?: number;
  /** @deprecated Renamed to `duplicateThreshold` (tools are no longer merged). */
  deduplicationThreshold?: number;
  /**
   * Keep near-duplicate tools and report them in `CompilationResult.duplicates`
   * instead of throwing DuplicateToolError. Default false.
   */
  allowDuplicates?: boolean;
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
  /**
   * 0.4.0 --strict mode: raises all thresholds, enables verification on every
   * dispatch, and treats ambiguity as an error instead of a warning.
   */
  strict?: boolean;
  /**
   * MCP Apps: run AppCompiler after the tool LINK phase to compile UI components.
   * Defaults to true when any tools declare uiResourceUri; set to false to skip.
   * The resulting AppArtifact is stored in CompilationResult.appArtifact.
   */
  compileApps?: boolean;
  /** VectorIndex for the AppCompiler (separate from tool vector space) */
  appVectorIndex?: VectorIndex;
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
