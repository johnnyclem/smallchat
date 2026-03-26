# Quickstart: Hello World in 5 Minutes

Get from zero to dispatching your first tool intent in under 5 minutes.

## 1. Create a New Project

```bash
npx @smallchat/core init my-app
cd my-app
npm install
```

This scaffolds a project with:
- A sample manifest with `greet` and `echo` tools
- A TypeScript entry point
- A `smallchat.config.json` configuration file

## 2. Compile Your Tools

```bash
npx @smallchat/core compile --source ./manifests
```

This reads your manifest files, generates embedding vectors for each tool, and produces a `tools.toolkit.json` artifact.

## 3. Test Resolution

```bash
npx @smallchat/core resolve tools.toolkit.json "say hello to someone"
```

You should see the intent resolve to the `greet` tool with high confidence.

## 4. Use the SDK

Edit `src/index.ts`:

```typescript
import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from '@smallchat/core';

async function main() {
  const runtime = new ToolRuntime(
    new MemoryVectorIndex(),
    new LocalEmbedder(),
  );

  // Simple dispatch
  const result = await runtime.dispatch('greet someone', { name: 'World' });
  console.log(result.content);

  // Fluent API with TypeScript inference
  const greeting = await runtime
    .intent<{ name: string; greeting?: string }>('say hello')
    .withArgs({ name: 'Developer', greeting: 'Hey' })
    .execContent<string>();
  console.log(greeting);
}

main();
```

## 5. Explore Interactively

```bash
npx @smallchat/core repl tools.toolkit.json
```

Type natural language intents and see which tools they resolve to. Try:
- `greet a user`
- `echo back a message`
- `:tools` to list all available tools
- `:help` for more commands

## Next Steps

- **Add more tools**: Create manifest JSON files in `manifests/`
- **Use streaming**: `for await (const event of runtime.dispatchStream('intent')) { ... }`
- **Start an MCP server**: `npx @smallchat/core serve --source ./manifests`
- **Generate docs**: `npx @smallchat/core docs tools.toolkit.json`
- **Check health**: `npx @smallchat/core doctor`

## Templates

`smallchat init` supports three templates:

| Template | Use Case |
|----------|----------|
| `basic` | Simple tool dispatch (default) |
| `mcp-server` | MCP 2026 compliant server |
| `agent` | Streaming agent with dispatch loop |

```bash
npx @smallchat/core init my-server --template mcp-server
npx @smallchat/core init my-agent --template agent
```

## Example Projects

Check the `examples/` directory for complete working examples:

- **[GitHub Bot](./examples/github-bot/)** — Dispatch GitHub API intents
- **[Weather Agent](./examples/weather-agent/)** — Streaming weather lookups
- **[SQL Assistant](./examples/sql-assistant/)** — Natural language to database tools
