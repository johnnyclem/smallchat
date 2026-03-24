import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Embedder, TransportType, VectorIndex } from '../../core/types.js';
import { LocalEmbedder } from '../../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../../embedding/memory-vector-index.js';
import { ONNXEmbedder } from '../../embedding/onnx-embedder.js';
import { SqliteVectorIndex } from '../../embedding/sqlite-vector-index.js';
import { SelectorTable } from '../../core/selector-table.js';
import { HttpTransport } from '../../transport/http-transport.js';
import { LocalTransport } from '../../transport/local-transport.js';
import { McpSseTransport } from '../../transport/mcp-client-transport.js';
import type { ITransport, TransportOutput } from '../../transport/types.js';

export const resolveCommand = new Command('resolve')
  .description('Test dispatch resolution against a compiled artifact')
  .argument('<file>', 'Path to the compiled toolkit file')
  .argument('<intent>', 'Natural language intent to resolve')
  .option('-e, --embedder <type>', 'Embedder to use: onnx (default) or local', 'onnx')
  .option('-x, --execute', 'Execute the resolved tool via its transport')
  .option('--args <json>', 'JSON arguments to pass when executing', '{}')
  .option('--endpoint <url>', 'Override the tool endpoint for execution')
  .option('--timeout <ms>', 'Execution timeout in milliseconds', '30000')
  .action(async (file, intent, options) => {
    const filePath = resolve(file);

    let data: ToolkitArtifact;
    try {
      const content = readFileSync(filePath, 'utf-8');
      data = JSON.parse(content) as ToolkitArtifact;
    } catch (e) {
      console.error(`Failed to read ${filePath}: ${(e as Error).message}`);
      process.exit(1);
    }

    // Detect embedder type from artifact or CLI flag
    const embedderType = data.embedding?.embedderType ?? options.embedder;

    // Rebuild the selector table and vector index from the artifact
    let embedder: Embedder;
    let vectorIndex: VectorIndex;

    if (embedderType === 'onnx') {
      try {
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

    // Resolve the intent
    const selector = await selectorTable.resolve(intent);

    // Find nearest selectors
    const matches = await vectorIndex.search(selector.vector, 5, 0.5);

    console.log(`Intent: "${intent}"`);
    console.log(`Resolved selector: ${selector.canonical}`);
    console.log('');

    if (matches.length === 0) {
      console.log('No matches found.');
      return;
    }

    console.log('Matches:');
    for (const match of matches) {
      const confidence = ((1 - match.distance) * 100).toFixed(1);
      // Look up which provider owns this selector
      let provider = 'unknown';
      for (const [providerId, table] of Object.entries(data.dispatchTables)) {
        const methods = table as Record<string, { toolName: string }>;
        if (match.id in methods) {
          provider = providerId;
          break;
        }
      }
      console.log(`  → ${match.id} (confidence: ${confidence}%, provider: ${provider})`);
    }

    // Show the best match
    const best = matches[0];
    const bestConfidence = ((1 - best.distance) * 100).toFixed(1);
    if (parseFloat(bestConfidence) > 90) {
      console.log(`\n✓ Unambiguous: ${best.id} (${bestConfidence}%)`);
    } else if (matches.length > 1) {
      console.log(`\n? Ambiguous: top match is ${best.id} (${bestConfidence}%). Disambiguation may be needed.`);
    }

    // --execute: run the resolved tool via its transport
    if (options.execute && matches.length > 0) {
      const bestMatch = matches[0];
      let toolName = bestMatch.id;
      let providerId = 'unknown';
      let transportType: TransportType = 'rest';
      let endpoint: string | undefined = options.endpoint;

      // Look up the tool info from the dispatch table
      for (const [pid, table] of Object.entries(data.dispatchTables)) {
        const methods = table as Record<string, { toolName: string; transportType?: TransportType; endpoint?: string }>;
        if (bestMatch.id in methods) {
          providerId = pid;
          toolName = methods[bestMatch.id].toolName ?? bestMatch.id;
          transportType = methods[bestMatch.id].transportType ?? 'rest';
          endpoint = endpoint ?? methods[bestMatch.id].endpoint;
          break;
        }
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(options.args) as Record<string, unknown>;
      } catch {
        console.error('Failed to parse --args as JSON');
        process.exit(1);
      }

      console.log(`\nExecuting: ${toolName} (provider: ${providerId}, transport: ${transportType})`);
      if (Object.keys(args).length > 0) {
        console.log(`Arguments: ${JSON.stringify(args, null, 2)}`);
      }

      // Create the appropriate transport
      let transport: ITransport;
      const timeoutMs = parseInt(options.timeout, 10);

      switch (transportType) {
        case 'rest':
          transport = new HttpTransport({
            baseUrl: endpoint ?? 'http://localhost:3000',
            timeoutMs,
          });
          break;
        case 'mcp':
          transport = new McpSseTransport({
            url: endpoint ?? 'http://localhost:3000',
          });
          break;
        case 'local':
          transport = new LocalTransport();
          break;
        default:
          console.error(`Transport type "${transportType}" not supported for execution`);
          process.exit(1);
      }

      try {
        const result: TransportOutput = await transport.execute({
          toolName,
          args,
          timeoutMs,
        });

        console.log(`\nResult (isError: ${result.isError}):`);
        console.log(JSON.stringify(result.content, null, 2));

        if (result.metadata) {
          console.log(`\nMetadata:`);
          console.log(JSON.stringify(result.metadata, null, 2));
        }
      } catch (err) {
        console.error(`\nExecution failed: ${(err as Error).message}`);
        process.exit(1);
      } finally {
        await transport.dispose?.();
      }
    }
  });

interface ToolkitArtifact {
  selectors: Record<string, unknown>;
  dispatchTables: Record<string, unknown>;
  embedding?: {
    model: string;
    dimensions: number;
    embedderType: string;
  };
}
