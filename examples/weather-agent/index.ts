import { ToolRuntime, MemoryVectorIndex, LocalEmbedder, ToolCompiler } from 'smallchat';
import type { ProviderManifest } from 'smallchat';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  // Load the weather manifest
  const manifestPath = resolve(import.meta.dirname, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ProviderManifest;

  // Set up runtime
  const vectorIndex = new MemoryVectorIndex();
  const embedder = new LocalEmbedder();
  const compiler = new ToolCompiler(embedder, vectorIndex);

  console.log('Compiling weather agent tools...');
  const result = await compiler.compile([manifest]);
  console.log(`  ${result.toolCount} tools compiled\n`);

  const runtime = new ToolRuntime(vectorIndex, embedder);

  // Demonstrate streaming dispatch
  const intents = [
    { intent: 'what is the weather right now', args: { location: 'San Francisco', units: 'metric' } },
    { intent: 'forecast for the next week', args: { location: 'New York', days: 7 } },
    { intent: 'any severe weather alerts', args: { region: 'CA', severity: 'severe' } },
    { intent: 'find a city called Portland', args: { query: 'Portland' } },
  ];

  for (const { intent, args } of intents) {
    console.log(`Intent: "${intent}"`);

    // Use streaming dispatch for real-time feedback
    for await (const event of runtime.dispatchStream(intent, args)) {
      switch (event.type) {
        case 'resolving':
          process.stdout.write('  Resolving... ');
          break;
        case 'tool-start':
          console.log(`resolved to ${event.toolName} (${(event.confidence * 100).toFixed(1)}%)`);
          break;
        case 'chunk':
          console.log(`  Data: ${JSON.stringify(event.content)}`);
          break;
        case 'done':
          console.log('  Done.\n');
          break;
        case 'error':
          console.log(`  Error: ${event.error}\n`);
          break;
      }
    }
  }
}

main().catch(console.error);
