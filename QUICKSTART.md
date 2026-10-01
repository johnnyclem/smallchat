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
import { loadRuntime } from '@smallchat/core';

async function main() {
  // Uses the embedder recorded in the artifact (ONNX by default)
  const { runtime } = await loadRuntime('tools.toolkit.json');

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
- **Serve your tools as one MCP server**: `npx @smallchat/core serve --source tools.toolkit.json` (stdio; add `--http` for Streamable HTTP at `127.0.0.1:3001/mcp` with a bearer token)
- **Generate docs**: `npx @smallchat/core docs tools.toolkit.json`
- **Check health**: `npx @smallchat/core doctor`

## Templates

`smallchat init` supports three templates:

| Template | Use Case |
|----------|----------|
| `basic` | Simple tool dispatch (default) |
| `mcp-server` | An MCP server (stdio) for your manifests |
| `agent` | Streaming agent with dispatch loop |

```bash
npx -y @smallchat/core init my-server --template mcp-server
npx -y @smallchat/core init my-agent --template agent
```

`init` runs `git init` (unless the directory is already in a repository)
and `npm install`; skip them with `--no-git` / `--no-install`. Then
`npm run compile` compiles `manifests/`, and for the basic template
`npm run build && npm start` resolves an intent against the sample
manifest and runs the chosen tool.

## Example Projects

Check the `examples/` directory for complete working examples:

- **[GitHub Bot](./examples/github-bot/)** — Dispatch GitHub API intents
- **[Weather Agent](./examples/weather-agent/)** — Streaming weather lookups
- **[SQL Assistant](./examples/sql-assistant/)** — Natural language to database tools
