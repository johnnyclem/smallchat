import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

/**
 * `smallchat app` — subcommand group for MCP Apps Extension operations.
 *
 * Extends the main CLI with app/UI compilation and inspection commands.
 * Mirrors the existing compile/inspect/resolve pattern but operates on the
 * component dispatch space (ComponentSelector → AppIMP) rather than the
 * tool dispatch space.
 *
 * Subcommands:
 *   smallchat app compile  — compile ui:// resources from a manifest
 *   smallchat app inspect  — list compiled AppClasses and ComponentSelectors
 *   smallchat app preview  — resolve a UI intent and print the matched AppIMP
 */

// ---------------------------------------------------------------------------
// `smallchat app compile`
// ---------------------------------------------------------------------------

const appCompileCommand = new Command('compile')
  .description('Compile MCP Apps UI components from a provider manifest or .mcp.json config')
  .option('-s, --source <path>', 'Path to manifest JSON or .mcp.json config file')
  .option('-o, --output <path>', 'Output path for the compiled .app.toolkit.json artifact')
  .option('--verbose', 'Print compilation progress')
  .action(async (options) => {
    const sourcePath = resolve(options.source ?? '.mcp.json');

    if (!existsSync(sourcePath)) {
      console.error(`Source not found: ${sourcePath}`);
      process.exit(1);
    }

    console.log(`[smallchat app compile] Source: ${sourcePath}`);

    let manifests: unknown[];
    try {
      const raw = JSON.parse(readFileSync(sourcePath, 'utf-8')) as unknown;
      // Support both { providers: [...] } and bare array formats
      manifests = Array.isArray(raw) ? raw : [(raw as Record<string, unknown>)];
    } catch (err) {
      console.error(`Failed to parse ${sourcePath}: ${(err as Error).message}`);
      process.exit(1);
    }

    // Dynamically import to avoid loading heavy deps at startup
    const { LocalEmbedder } = await import('../../embedding/local-embedder.js');
    const { MemoryVectorIndex } = await import('../../embedding/memory-vector-index.js');
    const { AppCompiler } = await import('../../app/app-compiler.js');

    const embedder = new LocalEmbedder();
    const vectorIndex = new MemoryVectorIndex();
    const compiler = new AppCompiler(embedder, vectorIndex, {
      verbose: Boolean(options.verbose),
    });

    console.log('[smallchat app compile] PARSE → EMBED → LINK → OUTPUT');
    const result = await compiler.compile(manifests as Parameters<typeof compiler.compile>[0]);

    if (result.appArtifact.componentCount === 0) {
      console.log('[smallchat app compile] No UI components found (no uiResourceUri declared).');
      console.log('  Add _meta.ui.resourceUri to tool definitions to enable MCP Apps.');
      return;
    }

    // Serialize artifact to JSON
    const artifact = {
      version: '0.5.0',
      type: 'app-artifact',
      timestamp: result.appArtifact.compiledAt,
      stats: {
        componentCount: result.appArtifact.componentCount,
        providerCount: result.appArtifact.appClasses.size,
        selectorCount: result.appArtifact.componentSelectors.size,
      },
      appClasses: Object.fromEntries(result.appArtifact.appClasses),
      componentSelectors: Object.fromEntries(
        [...result.appArtifact.componentSelectors.entries()].map(
          ([k, v]) => [k, { ...v, vector: Array.from(v.vector) }],
        ),
      ),
    };

    const outputPath = options.output
      ? resolve(options.output)
      : sourcePath.replace(/\.json$/, '.app.toolkit.json');

    writeFileSync(outputPath, JSON.stringify(artifact, null, 2), 'utf-8');

    console.log(`\n[smallchat app compile] Done.`);
    console.log(`  Components: ${result.appArtifact.componentCount}`);
    console.log(`  Providers:  ${result.appArtifact.appClasses.size}`);
    console.log(`  Selectors:  ${result.appArtifact.componentSelectors.size}`);
    console.log(`  Output:     ${outputPath}`);
  });

// ---------------------------------------------------------------------------
// `smallchat app inspect`
// ---------------------------------------------------------------------------

const appInspectCommand = new Command('inspect')
  .description('Inspect a compiled .app.toolkit.json artifact')
  .argument('<file>', 'Path to the compiled app artifact file')
  .option('--selectors', 'List all ComponentSelectors')
  .option('--components', 'List all compiled UI components with their uri:// URIs')
  .action((file, options) => {
    const filePath = resolve(file);

    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const stats = data.stats as Record<string, number>;

    console.log(`App artifact: ${basename(filePath)}`);
    console.log(`Version:     ${data.version}`);
    console.log(`Compiled:    ${data.timestamp}`);
    console.log(`Components:  ${stats.componentCount}`);
    console.log(`Providers:   ${stats.providerCount}`);
    console.log(`Selectors:   ${stats.selectorCount}`);

    if (options.selectors) {
      const selectors = data.componentSelectors as Record<string, { canonical: string; arity: number }>;
      console.log('\nComponentSelectors:');
      for (const [canonical, sel] of Object.entries(selectors)) {
        console.log(`  ${canonical}  (arity: ${sel.arity})`);
      }
    }

    if (options.components || (!options.selectors)) {
      const classes = data.appClasses as Record<string, {
        name: string;
        componentDispatchTable: Record<string, { toolName: string; componentUri: string; capabilities: string[] }>;
      }>;
      console.log('\nAppClasses:');
      for (const [providerId, cls] of Object.entries(classes)) {
        console.log(`  ${cls.name} (provider: ${providerId})`);
        for (const [canonical, imp] of Object.entries(cls.componentDispatchTable)) {
          console.log(`    [${canonical}]`);
          console.log(`      Tool:         ${imp.toolName}`);
          console.log(`      URI:          ${imp.componentUri}`);
          console.log(`      Capabilities: ${imp.capabilities.join(', ')}`);
        }
      }
    }
  });

// ---------------------------------------------------------------------------
// `smallchat app preview`
// ---------------------------------------------------------------------------

const appPreviewCommand = new Command('preview')
  .description('Resolve a UI intent against a compiled artifact and print the matched AppIMP')
  .argument('<file>', 'Path to the compiled .app.toolkit.json artifact')
  .argument('<intent>', 'Natural language UI intent to resolve')
  .action(async (file, intent) => {
    const filePath = resolve(file);

    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }

    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;

    const { UIRuntime } = await import('../../app/app-runtime.js');
    const { LocalEmbedder } = await import('../../embedding/local-embedder.js');
    const { MemoryVectorIndex } = await import('../../embedding/memory-vector-index.js');

    const embedder = new LocalEmbedder();
    const vectorIndex = new MemoryVectorIndex();
    const runtime = new UIRuntime(embedder, vectorIndex);

    // Rehydrate the artifact from JSON and load it into the runtime
    const appClasses = new Map(Object.entries(raw.appClasses as Record<string, unknown>));
    const componentSelectors = new Map(
      Object.entries(raw.componentSelectors as Record<string, unknown>).map(([k, v]) => {
        const sel = v as { canonical: string; parts: string[]; arity: number; vector: number[] };
        return [k, { ...sel, vector: Array.from(sel.vector) }];
      }),
    );

    const artifact = {
      appClasses,
      componentSelectors,
      componentCount: (raw.stats as Record<string, number>).componentCount,
      compiledAt: raw.timestamp as string,
    } as unknown as import('../../core/types.js').AppArtifact;

    runtime.loadArtifact(artifact);

    console.log(`[smallchat app preview] Resolving: "${intent}"`);
    const imp = await runtime.ui_dispatch(intent);

    if (!imp) {
      console.log('\nResult: No matching UI component found (graceful degradation).');
      console.log('  The tool will respond with a text result instead of an interactive view.');
    } else {
      console.log('\nResult: Component resolved.');
      console.log(`  Provider:     ${imp.providerId}`);
      console.log(`  Tool:         ${imp.toolName}`);
      console.log(`  URI:          ${imp.componentUri}`);
      console.log(`  Capabilities: ${imp.capabilities.join(', ')}`);
      console.log(`  Visibility:   ${imp.visibility.join(', ')}`);
      console.log(`  Display mode: ${imp.preferredDisplayMode ?? 'inline'}`);
    }
  });

// ---------------------------------------------------------------------------
// `smallchat app` — parent command
// ---------------------------------------------------------------------------

export const appCommand = new Command('app')
  .description('MCP Apps Extension: compile and inspect interactive UI components for MCP tools')
  .addHelpText('after', `
What are MCP Apps?
──────────────────
MCP Apps (spec io.modelcontextprotocol/ui, 2026-01-26) lets MCP tools declare
interactive HTML views rendered inline in Claude, ChatGPT, VS Code, and other
compliant hosts. Views communicate bidirectionally with tools via PostMessageTransport.

Analogy: AppCompiler is to UI what ToolCompiler is to tools.
  ToolCompiler:  manifest → selector table → dispatch table → ToolIMP
  AppCompiler:   manifest → ComponentSelector → AppClass → AppIMP (ui:// URI)

Examples:
  $ smallchat app compile --source .mcp.json
  $ smallchat app inspect .mcp.app.toolkit.json --components
  $ smallchat app preview .mcp.app.toolkit.json "show me a bar chart"
`);

appCommand.addCommand(appCompileCommand);
appCommand.addCommand(appInspectCommand);
appCommand.addCommand(appPreviewCommand);
