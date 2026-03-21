/**
 * MCP Client Registry — pre-configured MCP client transports for popular tools
 *
 * A registry of ready-to-use transport configurations for well-known MCP servers.
 * Each entry contains the default endpoint, recommended authentication method,
 * and a factory that builds a configured MCPTransport.
 *
 * Usage:
 *
 *   import { MCPClientRegistry } from './client-registry';
 *
 *   const registry = new MCPClientRegistry();
 *
 *   // Get a pre-configured Slack transport
 *   const slackTransport = registry.get('slack', {
 *     auth: { type: 'bearer', token: process.env.SLACK_BOT_TOKEN },
 *   });
 *
 *   const result = await slackTransport.execute('send_message', {
 *     channel: '#general', text: 'Hello from Smallchat!',
 *   });
 */

import { MCPTransport } from './transport.js';
import type { TransportOptions } from './transport.js';

// ---------------------------------------------------------------------------
// Registry entry types
// ---------------------------------------------------------------------------

export type AuthType = 'bearer' | 'api-key' | 'oauth2' | 'basic' | 'none';

export interface MCPClientAuth {
  type: AuthType;
  token?: string;
  apiKey?: string;
  headerName?: string;
  username?: string;
  password?: string;
}

export interface MCPClientConfig {
  endpoint?: string;
  auth?: MCPClientAuth;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface MCPClientEntry {
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Default MCP endpoint (override with config.endpoint) */
  defaultEndpoint?: string;
  /** Recommended authentication type */
  authType: AuthType;
  /** Environment variable that typically holds the API token */
  tokenEnvVar?: string;
  /** Build a transport for this client */
  createTransport(config?: MCPClientConfig): MCPTransport;
}

// ---------------------------------------------------------------------------
// MCPClientRegistry
// ---------------------------------------------------------------------------

export class MCPClientRegistry {
  private entries: Map<string, MCPClientEntry> = new Map();

  constructor() {
    this.registerBuiltins();
  }

  /** Register a custom MCP client entry */
  register(id: string, entry: MCPClientEntry): void {
    this.entries.set(id, entry);
  }

  /** Get a pre-configured transport for a registered client */
  get(id: string, config?: MCPClientConfig): MCPTransport {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new Error(
        `Unknown MCP client: "${id}". Available: ${[...this.entries.keys()].join(', ')}`,
      );
    }
    return entry.createTransport(config);
  }

  /** List all registered client IDs */
  list(): string[] {
    return [...this.entries.keys()];
  }

  /** Get metadata for a client without creating a transport */
  info(id: string): Omit<MCPClientEntry, 'createTransport'> | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const { createTransport: _factory, ...rest } = entry;
    return rest;
  }

  // ---------------------------------------------------------------------------
  // Built-in registrations
  // ---------------------------------------------------------------------------

  private registerBuiltins(): void {
    // Slack
    this.register('slack', {
      name: 'Slack',
      description: 'Send messages, read channels, and manage workspaces via Slack MCP',
      defaultEndpoint: 'https://mcp.slack.com/v1',
      authType: 'bearer',
      tokenEnvVar: 'SLACK_BOT_TOKEN',
      createTransport: (config = {}) =>
        makeTransport('https://mcp.slack.com/v1', config, 'Authorization'),
    });

    // Linear
    this.register('linear', {
      name: 'Linear',
      description: 'Manage issues, projects, and teams via Linear MCP',
      defaultEndpoint: 'https://mcp.linear.app/v1',
      authType: 'bearer',
      tokenEnvVar: 'LINEAR_API_KEY',
      createTransport: (config = {}) =>
        makeTransport('https://mcp.linear.app/v1', config, 'Authorization'),
    });

    // GitHub
    this.register('github', {
      name: 'GitHub',
      description: 'Manage repos, issues, PRs, and more via GitHub MCP',
      defaultEndpoint: 'https://api.githubcopilot.com/mcp/v1',
      authType: 'bearer',
      tokenEnvVar: 'GITHUB_TOKEN',
      createTransport: (config = {}) =>
        makeTransport('https://api.githubcopilot.com/mcp/v1', config, 'Authorization'),
    });

    // Notion
    this.register('notion', {
      name: 'Notion',
      description: 'Read and write Notion pages, databases, and blocks via Notion MCP',
      defaultEndpoint: 'https://mcp.notion.so/v1',
      authType: 'bearer',
      tokenEnvVar: 'NOTION_API_TOKEN',
      createTransport: (config = {}) =>
        makeTransport('https://mcp.notion.so/v1', config, 'Authorization'),
    });

    // Jira / Atlassian
    this.register('jira', {
      name: 'Jira (Atlassian)',
      description: 'Manage Jira issues, boards, and sprints via Atlassian MCP',
      authType: 'bearer',
      tokenEnvVar: 'ATLASSIAN_API_TOKEN',
      createTransport: (config = {}) => {
        const endpoint = config?.endpoint ?? 'https://your-domain.atlassian.net/mcp/v1';
        return makeTransport(endpoint, config, 'Authorization');
      },
    });

    // Stripe
    this.register('stripe', {
      name: 'Stripe',
      description: 'Access payments, customers, and subscriptions via Stripe MCP',
      defaultEndpoint: 'https://mcp.stripe.com/v1',
      authType: 'bearer',
      tokenEnvVar: 'STRIPE_SECRET_KEY',
      createTransport: (config = {}) =>
        makeTransport('https://mcp.stripe.com/v1', config, 'Authorization'),
    });

    // Filesystem (local MCP server)
    this.register('filesystem', {
      name: 'Filesystem',
      description: 'Read and write local files via the MCP filesystem server',
      authType: 'none',
      createTransport: (config = {}) => {
        const endpoint = config?.endpoint ?? 'http://localhost:3100';
        return new MCPTransport({ transportType: 'mcp', endpoint, headers: {} });
      },
    });

    // PostgreSQL
    this.register('postgres', {
      name: 'PostgreSQL',
      description: 'Query and manage PostgreSQL databases via MCP',
      authType: 'none',
      tokenEnvVar: 'DATABASE_URL',
      createTransport: (config = {}) => {
        const endpoint = config?.endpoint ?? 'http://localhost:3200';
        return new MCPTransport({ transportType: 'mcp', endpoint, headers: config?.headers ?? {} });
      },
    });

    // Redis
    this.register('redis', {
      name: 'Redis',
      description: 'Access Redis data via MCP',
      authType: 'none',
      tokenEnvVar: 'REDIS_URL',
      createTransport: (config = {}) => {
        const endpoint = config?.endpoint ?? 'http://localhost:3201';
        return new MCPTransport({ transportType: 'mcp', endpoint, headers: config?.headers ?? {} });
      },
    });

    // Brave Search
    this.register('brave-search', {
      name: 'Brave Search',
      description: 'Web and news search via Brave Search MCP',
      defaultEndpoint: 'https://search.brave.com/mcp/v1',
      authType: 'api-key',
      tokenEnvVar: 'BRAVE_API_KEY',
      createTransport: (config = {}) =>
        makeTransport('https://search.brave.com/mcp/v1', config, 'X-Subscription-Token'),
    });

    // Sentry
    this.register('sentry', {
      name: 'Sentry',
      description: 'Access error tracking, issues, and releases via Sentry MCP',
      defaultEndpoint: 'https://sentry.io/api/0/mcp/v1',
      authType: 'bearer',
      tokenEnvVar: 'SENTRY_AUTH_TOKEN',
      createTransport: (config = {}) =>
        makeTransport('https://sentry.io/api/0/mcp/v1', config, 'Authorization'),
    });

    // Figma
    this.register('figma', {
      name: 'Figma',
      description: 'Access design files, components, and comments via Figma MCP',
      defaultEndpoint: 'https://api.figma.com/mcp/v1',
      authType: 'bearer',
      tokenEnvVar: 'FIGMA_ACCESS_TOKEN',
      createTransport: (config = {}) =>
        makeTransport('https://api.figma.com/mcp/v1', config, 'X-Figma-Token'),
    });

    // Google Drive
    this.register('google-drive', {
      name: 'Google Drive',
      description: 'Read and search Google Drive files via MCP',
      authType: 'oauth2',
      tokenEnvVar: 'GOOGLE_ACCESS_TOKEN',
      createTransport: (config = {}) => {
        const endpoint = config?.endpoint ?? 'http://localhost:3300';
        return makeTransport(endpoint, config, 'Authorization');
      },
    });

    // AWS (local Lambda MCP proxy)
    this.register('aws', {
      name: 'AWS',
      description: 'Invoke AWS services via local MCP proxy',
      authType: 'none',
      createTransport: (config = {}) => {
        const endpoint = config?.endpoint ?? 'http://localhost:3400';
        return new MCPTransport({ transportType: 'mcp', endpoint, headers: config?.headers ?? {} });
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton registry (convenience)
// ---------------------------------------------------------------------------

export const mcpClientRegistry = new MCPClientRegistry();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTransport(
  defaultEndpoint: string,
  config: MCPClientConfig,
  tokenHeader: string,
): MCPTransport {
  const endpoint = config?.endpoint ?? defaultEndpoint;
  const headers: Record<string, string> = { ...(config?.headers ?? {}) };

  if (config?.auth) {
    const auth = config.auth;
    switch (auth.type) {
      case 'bearer':
        if (auth.token) headers[tokenHeader] = `Bearer ${auth.token}`;
        break;
      case 'api-key':
        if (auth.apiKey) headers[tokenHeader] = auth.apiKey;
        break;
      case 'basic':
        if (auth.username && auth.password) {
          const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
        break;
    }
  } else {
    // Try environment fallback
    const envToken = resolveEnvToken(defaultEndpoint);
    if (envToken) headers[tokenHeader] = `Bearer ${envToken}`;
  }

  const options: TransportOptions = { transportType: 'mcp', endpoint, headers };
  return new MCPTransport(options);
}

function resolveEnvToken(endpoint: string): string | undefined {
  // Heuristic: try common env var patterns based on hostname
  const host = new URL(endpoint).hostname;
  if (host.includes('slack')) return process.env.SLACK_BOT_TOKEN;
  if (host.includes('linear')) return process.env.LINEAR_API_KEY;
  if (host.includes('github')) return process.env.GITHUB_TOKEN;
  if (host.includes('notion')) return process.env.NOTION_API_TOKEN;
  if (host.includes('stripe')) return process.env.STRIPE_SECRET_KEY;
  if (host.includes('sentry')) return process.env.SENTRY_AUTH_TOKEN;
  if (host.includes('figma')) return process.env.FIGMA_ACCESS_TOKEN;
  if (host.includes('brave')) return process.env.BRAVE_API_KEY;
  return undefined;
}
