/**
 * Parse a Claude Code config.json and extract MCP server definitions.
 *
 * Claude Code config format:
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
 *       "env": { ... },
 *       "url": "http://..."              // streamable-http transport
 *     }
 *   }
 * }
 */

import { readFileSync, writeFileSync } from 'node:fs';

export interface MCPServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
}

export interface ClaudeCodeConfig {
  mcpServers?: Record<string, MCPServerEntry>;
  [key: string]: unknown;
}

/**
 * Read and parse a Claude Code config.json.
 */
export function parseConfig(configPath: string): ClaudeCodeConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as ClaudeCodeConfig;
  return config;
}

/**
 * Extract all MCP server entries from the config.
 */
export function extractMCPServers(
  config: ClaudeCodeConfig,
): Record<string, MCPServerEntry> {
  return config.mcpServers ?? {};
}

/**
 * Write a modified config.json that replaces all mcpServers with a single
 * smallchat MCP server entry pointing at the given URL.
 */
export function writeSmallchatConfig(
  originalConfig: ClaudeCodeConfig,
  smallchatUrl: string,
  outputPath: string,
): void {
  const modified: ClaudeCodeConfig = {
    ...originalConfig,
    mcpServers: {
      smallchat: {
        url: smallchatUrl,
        type: 'streamable-http',
      },
    },
  };
  writeFileSync(outputPath, JSON.stringify(modified, null, 2));
}

/**
 * Derive a provider ID from an MCP server name.
 * Strips common suffixes and normalizes.
 */
export function serverNameToProviderId(name: string): string {
  return name
    .replace(/-server$/i, '')
    .replace(/-mcp$/i, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase();
}
