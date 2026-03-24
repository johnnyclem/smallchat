/**
 * Feature: Registry — Paginated Store
 *
 * Generic paginated store for MCP tools, resources, and prompts with
 * cursor-based pagination and snapshot versioning.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Registry, ToolRegistry, ResourceRegistry, PromptRegistry } from './registry.js';
import { MCP_ERROR } from './types.js';

interface TestItem {
  id: string;
  name: string;
}

describe('Feature: Generic Registry', () => {
  let registry: Registry<TestItem>;

  beforeEach(() => {
    registry = new Registry<TestItem>();
  });

  describe('Scenario: Register and retrieve an item', () => {
    it('Given an item, When register is called, Then the item can be retrieved by id', () => {
      registry.register({ id: 'item-1', name: 'First' });

      const item = registry.get('item-1');
      expect(item).toEqual({ id: 'item-1', name: 'First' });
    });
  });

  describe('Scenario: Deregister an item', () => {
    it('Given a registered item, When deregister is called, Then the item is no longer available', () => {
      registry.register({ id: 'item-1', name: 'First' });
      registry.deregister('item-1');

      expect(registry.get('item-1')).toBeUndefined();
      expect(registry.size()).toBe(0);
    });
  });

  describe('Scenario: Deregister a non-existent item is a no-op', () => {
    it('Given no items, When deregister is called, Then no error is thrown and version stays the same', () => {
      const snapshot1 = registry.snapshot();
      registry.deregister('nonexistent');
      expect(registry.snapshot()).toBe(snapshot1);
    });
  });

  describe('Scenario: Version increments on register and deregister', () => {
    it('Given a registry, When items are registered/deregistered, Then the snapshot version increments', () => {
      expect(registry.snapshot()).toBe('0');

      registry.register({ id: 'a', name: 'A' });
      expect(registry.snapshot()).toBe('1');

      registry.register({ id: 'b', name: 'B' });
      expect(registry.snapshot()).toBe('2');

      registry.deregister('a');
      expect(registry.snapshot()).toBe('3');
    });
  });

  describe('Scenario: List items without cursor', () => {
    it('Given 3 items, When list is called without cursor, Then all items are returned', () => {
      registry.register({ id: '1', name: 'One' });
      registry.register({ id: '2', name: 'Two' });
      registry.register({ id: '3', name: 'Three' });

      const result = registry.list();

      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).toBeNull();
      expect(result.snapshot).toBe('3');
    });
  });

  describe('Scenario: Paginated listing with cursor', () => {
    it('Given 5 items with limit 2, When listing pages, Then cursor-based pagination works', () => {
      for (let i = 1; i <= 5; i++) {
        registry.register({ id: `${i}`, name: `Item ${i}` });
      }

      // Page 1
      const page1 = registry.list(undefined, 2);
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      // Page 2
      const page2 = registry.list(page1.nextCursor!, 2);
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).not.toBeNull();

      // Page 3 (last)
      const page3 = registry.list(page2.nextCursor!, 2);
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeNull();
    });
  });

  describe('Scenario: Invalid cursor throws error', () => {
    it('Given a malformed cursor, When list is called, Then an INVALID_CURSOR error is thrown', () => {
      registry.register({ id: '1', name: 'One' });

      expect(() => registry.list('garbage-cursor')).toThrow();

      try {
        registry.list('garbage-cursor');
      } catch (err: unknown) {
        const e = err as { code: number; message: string };
        expect(e.code).toBe(MCP_ERROR.INVALID_CURSOR);
      }
    });
  });

  describe('Scenario: Stale cursor (version mismatch) throws error', () => {
    it('Given a valid cursor from version N, When items change and the cursor is reused, Then an error is thrown', () => {
      for (let i = 1; i <= 5; i++) {
        registry.register({ id: `${i}`, name: `Item ${i}` });
      }

      const page1 = registry.list(undefined, 2);

      // Mutate the registry
      registry.register({ id: '6', name: 'Six' });

      // Now the cursor is stale
      expect(() => registry.list(page1.nextCursor!)).toThrow();
    });
  });

  describe('Scenario: Limit is clamped between 1 and 200', () => {
    it('Given a limit of 0, When list is called, Then at least 1 item is returned', () => {
      registry.register({ id: '1', name: 'One' });
      const result = registry.list(undefined, 0);
      expect(result.items).toHaveLength(1);
    });

    it('Given a limit of 999, When list is called, Then at most 200 items are returned', () => {
      for (let i = 0; i < 210; i++) {
        registry.register({ id: `${i}`, name: `Item ${i}` });
      }
      const result = registry.list(undefined, 999);
      expect(result.items).toHaveLength(200);
      expect(result.nextCursor).not.toBeNull();
    });
  });

  describe('Scenario: onChange listener is notified', () => {
    it('Given a change listener, When items are registered/deregistered, Then the listener is called', () => {
      let changeCount = 0;
      registry.onChange(() => changeCount++);

      registry.register({ id: '1', name: 'One' });
      expect(changeCount).toBe(1);

      registry.register({ id: '2', name: 'Two' });
      expect(changeCount).toBe(2);

      registry.deregister('1');
      expect(changeCount).toBe(3);
    });
  });

  describe('Scenario: Size tracks registered items', () => {
    it('Given register and deregister operations, When size is called, Then it reflects the current count', () => {
      expect(registry.size()).toBe(0);

      registry.register({ id: 'a', name: 'A' });
      expect(registry.size()).toBe(1);

      registry.register({ id: 'b', name: 'B' });
      expect(registry.size()).toBe(2);

      registry.deregister('a');
      expect(registry.size()).toBe(1);
    });
  });

  describe('Scenario: Register overwrites existing item with same id', () => {
    it('Given an existing item, When re-registered with the same id, Then the item is updated', () => {
      registry.register({ id: '1', name: 'Original' });
      registry.register({ id: '1', name: 'Updated' });

      expect(registry.get('1')?.name).toBe('Updated');
      expect(registry.size()).toBe(1);
    });
  });
});

describe('Feature: Typed Registries', () => {
  describe('Scenario: ToolRegistry is a typed Registry', () => {
    it('Given a ToolRegistry, When a tool is registered, Then it is retrievable', () => {
      const reg = new ToolRegistry();
      reg.register({
        id: 'tool-1',
        name: 'search',
        title: 'Search',
        description: 'Search the web',
        inputSchema: { type: 'object' },
      });
      expect(reg.get('tool-1')?.name).toBe('search');
    });
  });

  describe('Scenario: ResourceRegistry is a typed Registry', () => {
    it('Given a ResourceRegistry, When a resource is registered, Then it is retrievable', () => {
      const reg = new ResourceRegistry();
      reg.register({
        id: 'res-1',
        name: 'config',
        title: 'Config',
        description: 'Application config',
        mimeType: 'application/json',
      });
      expect(reg.get('res-1')?.mimeType).toBe('application/json');
    });
  });

  describe('Scenario: PromptRegistry is a typed Registry', () => {
    it('Given a PromptRegistry, When a prompt is registered, Then it is retrievable', () => {
      const reg = new PromptRegistry();
      reg.register({
        id: 'prompt-1',
        name: 'greeting',
        title: 'Greeting',
        description: 'Greets the user',
        template: 'Hello {{name}}!',
      });
      expect(reg.get('prompt-1')?.template).toBe('Hello {{name}}!');
    });
  });
});
