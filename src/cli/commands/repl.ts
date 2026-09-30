import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ArtifactV1 } from '../../artifact/types.js';
import { readArtifact } from '../../artifact/io.js';
import { createArtifactIndex, describeFingerprint, parseEmbedderKind } from '../../artifact/embedder.js';

/**
 * Interactive REPL for querying the smallchat runtime.
 *
 * Loads a compiled artifact and lets you test dispatch resolution
 * interactively. Supports special commands prefixed with ':'.
 */
export const replCommand = new Command('repl')
  .description('Start an interactive shell for querying tool resolution')
  .argument('<file>', 'Path to the compiled toolkit file')
  .option('-e, --embedder <type>', 'Expected embedder (onnx or hash); refuses if the artifact was compiled with another')
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

    // The artifact's embedder fingerprint decides which embedder resolves
    // intents; --embedder can only confirm it.
    let data: ArtifactV1;
    let index: Awaited<ReturnType<typeof createArtifactIndex>>;
    try {
      data = await readArtifact(filePath);
      if (options.embedder !== undefined && parseEmbedderKind(options.embedder) !== data.embedder.kind) {
        throw new Error(
          `--embedder ${options.embedder} does not match ${filePath}, which was compiled with the ` +
          `${data.embedder.kind} embedder (${data.embedder.model})`,
        );
      }
      index = await createArtifactIndex(data, { source: filePath });
    } catch (e) {
      console.error(`Failed to load ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }
    const { selectorTable } = index;

    console.log(`smallchat repl`);
    console.log(`Loaded ${data.stats.selectorCount} selectors from ${data.stats.providerCount} providers`);
    console.log(`Embedder: ${describeFingerprint(data.embedder)}`);
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
        const matches = await selectorTable.searchTools(selector.vector, topK, threshold);

        console.log(`\n  Intent:    "${input}"`);
        console.log(`  Selector:  ${selector.canonical}`);

        if (matches.length === 0) {
          console.log('  Matches:   none\n');
        } else {
          console.log('  Matches:');
          for (const match of matches) {
            const confidence = ((1 - match.distance) * 100).toFixed(1);
            const toolId = data.selectors[match.id]?.toolId ?? 'unknown';
            console.log(`    ${confidence.padStart(5)}%  ${match.id}  (${toolId})`);
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

function handleCommand(input: string, data: ArtifactV1): void {
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
      for (const providerId of Object.keys(data.providers)) {
        const count = Object.values(data.tools).filter(t => t.providerId === providerId).length;
        console.log(`  ${providerId}: ${count} tools`);
      }
      console.log('');
      break;

    case 'selectors':
    case 's':
      console.log('\nSelectors:');
      for (const sel of Object.values(data.selectors)) {
        console.log(`  ${sel.canonical} → ${sel.toolId}${sel.kind === 'alias' ? ' (alias)' : ''}`);
      }
      console.log('');
      break;

    case 'tools':
    case 't': {
      const filterProvider = args[0];
      console.log('\nTools:');
      for (const tool of Object.values(data.tools)) {
        if (filterProvider && tool.providerId !== filterProvider) continue;
        console.log(`  ${tool.id}`);
      }
      console.log('');
      break;
    }

    case 'stats':
      console.log('\nArtifact stats:');
      console.log(`  Format:     ${data.formatVersion}`);
      console.log(`  Hash:       ${data.contentHash}`);
      console.log(`  Embedder:   ${describeFingerprint(data.embedder)}`);
      console.log(`  Tools:      ${data.stats.toolCount}`);
      console.log(`  Selectors:  ${data.stats.selectorCount}`);
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
