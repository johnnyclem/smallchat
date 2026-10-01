import { loadRuntime, registerLocalHandler } from '@smallchat/core';
import type { ToolResult } from '@smallchat/core';

// Stand-in implementations for the tools declared in manifest.json
// (transportType 'local'). Replace them with real GitHub API calls, or point
// the manifest at a GitHub MCP server, to act on a real repository.
registerLocalHandler('create_issue', async (args): Promise<ToolResult> => ({
  content: { number: 42, title: args.title, url: `https://github.com/${args.owner}/${args.repo}/issues/42` },
}));
registerLocalHandler('list_pull_requests', async (args): Promise<ToolResult> => ({
  content: [{ number: 7, title: 'Fix memory leak in dispatcher', repo: `${args.owner}/${args.repo}` }],
}));
registerLocalHandler('search_code', async (args): Promise<ToolResult> => ({
  content: [{ path: 'src/auth/oauth.ts', match: String(args.query) }],
}));
registerLocalHandler('get_repo_info', async (args): Promise<ToolResult> => ({
  content: { fullName: `${args.owner}/${args.repo}`, defaultBranch: 'main', stars: 1280 },
}));

async function main() {
  // Compile this directory's manifest in-process with the default embedder,
  // as `smallchat serve --source <dir>` does.
  const { runtime, upstreams } = await loadRuntime(import.meta.dirname);

  const intents = [
    { intent: 'list the open pull requests for a repository', args: { owner: 'acme', repo: 'app' } },
    { intent: 'search code across repositories', args: { query: 'oauth login', language: 'typescript' } },
    { intent: 'create a new issue in a repository', args: { owner: 'acme', repo: 'app', title: 'Bug: login broken' } },
    { intent: 'show me open PRs', args: { owner: 'acme', repo: 'app' } },
  ];

  try {
    for (const { intent, args } of intents) {
      console.log(`Intent: "${intent}"`);

      // Resolution proposes one tool and runs nothing...
      const resolution = await runtime.resolve(intent, { args });

      if (resolution.outcome === 'resolved') {
        // ...then exactly that tool runs, its arguments checked against its schema.
        const result = await runtime.dispatchById(resolution.chosen!, args, { resolutionDigest: resolution.proof.proofDigest });
        console.log(`  ran ${resolution.chosen} (${resolution.tier}) → ${JSON.stringify(result.content)}\n`);
      } else if (resolution.outcome === 'needs-disambiguation' && resolution.refinement) {
        // Below HIGH confidence (with no LLM verifier) the runtime asks instead
        // of guessing. A host shows the options; here the first one is "picked".
        // resolveRefinement runs it by id and remembers the choice, so this
        // exact intent resolves directly next time.
        const choice = resolution.refinement.options[0];
        console.log(`  ${resolution.outcome} (${resolution.tier}): options ${resolution.refinement.options.map(o => o.toolId).join(', ')}`);
        const result = await runtime.resolveRefinement(intent, choice, args);
        console.log(`  picked ${choice.toolId} → ${JSON.stringify(result.content)}\n`);
      } else {
        console.log(`  ${resolution.outcome}: ${resolution.reason}. Nothing ran.\n`);
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
