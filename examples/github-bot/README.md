# GitHub Bot Example

A GitHub bot (with stand-in tools) that uses smallchat to dispatch intents like "create issue",
"list pull requests", and "search code".

## Run

From the repository root (Node 22+):

```bash
npm install && npm run build
node --experimental-strip-types examples/github-bot/index.ts   # Node 24: plain `node`
```

The tools are compiled from `manifest.json` in-process with the default
(ONNX) embedder, as `smallchat serve --source examples/github-bot` would.

## Tools

- **create_issue** — Create a GitHub issue in a repository
- **list_pull_requests** — List open pull requests
- **search_code** — Search code across repositories
- **get_repo_info** — Get repository metadata

## How It Works

The tools are `local` stand-ins registered in `index.ts` (they return canned
data); swap in real GitHub API calls, or point the manifest at a GitHub MCP
server, to act on a real repository.

For each intent the bot calls `runtime.resolve()`, which proposes one tool
and runs nothing. A resolved (HIGH or EXACT) intent then runs by exact id
with `dispatchById`. Below HIGH, with no LLM verifier configured, the
outcome is `needs-disambiguation`: a host shows the options and the user
picks one; `resolveRefinement()` runs the pick and remembers it for that
intent. An intent nothing matches is `unresolved`, and nothing runs.
