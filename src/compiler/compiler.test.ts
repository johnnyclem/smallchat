import { describe, it, expect, vi } from 'vitest';
import { ToolCompiler, DuplicateToolError, SelectorConflictError } from './compiler.js';
import { LocalEmbedder } from '../embedding/local-embedder.js';
import { MemoryVectorIndex } from '../embedding/memory-vector-index.js';
import type { ProviderManifest } from '../core/types.js';

function createCompiler() {
  const embedder = new LocalEmbedder(64);
  const vectorIndex = new MemoryVectorIndex();
  return new ToolCompiler(embedder, vectorIndex);
}

const githubManifest: ProviderManifest = {
  id: 'github',
  name: 'GitHub',
  transportType: 'mcp',
  tools: [
    {
      name: 'search_code',
      description: 'Search for code across repositories',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          language: { type: 'string', description: 'Programming language filter' },
        },
        required: ['query'],
      },
      providerId: 'github',
      transportType: 'mcp',
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a repository',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Issue title' },
          body: { type: 'string', description: 'Issue body' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['title', 'repo'],
      },
      providerId: 'github',
      transportType: 'mcp',
    },
  ],
};

const slackManifest: ProviderManifest = {
  id: 'slack',
  name: 'Slack',
  transportType: 'mcp',
  tools: [
    {
      name: 'search_messages',
      description: 'Search for messages in Slack channels',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          channel: { type: 'string', description: 'Channel to search in' },
        },
        required: ['query'],
      },
      providerId: 'slack',
      transportType: 'mcp',
    },
  ],
};

describe('ToolCompiler', () => {
  it('compiles a single manifest', async () => {
    const compiler = createCompiler();
    const result = await compiler.compile([githubManifest]);

    expect(result.toolCount).toBe(2);
    expect(result.dispatchTables.size).toBe(1);
    expect(result.dispatchTables.has('github')).toBe(true);
  });

  it('compiles multiple manifests', async () => {
    const compiler = createCompiler();
    const result = await compiler.compile([githubManifest, slackManifest]);

    expect(result.toolCount).toBe(3);
    expect(result.dispatchTables.size).toBe(2);
  });

  it('builds ToolClass instances from compilation result', async () => {
    const compiler = createCompiler();
    const result = await compiler.compile([githubManifest]);
    const classes = compiler.buildClasses(result);

    expect(classes).toHaveLength(1);
    expect(classes[0].name).toBe('github');
    expect(classes[0].allSelectors()).toHaveLength(2);
  });

  it('generates selectors for each tool', async () => {
    const compiler = createCompiler();
    const result = await compiler.compile([githubManifest]);

    expect(result.selectors.size).toBeGreaterThanOrEqual(2);

    // Check that selectors have the expected canonical form
    const canonicals = Array.from(result.selectors.keys());
    expect(canonicals).toContain('github.search_code');
    expect(canonicals).toContain('github.create_issue');
  });

  it('creates ToolProxy IMPs with constraints', async () => {
    const compiler = createCompiler();
    const result = await compiler.compile([githubManifest]);
    const table = result.dispatchTables.get('github')!;

    const searchImp = table.get('github.search_code')!;
    expect(searchImp.providerId).toBe('github');
    expect(searchImp.toolName).toBe('search_code');

    // Should have required constraint for 'query'
    expect(searchImp.constraints.required).toHaveLength(1);
    expect(searchImp.constraints.required[0].name).toBe('query');
  });
});

// ---------------------------------------------------------------------------
// SC-INF-08: the compiler must never merge distinct tools
// ---------------------------------------------------------------------------

function tool(providerId: string, name: string, description: string, extra: Partial<ProviderManifest['tools'][number]> = {}) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    providerId,
    transportType: 'mcp' as const,
    ...extra,
  };
}

// "list_issues" and "list-issues" normalize to the same text, so the hash
// embedder gives them cosine 1.0 — well above the 0.95 duplicate threshold.
const nearDuplicateManifest: ProviderManifest = {
  id: 'github',
  name: 'GitHub',
  transportType: 'mcp',
  tools: [
    tool('github', 'list_issues', 'List issues in a repository'),
    tool('github', 'list-issues', 'List issues in a repository'),
    tool('github', 'remove_repo', 'Delete a repository permanently'),
    tool('github', 'remove-repo', 'Delete a repository permanently', {
      compilerHints: { pinSelector: 'github.delete_repo_PINNED' },
    }),
  ],
};

describe('ToolCompiler — duplicate tools (SC-INF-08)', () => {
  it('rejects near-duplicate tools with a compile error that lists each pair', async () => {
    const compiler = createCompiler();
    await expect(compiler.compile([nearDuplicateManifest])).rejects.toThrow(DuplicateToolError);
    await expect(createCompiler().compile([nearDuplicateManifest])).rejects.toThrow(
      /github\/list_issues.*github\/list-issues/s,
    );
  });

  it('keeps every tool under allowDuplicates and reports the pairs instead', async () => {
    const compiler = new ToolCompiler(new LocalEmbedder(64), new MemoryVectorIndex(), { allowDuplicates: true });
    const result = await compiler.compile([nearDuplicateManifest]);

    const toolNames = [...result.dispatchTables.get('github')!.values()].map(imp => imp.toolName).sort();
    expect(toolNames).toEqual(['list-issues', 'list_issues', 'remove-repo', 'remove_repo']);
    expect(result.toolCount).toBe(4);
    expect(result.uniqueSelectorCount).toBe(4);
    expect(result.duplicates.map(d => [d.toolA, d.toolB])).toEqual([
      ['github/list_issues', 'github/list-issues'],
      ['github/remove_repo', 'github/remove-repo'],
    ]);
  });

  it('honors pinSelector literally, even when the embedding matches another tool', async () => {
    const compiler = new ToolCompiler(new LocalEmbedder(64), new MemoryVectorIndex(), { allowDuplicates: true });
    const result = await compiler.compile([nearDuplicateManifest]);
    const table = result.dispatchTables.get('github')!;

    expect(table.get('github.delete_repo_PINNED')?.toolName).toBe('remove-repo');
    expect(table.get('github.remove_repo')?.toolName).toBe('remove_repo');
    expect(result.selectors.has('github.delete_repo_PINNED')).toBe(true);
  });

  it('rejects two tools that claim the same selector', async () => {
    const compiler = createCompiler();
    const manifest: ProviderManifest = {
      id: 'fs',
      name: 'FS',
      transportType: 'mcp',
      tools: [
        tool('fs', 'read_file', 'Read a file from disk'),
        tool('fs', 'fetch_url', 'Fetch a URL over HTTP', { compilerHints: { pinSelector: 'fs.read_file' } }),
      ],
    };
    await expect(compiler.compile([manifest])).rejects.toThrow(SelectorConflictError);
  });

  it('rejects an alias phrase declared by two tools, naming the phrase and both tools', async () => {
    const manifest: ProviderManifest = {
      id: 'rtk',
      name: 'RTK',
      transportType: 'mcp',
      tools: [
        tool('rtk', 'rtk_cargo_test', 'Run cargo tests', { compilerHints: { aliases: ['run tests'] } }),
        tool('rtk', 'rtk_npm_test', 'Run npm tests', { compilerHints: { aliases: ['Run  Tests'] } }),
      ],
    };
    for (const options of [{}, { allowDuplicates: true }]) {
      const compiler = new ToolCompiler(new LocalEmbedder(64), new MemoryVectorIndex(), options);
      const error = await compiler.compile([manifest]).catch(e => e);
      expect(error).toBeInstanceOf(SelectorConflictError);
      expect(error.message).toBe(
        'Alias "Run  Tests" of rtk/rtk_npm_test is also an alias of rtk/rtk_cargo_test ("run tests"). ' +
        'An alias phrase can belong to only one tool; remove it from one of them.',
      );
    }
  });

  it('never reports a merge count for distinct tools', async () => {
    const compiler = createCompiler();
    const result = await compiler.compile([githubManifest, slackManifest]);
    expect(result.duplicates).toEqual([]);
    expect(result.uniqueSelectorCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SC-INF-22: smallchat.json "compiler" options reach the compiler
// ---------------------------------------------------------------------------

describe('ToolCompiler — smallchat.json compiler options (SC-INF-22)', () => {
  const project = (compiler: Record<string, unknown>) => ({ name: 'p', version: '1.0.0', compiler });

  it('applies allowDuplicates and duplicateThreshold from the project manifest', async () => {
    const result = await createCompiler().compile([nearDuplicateManifest], project({ allowDuplicates: true }));
    expect(result.duplicates).toHaveLength(2);

    const raised = await createCompiler().compile([nearDuplicateManifest], project({ duplicateThreshold: 1.01 }));
    expect(raised.duplicates).toEqual([]);
  });

  it('applies generateSemanticOverloads from the project manifest', async () => {
    // Same text, different argument types: an overload group, not a duplicate.
    const overloadable: ProviderManifest = {
      id: 'svc',
      name: 'Svc',
      transportType: 'mcp',
      tools: [
        tool('svc', 'find_record', 'Find a record', { inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }),
        tool('svc', 'find-record', 'Find a record', { inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } }),
      ],
    };
    await expect(createCompiler().compile([overloadable], project({}))).rejects.toThrow(DuplicateToolError);
    const result = await createCompiler().compile([overloadable], project({ generateSemanticOverloads: true }));
    expect(result.semanticOverloads).toHaveLength(1);
  });

  it('explicit constructor options win over the project manifest', async () => {
    const compiler = new ToolCompiler(new LocalEmbedder(64), new MemoryVectorIndex(), { allowDuplicates: false });
    await expect(compiler.compile([nearDuplicateManifest], project({ allowDuplicates: true }))).rejects.toThrow(DuplicateToolError);
  });

  it('warns about the removed "priority" hint instead of silently ignoring it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const manifest: ProviderManifest = {
        id: 'svc',
        name: 'Svc',
        transportType: 'mcp',
        tools: [tool('svc', 'ping', 'Ping the service', { compilerHints: { priority: 2 } as never })],
      };
      await createCompiler().compile([manifest]);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/Ignored compiler hint "priority" \(svc\.ping\)/);
    } finally {
      warn.mockRestore();
    }
  });
});
