import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ArtifactV1 } from '../../artifact/types.js';
import { describeFingerprint, parseEmbedderKind } from '../../artifact/embedder.js';
import { readArtifact } from '../../artifact/io.js';
import { loadRuntime, type LoadedRuntime } from '../../mcp/artifact.js';
import { buildToolTable } from '../../mcp/tool-names.js';
import { projectRuntimeOptions } from './project-policy.js';

/**
 * Interactive REPL for querying the smallchat runtime.
 *
 * Loads a compiled artifact and resolves each intent with runtime.resolve(),
 * the resolution `smallchat resolve`, serve and dispatch use: the outcome,
 * tier, chosen tool and candidates. Nothing is executed. Supports special
 * commands prefixed with ':'.
 */
export const replCommand = new Command('repl')
  .description('Start an interactive shell that resolves intents (never executes)')
  .argument('<file>', 'Path to the compiled toolkit file')
  .option('-e, --embedder <type>', 'Expected embedder (onnx or hash); refuses if the artifact was compiled with another')
  .option('--top-k <number>', 'Number of candidates to show', '5')
  .action(async (file, options) => {
    const filePath = resolve(file);
    const topK = parseInt(options.topK, 10);

    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      console.error('');
      console.error('Hint: Run "smallchat compile" first to generate a toolkit artifact.');
      process.exit(1);
    }

    // The artifact's embedder fingerprint decides which embedder resolves
    // intents; --embedder can only confirm it.
    let loaded: LoadedRuntime;
    try {
      if (options.embedder !== undefined) {
        const artifact = await readArtifact(filePath);
        if (parseEmbedderKind(options.embedder) !== artifact.embedder.kind) {
          throw new Error(
            `--embedder ${options.embedder} does not match ${filePath}, which was compiled with the ` +
            `${artifact.embedder.kind} embedder (${artifact.embedder.model})`,
          );
        }
      }
      // Same dispatch policy as `resolve` and `serve`: the nearest smallchat.json "policy" block.
      loaded = await loadRuntime(filePath, { runtimeOptions: projectRuntimeOptions().options });
    } catch (e) {
      console.error(`Failed to load ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }
    const { runtime, artifact: data, upstreams } = loaded;
    const names = buildToolTable(data).byToolId;

    console.log(`smallchat repl`);
    console.log(`Loaded ${data.stats.toolCount} tools (${data.stats.selectorCount} selectors) from ${data.stats.providerCount} providers`);
    console.log(`Embedder: ${describeFingerprint(data.embedder)}`);
    console.log(`Type an intent to resolve (nothing is executed), or :help for commands.\n`);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'smallchat> ',
    });

    const resolveLine = async (input: string): Promise<void> => {
      if (input.startsWith(':')) {
        handleCommand(input, data);
        return;
      }
      try {
        const resolution = await runtime.resolve(input);
        console.log(`\n  Intent:  "${input}"`);
        console.log(`  Outcome: ${resolution.outcome} (tier ${resolution.tier.toUpperCase()}, decision ${resolution.proof.decision})`);
        if (resolution.chosen) {
          const name = names.get(resolution.chosen)?.name;
          console.log(`  Chosen:  ${resolution.chosen}${name ? `  (serve name: ${name})` : ''}`);
        }
        if (resolution.reason) console.log(`  Reason:  ${resolution.reason}`);
        const candidates = resolution.proof.candidates.slice(0, topK);
        if (candidates.length === 0) {
          console.log('  Candidates: none\n');
        } else {
          console.log('  Candidates:');
          for (const c of candidates) {
            const excluded = c.excluded ? `  excluded: ${c.excluded}` : '';
            console.log(`    ${c.toolId}  score ${c.score.toFixed(3)}  ${c.tier.toUpperCase()}${excluded}`);
          }
          console.log('');
        }
      } catch (e) {
        console.error(`  Error: ${(e as Error).message}\n`);
      }
    };

    // Lines are resolved one at a time, in order; input that ends (a pipe)
    // closes the REPL only after the last line has been answered. Once the
    // interface has closed there is no prompt to show (Node 24 throws
    // ERR_USE_AFTER_CLOSE from prompt()).
    let pending = Promise.resolve();
    let closed = false;
    rl.prompt();
    rl.on('line', (line) => {
      const input = line.trim();
      pending = pending.then(async () => {
        if (input) await resolveLine(input);
        if (!closed) rl.prompt();
      });
    });

    rl.on('close', () => {
      closed = true;
      void pending.then(async () => {
        await upstreams.close();
        console.log('\nGoodbye.');
        process.exit(0);
      });
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
