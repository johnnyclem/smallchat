import { ToolRuntime, MemoryVectorIndex, LocalEmbedder, ToolCompiler } from 'smallchat';
import type { ProviderManifest } from 'smallchat';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  // Load the GitHub bot manifest
  const manifestPath = resolve(import.meta.dirname, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ProviderManifest;

  // Create runtime
  const vectorIndex = new MemoryVectorIndex();
  const embedder = new LocalEmbedder();
  const compiler = new ToolCompiler(embedder, vectorIndex);

  console.log('Compiling GitHub bot tools...');
  const result = await compiler.compile([manifest]);
  console.log(`  ${result.toolCount} tools compiled\n`);

  // Create the runtime
  const runtime = new ToolRuntime(vectorIndex, embedder);

  // Demonstrate intent dispatch
  const intents = [
    { intent: 'create a new issue', args: { owner: 'acme', repo: 'app', title: 'Bug: login broken' } },
    { intent: 'show me open PRs', args: { owner: 'acme', repo: 'app' } },
    { intent: 'search for authentication code', args: { query: 'oauth login', language: 'typescript' } },
    { intent: 'get repository information', args: { owner: 'acme', repo: 'app' } },
  ];

  for (const { intent, args } of intents) {
    console.log(`Intent: "${intent}"`);

    // Use the fluent API
    const result = await runtime.intent(intent)
      .withArgs(args)
      .withTimeout(5000)
      .exec();

    console.log(`  Result: ${JSON.stringify(result.content)}\n`);
  }
}

main().catch(console.error);
