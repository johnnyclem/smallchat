import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Embedder, VectorIndex } from '../../core/types.js';
import { LocalEmbedder } from '../../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';
import { SelectorTable } from '../../core/selector-table.js';

/**
 * Interactive REPL for querying the smallchat runtime.
 *
 * Loads a compiled artifact and lets you test dispatch resolution
 * interactively. Supports special commands prefixed with ':'.
 */
export const replCommand = new Command('repl')
  .description('Start an interactive shell for querying tool resolution')
  .argument('<file>', 'Path to the compiled toolkit file')
  .option('-e, --embedder <type>', 'Embedder to use: onnx or local', 'local')
  .option('--top-k <number>', 'Number of results to show', '5')
  .option('--threshold <number>', 'Minimum similarity threshold', '0.5')
  .action(async (file, options) => {
    const filePath = resolve(file);
    const topK = parseInt(options.topK, 10);
    const threshold = parseFloat(options.threshold);

    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      console.error('');
      console.error('Hint: Run "smallchat compile" first to generate a toolkit artifact.');
      process.exit(1);
    }

    let data: ToolkitArtifact;
    try {
      const content = readFileSync(filePath, 'utf-8');
      data = JSON.parse(content) as ToolkitArtifact;
    } catch (e) {
      console.error(`Failed to read ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }

    // Set up embedder and vector index
    let embedder: Embedder;
    let vectorIndex: VectorIndex;

    if (options.embedder === 'onnx') {
      try {
        const { ONNXEmbedder } = await import('../../embedding/onnx-embedder.js');
        const { SqliteVectorIndex } = await import('../../embedding/sqlite-vector-index.js');
        embedder = new ONNXEmbedder();
        vectorIndex = new SqliteVectorIndex(':memory:');
      } catch {
        console.warn('ONNX embedder unavailable, falling back to local embedder.');
        embedder = new LocalEmbedder();
        vectorIndex = new MemoryVectorIndex();
      }
    } else {
      embedder = new LocalEmbedder();
      vectorIndex = new MemoryVectorIndex();
    }

    const selectorTable = new SelectorTable(vectorIndex, embedder);

    // Load selectors from the artifact
    for (const [, sel] of Object.entries(data.selectors)) {
      const s = sel as { canonical: string; vector: number[] };
      const vector = new Float32Array(s.vector);
      await selectorTable.intern(vector, s.canonical);
    }

    const selectorCount = Object.keys(data.selectors).length;
    const providerCount = Object.keys(data.dispatchTables).length;

    console.log(`smallchat repl v0.1.0`);
    console.log(`Loaded ${selectorCount} selectors from ${providerCount} providers`);
    console.log(`Type an intent to resolve, or :help for commands.\n`);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'smallchat> ',
    });

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();

      if (!input) {
        rl.prompt();
        return;
      }

      // Handle special commands
      if (input.startsWith(':')) {
        handleCommand(input, data);
        rl.prompt();
        return;
      }

      // Resolve intent
      try {
        const selector = await selectorTable.resolve(input);
        const matches = await vectorIndex.search(selector.vector, topK, threshold);

        console.log(`\n  Intent:    "${input}"`);
        console.log(`  Selector:  ${selector.canonical}`);

        if (matches.length === 0) {
          console.log('  Matches:   none\n');
        } else {
          console.log('  Matches:');
          for (const match of matches) {
            const confidence = ((1 - match.distance) * 100).toFixed(1);
            const provider = findProvider(match.id, data);
            console.log(`    ${confidence.padStart(5)}%  ${match.id}  (${provider})`);
          }
          console.log('');
        }
      } catch (e) {
        console.error(`  Error: ${(e as Error).message}\n`);
      }

      rl.prompt();
    });

    rl.on('close', () => {
      console.log('\nGoodbye.');
      process.exit(0);
    });
  });

function handleCommand(input: string, data: ToolkitArtifact): void {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd) {
    case 'help':
    case 'h':
      console.log('\nCommands:');
      console.log('  :help, :h         Show this help');
      console.log('  :providers, :p    List all providers');
      console.log('  :selectors, :s    List all selectors');
      console.log('  :tools [provider] List tools (optionally filtered by provider)');
      console.log('  :stats            Show artifact stats');
      console.log('  :quit, :q         Exit the REPL');
      console.log('');
      console.log('Type any natural language intent to resolve it against the toolkit.\n');
      break;

    case 'providers':
    case 'p':
      console.log('\nProviders:');
      for (const [providerId, table] of Object.entries(data.dispatchTables)) {
        const count = Object.keys(table as Record<string, unknown>).length;
        console.log(`  ${providerId}: ${count} tools`);
      }
      console.log('');
      break;

    case 'selectors':
    case 's':
      console.log('\nSelectors:');
      for (const [, sel] of Object.entries(data.selectors)) {
        const s = sel as { canonical: string; arity: number };
        console.log(`  ${s.canonical} (arity: ${s.arity})`);
      }
      console.log('');
      break;

    case 'tools':
    case 't': {
      const filterProvider = args[0];
      console.log('\nTools:');
      for (const [providerId, table] of Object.entries(data.dispatchTables)) {
        if (filterProvider && providerId !== filterProvider) continue;
        const methods = table as Record<string, { toolName: string }>;
        for (const [, tool] of Object.entries(methods)) {
          console.log(`  ${providerId}/${tool.toolName}`);
        }
      }
      console.log('');
      break;
    }

    case 'stats':
      console.log('\nArtifact stats:');
      console.log(`  Version:    ${data.version}`);
      console.log(`  Compiled:   ${data.timestamp}`);
      console.log(`  Tools:      ${data.stats.toolCount}`);
      console.log(`  Selectors:  ${data.stats.uniqueSelectorCount}`);
      console.log(`  Providers:  ${data.stats.providerCount}`);
      console.log(`  Collisions: ${data.stats.collisionCount}`);
      console.log('');
      break;

    case 'quit':
    case 'q':
      console.log('Goodbye.');
      process.exit(0);
      break;

    default:
      console.log(`Unknown command: :${cmd}. Type :help for available commands.\n`);
  }
}

function findProvider(selectorId: string, data: ToolkitArtifact): string {
  for (const [providerId, table] of Object.entries(data.dispatchTables)) {
    const methods = table as Record<string, unknown>;
    if (selectorId in methods) {
      return providerId;
    }
  }
  return 'unknown';
}

interface ToolkitArtifact {
  version: string;
  timestamp: string;
  stats: {
    toolCount: number;
    uniqueSelectorCount: number;
    mergedCount: number;
    providerCount: number;
    collisionCount: number;
  };
  selectors: Record<string, unknown>;
  dispatchTables: Record<string, unknown>;
}
