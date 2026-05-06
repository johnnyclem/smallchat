import type {
  AppIMP,
  AppArtifact,
  AppCompilerHint,
  ComponentSelector,
  Embedder,
  ProviderManifest,
  SerializedAppClass,
  SerializedAppIMP,
  SerializedComponentSelector,
  VectorIndex,
} from '../core/types.js';
import { AppClass } from './app-class.js';
import { ComponentSelectorTable, canonicalizeComponent } from './component-selector.js';

export interface AppCompilerOptions {
  /** Cosine similarity threshold for ComponentSelector deduplication (default 0.95) */
  deduplicationThreshold?: number;
  /** Log compilation progress to console */
  verbose?: boolean;
}

export interface AppCompilationResult {
  /** AppClass per provider — mirrors CompilationResult.dispatchTables */
  appClasses: Map<string, AppClass>;
  /** ComponentSelector table */
  componentSelectors: Map<string, ComponentSelector>;
  /** Serializable artifact */
  appArtifact: AppArtifact;
}

/**
 * AppCompiler — the build-time compiler for MCP Apps UI components.
 *
 * Mirrors ToolCompiler in src/compiler/compiler.ts with the same
 * four-phase pipeline — PARSE → EMBED → LINK → OUTPUT — but operates
 * on tools that declare a uiResourceUri rather than on tool logic.
 *
 * Obj-C analogy: ToolCompiler = clang front-end; AppCompiler = Interface
 * Builder compiler that turns NIB/XIB source into serialized object graphs
 * (NSNib bundles) ready for runtime instantiation.
 *
 * Pipeline:
 *   PARSE  — extract ToolDefinitions with uiResourceUri
 *   EMBED  — ComponentSelectorTable.intern(description + capability tags)
 *   LINK   — build AppClass.componentDispatchTable per provider
 *   OUTPUT — AppArtifact (JSON-serializable; embedded in CompilationResult)
 */
export class AppCompiler {
  private embedder: Embedder;
  private componentSelectorTable: ComponentSelectorTable;
  private verbose: boolean;

  constructor(
    embedder: Embedder,
    vectorIndex: VectorIndex,
    options?: AppCompilerOptions,
  ) {
    this.embedder = embedder;
    this.verbose = options?.verbose ?? false;
    this.componentSelectorTable = new ComponentSelectorTable(
      vectorIndex,
      embedder,
      options?.deduplicationThreshold ?? 0.95,
    );
  }

  /**
   * Compile UI components from provider manifests.
   *
   * Only processes tools that have uiResourceUri set. Tools without a UI
   * resource are silently skipped — compilation is additive, not replacing.
   */
  async compile(manifests: ProviderManifest[]): Promise<AppCompilationResult> {
    // Phase 1: PARSE — collect tools that declare a ui:// resource
    interface ParsedComponent {
      providerId: string;
      toolName: string;
      description: string;
      componentUri: string;
      visibility: Array<'model' | 'app'>;
      capabilities: string[];
      hints?: AppCompilerHint;
    }

    const components: ParsedComponent[] = [];

    for (const manifest of manifests) {
      for (const tool of manifest.tools) {
        if (!tool.uiResourceUri) continue;

        // Derive capability tags from tool name and description heuristically.
        // In a full implementation the server would declare these explicitly;
        // here we extract keywords from the description as capability hints.
        const capabilities = extractCapabilityTags(tool.name, tool.description);

        components.push({
          providerId: manifest.id,
          toolName: tool.name,
          description: tool.description,
          componentUri: tool.uiResourceUri,
          visibility: (tool.uiVisibility as Array<'model' | 'app'>) ?? ['model', 'app'],
          capabilities,
        });

        if (this.verbose) {
          console.log(`  [AppCompiler] PARSE: ${manifest.id}.${tool.name} → ${tool.uiResourceUri}`);
        }
      }
    }

    if (components.length === 0) {
      return emptyResult();
    }

    // Phase 2: EMBED — create ComponentSelectors for each component
    const componentSelectors: Map<ParsedComponent, ComponentSelector> = new Map();

    for (const comp of components) {
      const embeddingText = `${comp.toolName}: ${comp.description} [${comp.capabilities.join(' ')}]`;
      const embedding = await this.embedder.embed(embeddingText);
      const canonical = canonicalizeComponent(`${comp.providerId} ${comp.toolName}`);
      const selector = await this.componentSelectorTable.intern(embedding, canonical);
      componentSelectors.set(comp, selector);

      if (this.verbose) {
        console.log(`  [AppCompiler] EMBED: ${comp.toolName} → ${selector.canonical}`);
      }
    }

    // Phase 3: LINK — build one AppClass per provider
    const appClasses: Map<string, AppClass> = new Map();

    for (const comp of components) {
      const selector = componentSelectors.get(comp)!;

      // Build AppIMP for this component
      const imp: AppIMP = buildAppIMP(comp);

      // Get or create AppClass for this provider
      let appClass = appClasses.get(comp.providerId);
      if (!appClass) {
        appClass = new AppClass(`${comp.providerId}AppClass`, comp.providerId);
        appClasses.set(comp.providerId, appClass);
      }

      appClass.addComponent(selector, imp);

      if (this.verbose) {
        console.log(`  [AppCompiler] LINK: ${comp.providerId}AppClass.${selector.canonical}`);
      }
    }

    // Phase 4: OUTPUT — serialize to AppArtifact
    const artifact = serializeArtifact(appClasses, this.componentSelectorTable);

    const allSelectors = new Map<string, ComponentSelector>();
    for (const sel of this.componentSelectorTable.all()) {
      allSelectors.set(sel.canonical, sel);
    }

    return { appClasses, componentSelectors: allSelectors, appArtifact: artifact };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAppIMP(comp: {
  providerId: string;
  toolName: string;
  componentUri: string;
  capabilities: string[];
  visibility: Array<'model' | 'app'>;
}): AppIMP {
  const capabilities = [...comp.capabilities];
  return {
    providerId: comp.providerId,
    toolName: comp.toolName,
    componentUri: comp.componentUri,
    mimeType: 'text/html;profile=mcp-app',
    capabilities,
    visibility: comp.visibility,
    supportsCapability(cap: string): boolean {
      return capabilities.includes(cap);
    },
  };
}

/** Extract semantic capability tags from tool name and description */
function extractCapabilityTags(name: string, description: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const tags: string[] = [];

  const capabilityMap: Array<[RegExp, string]> = [
    [/chart|graph|plot|histogram|scatter|bar|line|pie/, 'chart'],
    [/map|geo|location|coordinates|latitude|longitude/, 'map'],
    [/table|grid|spreadsheet|rows|columns/, 'table'],
    [/form|input|field|submit|checkbox|dropdown/, 'form'],
    [/dashboard|metric|kpi|monitor|stat/, 'dashboard'],
    [/video|stream|player|media/, 'video'],
    [/image|photo|picture|gallery/, 'image'],
    [/document|pdf|markdown|text/, 'document'],
    [/3d|three|webgl|shader|scene/, '3d'],
    [/real.?time|live|streaming|update/, 'realtime'],
    [/interactive|click|drag|resize/, 'interactive'],
    [/budget|finance|money|cost/, 'finance'],
  ];

  for (const [pattern, tag] of capabilityMap) {
    if (pattern.test(text)) tags.push(tag);
  }

  // Always mark as interactive if none more specific matched
  if (tags.length === 0) tags.push('interactive');

  return [...new Set(tags)];
}

function serializeArtifact(
  appClasses: Map<string, AppClass>,
  selectorTable: ComponentSelectorTable,
): AppArtifact {
  const serializedClasses: Map<string, SerializedAppClass> = new Map();

  for (const [providerId, appClass] of appClasses) {
    const componentDispatchTable: Record<string, SerializedAppIMP> = {};
    for (const [canonical, imp] of appClass.componentDispatchTable) {
      componentDispatchTable[canonical] = {
        providerId: imp.providerId,
        toolName: imp.toolName,
        componentUri: imp.componentUri,
        capabilities: imp.capabilities,
        visibility: imp.visibility,
        csp: imp.csp,
        preferredDisplayMode: imp.preferredDisplayMode,
      };
    }

    serializedClasses.set(providerId, {
      providerId,
      name: appClass.name,
      componentDispatchTable,
      superclassName: appClass.superclass?.name,
      protocolNames: appClass.protocols.map(p => p.name),
    });
  }

  const serializedSelectors: Map<string, SerializedComponentSelector> = new Map();
  for (const sel of selectorTable.all()) {
    serializedSelectors.set(sel.canonical, {
      canonical: sel.canonical,
      parts: sel.parts,
      arity: sel.arity,
      vector: Array.from(sel.vector),
    });
  }

  return {
    appClasses: serializedClasses,
    componentSelectors: serializedSelectors,
    componentCount: [...appClasses.values()].reduce(
      (n, cls) => n + cls.componentDispatchTable.size, 0,
    ),
    compiledAt: new Date().toISOString(),
  };
}

function emptyResult(): AppCompilationResult {
  return {
    appClasses: new Map(),
    componentSelectors: new Map(),
    appArtifact: {
      appClasses: new Map(),
      componentSelectors: new Map(),
      componentCount: 0,
      compiledAt: new Date().toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// AppArtifact deserialization — reconstitute AppClass objects at runtime
// ---------------------------------------------------------------------------

export function deserializeAppArtifact(artifact: AppArtifact): {
  appClasses: Map<string, AppClass>;
  componentSelectors: Map<string, ComponentSelector>;
} {
  const appClasses = new Map<string, AppClass>();
  const componentSelectors = new Map<string, ComponentSelector>();

  // Rebuild ComponentSelectors
  for (const [canonical, raw] of artifact.componentSelectors) {
    componentSelectors.set(canonical, {
      canonical: raw.canonical,
      parts: raw.parts,
      arity: raw.arity,
      vector: new Float32Array(raw.vector),
    });
  }

  // Rebuild AppClasses
  for (const [providerId, raw] of artifact.appClasses) {
    const appClass = new AppClass(raw.name, raw.providerId);

    for (const [canonical, rawImp] of Object.entries(raw.componentDispatchTable)) {
      const capabilities = rawImp.capabilities;
      const imp: AppIMP = {
        providerId: rawImp.providerId,
        toolName: rawImp.toolName,
        componentUri: rawImp.componentUri,
        mimeType: 'text/html;profile=mcp-app',
        capabilities,
        visibility: rawImp.visibility as Array<'model' | 'app'>,
        csp: rawImp.csp,
        preferredDisplayMode: rawImp.preferredDisplayMode as AppIMP['preferredDisplayMode'],
        supportsCapability(cap: string): boolean {
          return capabilities.includes(cap);
        },
      };

      const sel = componentSelectors.get(canonical);
      if (sel) appClass.addComponent(sel, imp);
    }

    appClasses.set(providerId, appClass);
  }

  return { appClasses, componentSelectors };
}
