import { describe, it, expect } from 'vitest';
import { ToolCompiler } from './compiler.js';
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
