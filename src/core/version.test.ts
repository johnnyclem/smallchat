/**
 * Every version smallchat reports is the package version (review: 0.5.0,
 * 1.0.0 and the package.json version disagreed across surfaces).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PACKAGE_VERSION } from './version.js';
import { packageVersion } from '../cli/package-info.js';
import { SERVER_VERSION } from '../mcp/server.js';
import { DEFAULT_CLIENT_INFO } from '../transport/mcp-connect.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string };

describe('package version', () => {
  it('is the package.json version everywhere it is reported', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(packageVersion()).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(DEFAULT_CLIENT_INFO.version).toBe(pkg.version);
  });

  it('is a 1.x release', () => {
    expect(pkg.version).toMatch(/^1\.\d+\.\d+/);
  });

  it('is what the channel server reports in serverInfo', async () => {
    const { ChannelServer } = await import('../channel/channel-server.js');
    const server = new ChannelServer({ channelName: 'versions' });
    const written: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      (server as unknown as { handleStdioLine(line: string): void }).handleStdioLine(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }));
    } finally {
      process.stdout.write = write;
      server.shutdown();
    }
    const response = written.map(l => JSON.parse(l)).find(m => m.id === 1);
    expect(response.result.serverInfo.version).toBe(pkg.version);
  });
});
