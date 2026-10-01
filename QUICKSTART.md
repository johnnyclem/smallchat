# Quickstart: Hello World in 5 Minutes

Get from zero to dispatching your first tool intent in under 5 minutes.

## 1. Create a New Project

```bash
npx -y @smallchat/core init my-app
cd my-app
```

`init` runs `npm install` (and `git init`) for you. It scaffolds:
- `manifests/my-app-manifest.json`, declaring two `local` tools, `greet` and `echo`
- `src/tools.ts` (their implementations) and `src/index.ts` (the entry point)
- `smallchat.json`, the project manifest `smallchat compile` reads

## 2. Compile Your Tools

```bash
npm run compile
```

This runs `smallchat compile --source ./manifests`: it embeds each tool with
the default ONNX embedder (bundled; no download) and writes
`tools.toolkit.json`, an artifact pinned to that embedder.

## 3. Test Resolution

```bash
npx -y @smallchat/core resolve tools.toolkit.json "echo back a message"
```

```
Intent: "echo back a message"
Outcome: resolved (tier HIGH, decision ranked)
Chosen: my-app/echo  (serve name: my-app__echo)

Candidates:
  my-app/echo  score 0.946  HIGH  via vector
```

`resolve` only proposes; nothing runs. Try a vaguer intent:

```bash
npx -y @smallchat/core resolve tools.toolkit.json "greet someone"
```

```
Outcome: needs-disambiguation (tier LOW, decision needs-llm-verifier)
Reason: my-app/greet scored 0.725 (low); below HIGH a tool runs only after an LLM verifier approves it
```

Below HIGH confidence (0.85), a tool runs on its own only when an LLM
verifier approves it; otherwise the caller picks a tool by id. An intent
that matches nothing is `unresolved`. `npx -y @smallchat/core explain
tools.toolkit.json "greet someone"` shows the full candidate table and
the policy verdict for each tool.

## 4. Use the SDK

Edit `src/index.ts`, then run `npm run build && npm start`:

```typescript
import { DispatchError, loadRuntime, registerLocalHandler } from '@smallchat/core';
import { echo, greet } from './tools.js';

// The sample tools are 'local': register their implementations.
registerLocalHandler('greet', greet);
registerLocalHandler('echo', echo);

async function main() {
  // Uses the embedder recorded in the artifact (ONNX by default)
  const { runtime, upstreams } = await loadRuntime('tools.toolkit.json');
  try {
    // Resolution proposes one tool and runs nothing...
    const resolution = await runtime.resolve('greet a user by name with a custom greeting');

    // ...then exactly that tool runs, with arguments checked against its schema.
    if (resolution.chosen) {
      const result = await runtime.dispatchById(resolution.chosen, { name: 'World', greeting: 'Hey' });
      console.log(result.content); // Hey, World! Welcome to smallchat.
    }

    // Fluent API: runs a HIGH/EXACT match, throws DispatchError otherwise.
    const echoed = await runtime
      .intent<{ message: string }>('echo back a message')
      .withArgs({ message: 'Hello, smallchat' })
      .execContent<string>();
    console.log(echoed); // Hello, smallchat

    // Below HIGH (with no LLM verifier configured) nothing runs on its own.
    try {
      await runtime.intent('greet someone').withArgs({ name: 'Developer' }).execContent();
    } catch (err) {
      if (!(err instanceof DispatchError)) throw err;
      console.log(err.outcome, err.candidates); // needs-disambiguation [ 'my-app/greet' ]
    }
  } finally {
    // Closes upstream MCP connections (none here, but MCP tools would keep the process alive)
    await upstreams.close();
  }
}

main();
```

The scaffold's own `src/index.ts` does the first half of this, compiling
`./manifests` in-process (`loadRuntime('./manifests')`) instead of reading
the artifact; both work.

## 5. Explore Interactively

```bash
npx -y @smallchat/core repl tools.toolkit.json
```

Type natural language intents and see how each resolves: the same outcome,
tier, chosen tool and candidates `resolve` prints (nothing runs). Try:
- `echo back a message` (resolved, HIGH)
- `greet a user` (needs-disambiguation: below HIGH, nothing would run on its own)
- `:tools` to list all available tools
- `:help` for more commands

## Next Steps

- **Add more tools**: Create manifest JSON files in `manifests/`
- **Use streaming**: `for await (const event of runtime.dispatchStream('intent')) { ... }`
- **Serve these tools over MCP**: `local` tools run only inside your own process, so serve them from it: the `mcp-server` template below does that over stdio. `npx -y @smallchat/core serve --source <artifact>` is for *upstream* MCP servers (manifests with an `mcp` transport and a launch spec, e.g. from `smallchat setup`): it forwards each call, by exact name, to the server that owns the tool, and cannot run this project's `local` tools.
- **Generate docs**: `npx -y @smallchat/core docs tools.toolkit.json`
- **Check health**: `npx -y @smallchat/core doctor`

## Templates

`smallchat init` supports three templates:

| Template | Use Case | Entry point |
|----------|----------|-------------|
| `basic` | Resolve an intent, then run the chosen tool by id (default) | `src/index.ts` |
| `mcp-server` | Serve the sample tools to an MCP host over stdio | `src/server.ts` |
| `agent` | A loop that streams each request to its tool, and reports what it did not run | `src/agent.ts` |

```bash
npx -y @smallchat/core init my-server --template mcp-server
npx -y @smallchat/core init my-agent --template agent
```

Every template declares `greet` and `echo` in `manifests/`, implements
them in `src/tools.ts` and registers them with `registerLocalHandler`
before it loads the tools. `init` runs `git init` (unless the directory is
already in a repository) and `npm install`; skip them with `--no-git` /
`--no-install`. Then `npm run compile` compiles `manifests/`. For `basic`
and `agent`, `npm run build && npm start` runs the entry point; for
`mcp-server`, run `npm run build` and point your MCP host at
`node dist/server.js` (its tools are `<project>__greet` and
`<project>__echo`).

## Example Projects

Check the `examples/` directory for runnable examples (stand-in tool
implementations; run from the repository root after `npm run build`, see
each README). A test runs them against the source tree on every CI run.

- **[GitHub Bot](./examples/github-bot/)** — resolve, run by id, and handle needs-disambiguation
- **[Weather Agent](./examples/weather-agent/)** — streaming dispatch
- **[SQL Assistant](./examples/sql-assistant/)** — the fluent API and `DispatchError`
