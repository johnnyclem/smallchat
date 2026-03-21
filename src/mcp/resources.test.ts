import { describe, it, expect, beforeEach } from 'vitest';
import { ResourceRegistry, ResourceNotFoundError, type ResourceHandler, type MCPResource, type MCPResourceContent } from './resources.js';

describe('ResourceRegistry', () => {
  let registry: ResourceRegistry;

  const mockHandler: ResourceHandler = {
    providerId: 'test-provider',
    async list() {
      return {
        resources: [
          { uri: 'file:///test.txt', name: 'test.txt', mimeType: 'text/plain', providerId: 'test-provider' },
          { uri: 'file:///data.json', name: 'data.json', mimeType: 'application/json', providerId: 'test-provider' },
        ],
      };
    },
    async read(uri: string): Promise<MCPResourceContent> {
      if (uri === 'file:///test.txt') {
        return { uri, mimeType: 'text/plain', text: 'Hello, world!' };
      }
      if (uri === 'file:///data.json') {
        return { uri, mimeType: 'application/json', text: '{"key": "value"}' };
      }
      throw new ResourceNotFoundError(uri);
    },
    async listTemplates() {
      return [
        { uriTemplate: 'file:///{path}', name: 'File', description: 'Access a file by path' },
      ];
    },
  };

  beforeEach(() => {
    registry = new ResourceRegistry();
  });

  it('lists resources from registered handlers', async () => {
    registry.registerHandler(mockHandler);
    const result = await registry.list();
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].uri).toBe('file:///test.txt');
  });

  it('returns empty list with no handlers', async () => {
    const result = await registry.list();
    expect(result.resources).toHaveLength(0);
  });

  it('reads a resource by URI', async () => {
    registry.registerHandler(mockHandler);
    const content = await registry.read('file:///test.txt');
    expect(content.text).toBe('Hello, world!');
    expect(content.mimeType).toBe('text/plain');
  });

  it('throws ResourceNotFoundError for unknown URI', async () => {
    registry.registerHandler(mockHandler);
    await expect(registry.read('file:///unknown')).rejects.toThrow(ResourceNotFoundError);
  });

  it('lists resource templates', async () => {
    registry.registerHandler(mockHandler);
    const templates = await registry.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].uriTemplate).toBe('file:///{path}');
  });

  it('subscribes and receives change notifications', () => {
    registry.registerHandler(mockHandler);
    const events: unknown[] = [];

    const subId = registry.subscribe('file:///test.txt', (event) => {
      events.push(event);
    });

    expect(subId).toMatch(/^sub_/);
    expect(registry.hasSubscribers('file:///test.txt')).toBe(true);

    registry.notifyChange({
      type: 'updated',
      uri: 'file:///test.txt',
      timestamp: new Date().toISOString(),
    });

    expect(events).toHaveLength(1);
  });

  it('unsubscribes correctly', () => {
    const subId = registry.subscribe('file:///test.txt', () => {});
    expect(registry.unsubscribe(subId)).toBe(true);
    expect(registry.hasSubscribers('file:///test.txt')).toBe(false);
  });

  it('returns false when unsubscribing unknown ID', () => {
    expect(registry.unsubscribe('sub_999')).toBe(false);
  });

  it('counts subscriptions', () => {
    registry.subscribe('file:///a', () => {});
    registry.subscribe('file:///b', () => {});
    registry.subscribe('file:///a', () => {});
    expect(registry.subscriptionCount()).toBe(3);
  });

  it('unregisters a handler', async () => {
    registry.registerHandler(mockHandler);
    registry.unregisterHandler('test-provider');
    const result = await registry.list();
    expect(result.resources).toHaveLength(0);
  });
});
