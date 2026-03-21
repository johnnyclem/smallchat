/**
 * Registry — generic paginated store for MCP tools, resources, and prompts.
 *
 * Cursor format: base64url(JSON.stringify({ v: snapshotVersion, o: offset }))
 * Snapshot: monotonic integer version string, bumped on every register/deregister.
 */

import type { McpTool, McpResource, McpPrompt } from './types.js';
import { MCP_ERROR } from './types.js';

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
  snapshot: string;
}

export interface CursorError {
  code: number;
  message: string;
  data: { snapshotExpected: string; action: string };
}

export class Registry<T extends { id: string }> {
  private items = new Map<string, T>();
  private version = 0;
  private listeners: Array<() => void> = [];

  register(item: T): void {
    this.items.set(item.id, item);
    this.version++;
    this.fire();
  }

  deregister(id: string): void {
    if (this.items.delete(id)) {
      this.version++;
      this.fire();
    }
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  list(cursor?: string, limit = 50): ListResult<T> {
    const clampedLimit = Math.max(1, Math.min(200, limit));
    const snapshot = String(this.version);
    const allItems = Array.from(this.items.values());

    let offset = 0;

    if (cursor !== undefined && cursor !== '') {
      const decoded = decodeCursor(cursor);
      if (!decoded || decoded.v !== this.version) {
        const err: CursorError = {
          code: MCP_ERROR.INVALID_CURSOR,
          message: 'Invalid cursor',
          data: { snapshotExpected: snapshot, action: 'relist' },
        };
        throw err;
      }
      offset = decoded.o;
    }

    const page = allItems.slice(offset, offset + clampedLimit);
    const nextOffset = offset + clampedLimit;
    const nextCursor =
      nextOffset < allItems.length
        ? encodeCursor(this.version, nextOffset)
        : null;

    return { items: page, nextCursor, snapshot };
  }

  snapshot(): string {
    return String(this.version);
  }

  size(): number {
    return this.items.size;
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  private fire(): void {
    for (const cb of this.listeners) cb();
  }
}

// ---------------------------------------------------------------------------
// Typed registries
// ---------------------------------------------------------------------------

export class ToolRegistry extends Registry<McpTool> {}
export class ResourceRegistry extends Registry<McpResource> {}
export class PromptRegistry extends Registry<McpPrompt> {}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  v: number;
  o: number;
}

function encodeCursor(version: number, offset: number): string {
  const json = JSON.stringify({ v: version, o: offset } satisfies CursorPayload);
  return Buffer.from(json).toString('base64url');
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'v' in parsed &&
      'o' in parsed &&
      typeof (parsed as CursorPayload).v === 'number' &&
      typeof (parsed as CursorPayload).o === 'number'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}
