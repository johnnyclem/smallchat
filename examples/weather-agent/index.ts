import { loadRuntime, registerLocalHandler } from '@smallchat/core';
import type { ToolResult } from '@smallchat/core';

// Stand-in implementations for the tools declared in manifest.json
// (transportType 'local'). Replace them with calls to a weather API.
registerLocalHandler('get_current_weather', async (args): Promise<ToolResult> => ({
  content: { location: args.location, temperature: 18, units: args.units ?? 'metric', conditions: 'fog' },
}));
registerLocalHandler('get_forecast', async (args): Promise<ToolResult> => ({
  content: { location: args.location, days: Array.from({ length: Number(args.days ?? 3) }, (_, i) => ({ day: i + 1, high: 20 + i })) },
}));
registerLocalHandler('get_alerts', async (args): Promise<ToolResult> => ({
  content: [{ region: args.region, severity: args.severity ?? 'moderate', headline: 'Heat advisory' }],
}));
registerLocalHandler('search_location', async (args): Promise<ToolResult> => ({
  content: [{ name: `${args.query}, OR`, lat: 45.52, lon: -122.68 }, { name: `${args.query}, ME`, lat: 43.66, lon: -70.26 }],
}));

async function main() {
  // Compile this directory's manifest in-process with the default embedder.
  const { runtime, upstreams } = await loadRuntime(import.meta.dirname);

  const intents = [
    { intent: 'get the current weather conditions for a location', args: { location: 'San Francisco', units: 'metric' } },
    { intent: 'get active weather alerts for a region', args: { region: 'CA', severity: 'severe' } },
    { intent: 'get a multi-day weather forecast', args: { location: 'New York', days: 7 } },
    { intent: 'find a city called Portland', args: { query: 'Portland' } },
  ];

  try {
    for (const { intent, args } of intents) {
      console.log(`Intent: "${intent}"`);

      // Streaming dispatch: resolution, the tool that runs, then its output.
      // An intent that does not resolve to one tool goes straight to 'done'
      // with an isError result carrying the outcome and candidates; nothing runs.
      for await (const event of runtime.dispatchStream(intent, args)) {
        switch (event.type) {
          case 'resolving':
            process.stdout.write('  Resolving... ');
            break;
          case 'tool-start':
            console.log(`resolved to ${event.toolId} (${(event.confidence * 100).toFixed(1)}%)`);
            break;
          case 'chunk':
            console.log(`  Data: ${JSON.stringify(event.content)}`);
            break;
          case 'done':
            if (event.result.isError) {
              const { error } = event.result.content as { error?: string };
              console.log(`${String(event.result.metadata?.outcome)}: ${error}\n`);
            } else {
              console.log('  Done.\n');
            }
            break;
          case 'error':
            console.log(`error: ${event.error}\n`);
            break;
        }
      }
    }
  } finally {
    await upstreams.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
