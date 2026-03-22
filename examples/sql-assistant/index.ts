import { ToolRuntime, MemoryVectorIndex, LocalEmbedder, ToolCompiler } from 'smallchat';
import type { ProviderManifest } from 'smallchat';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  // Load the SQL assistant manifest
  const manifestPath = resolve(import.meta.dirname, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ProviderManifest;

  // Set up runtime
  const vectorIndex = new MemoryVectorIndex();
  const embedder = new LocalEmbedder();
  const compiler = new ToolCompiler(embedder, vectorIndex);

  console.log('Compiling SQL assistant tools...');
  const result = await compiler.compile([manifest]);
  console.log(`  ${result.toolCount} tools compiled\n`);

  const runtime = new ToolRuntime(vectorIndex, embedder);

  // Demonstrate natural language to SQL tool dispatch
  const intents = [
    { intent: 'run a database query', args: { sql: 'SELECT * FROM users WHERE active = true', limit: 10 } },
    { intent: 'show me all the tables', args: { schema: 'public' } },
    { intent: 'what columns does the users table have', args: { table: 'users' } },
    { intent: 'add a new record', args: { table: 'users', data: { name: 'Alice', email: 'alice@example.com' } } },
  ];

  for (const { intent, args } of intents) {
    console.log(`Intent: "${intent}"`);

    // Use the fluent API with content extraction
    try {
      const content = await runtime.intent(intent)
        .withArgs(args)
        .execContent();

      console.log(`  Result: ${JSON.stringify(content)}\n`);
    } catch (err) {
      console.log(`  Error: ${(err as Error).message}\n`);
    }
  }
}

main().catch(console.error);
