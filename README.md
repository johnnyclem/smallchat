# smallchat

> Object-oriented inference. A tool compiler for the age of agents.

[smallchat.dev](https://smallchat.dev)

---

Your agent has 50 tools. The LLM sees all 50 in its context window every single turn, burning tokens and degrading selection accuracy. You write routing logic, maintain tool registries, and pray the model picks the right one.

**smallchat compiles your tools into a dispatch table.** The LLM expresses intent. The runtime resolves it — semantically, deterministically, in microseconds. No prompt stuffing. No selection lottery.

```bash
npx smallchat compile --source ~/.mcp.json
```

One command. Point it at your MCP config, a directory of manifests, or any MCP server repo. Out comes a compiled artifact with embedded vectors, dispatch tables, and resolution caching — ready to serve.

## Install

```bash
npm install @smallchat/core
```

Requires Node.js >= 20.

## See It Work

```bash
# Compile tools from your MCP servers
npx smallchat compile --source ~/.mcp.json

# Ask it a question — see which tool it picks and why
npx smallchat resolve tools.toolkit.json "search for code"

# Start an MCP-compatible server
npx smallchat serve --source ./manifests --port 3001
```

## Use It in Code

```typescript
import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from 'smallchat';

const runtime = new ToolRuntime(
  new MemoryVectorIndex(),
  new LocalEmbedder(),
);

const result = await runtime.dispatch('find flights', { to: 'NYC' });

// Or stream token-by-token
for await (const token of runtime.inferenceStream('find flights', { to: 'NYC' })) {
  process.stdout.write(token);
}
```

## How It Works

smallchat borrows its architecture from the Smalltalk/Objective-C runtime. Tools are objects. Intents are messages. Dispatch is semantic.

The LLM says *what* it wants. The runtime figures out *which tool* handles it — using vector similarity, resolution caching, superclass traversal, and fallback chains. No routing code. No tool selection prompts.

See the [Architecture doc](./ARCHITECTURE.md) for the full design and the [Reference](./docs/REFERENCE.md) for runtime details, dispatch mechanics, and the concept mapping from Smalltalk/Obj-C to smallchat.

## CLI

| Command | Description |
|---------|-------------|
| `compile` | Compile manifests into a dispatch artifact |
| `serve` | Start an MCP-compatible server |
| `resolve` | Test intent-to-tool resolution |
| `inspect` | Examine a compiled artifact |
| `doctor` | Check your environment |

## Documentation

| Doc | What's inside |
|-----|---------------|
| [Quickstart](./QUICKSTART.md) | Zero to dispatching in 5 minutes |
| [Architecture](./ARCHITECTURE.md) | Full design document |
| [Reference](./docs/REFERENCE.md) | Runtime, dispatch, streaming, MCP server, CLI details |
| [Concept Mapping](./docs/REFERENCE.md#concept-mapping) | Smalltalk/Obj-C → smallchat translation table |
| [Changelog](./CHANGELOG.md) | Release history |

## Development

```bash
npm test          # 274 specs
npm run dev       # Watch mode
npm run lint      # Type check
```

## License

MIT
