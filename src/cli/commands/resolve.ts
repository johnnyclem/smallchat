import { Command } from 'commander';
import { resolve } from 'node:path';
import type { TransportType } from '../../core/types.js';
import type { ArtifactV1 } from '../../artifact/types.js';
import { readArtifact } from '../../artifact/io.js';
import { createArtifactIndex, parseEmbedderKind } from '../../artifact/embedder.js';
import { HttpTransport } from '../../transport/http-transport.js';
import { LocalTransport } from '../../transport/local-transport.js';
import { McpSseTransport } from '../../transport/mcp-client-transport.js';
import type { ITransport, TransportOutput } from '../../transport/types.js';

export const resolveCommand = new Command('resolve')
  .description('Test dispatch resolution against a compiled artifact')
  .argument('<file>', 'Path to the compiled toolkit file')
  .argument('<intent>', 'Natural language intent to resolve')
  .option('-e, --embedder <type>', 'Expected embedder (onnx or hash); refuses if the artifact was compiled with another')
  .option('-x, --execute', 'Execute the resolved tool via its transport')
  .option('--args <json>', 'JSON arguments to pass when executing', '{}')
  .option('--endpoint <url>', 'Override the tool endpoint for execution')
  .option('--timeout <ms>', 'Execution timeout in milliseconds', '30000')
  .action(async (file, intent, options) => {
    const filePath = resolve(file);

    // Load the artifact and the embedder it was compiled with — the
    // artifact's fingerprint decides; --embedder can only confirm it.
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

    // Resolve the intent
    const selector = await selectorTable.resolve(intent);

    // Find nearest tool selectors (never the intent itself)
    const matches = await selectorTable.searchTools(selector.vector, 5, 0.5);

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
      const toolId = data.selectors[match.id]?.toolId ?? 'unknown';
      console.log(`  → ${match.id} (confidence: ${confidence}%, tool: ${toolId})`);
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
      const tool = data.tools[data.selectors[bestMatch.id].toolId];
      const toolName = tool.name;
      const providerId = tool.providerId;
      const transportType: TransportType = tool.transportType;
      const launch = data.providers[providerId]?.launch;
      const endpoint: string | undefined =
        options.endpoint ?? (launch && launch.transport !== 'stdio' ? launch.url : undefined);

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
