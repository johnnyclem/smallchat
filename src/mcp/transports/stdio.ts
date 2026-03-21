/**
 * STDIO transport for MCPServer.
 *
 * Reads newline-delimited JSON-RPC requests from stdin.
 * Writes newline-delimited JSON-RPC responses to stdout.
 * Notifications (no id) produce no output.
 */

import { createInterface } from 'node:readline';
import type { McpRouter } from '../router.js';

export function startStdioTransport(router: McpRouter): void {
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const errResponse = JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      process.stdout.write(errResponse + '\n');
      return;
    }

    // No session context in STDIO mode (single-client)
    void router.handle(parsed, null).then((response) => {
      if (response !== null) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    });
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
