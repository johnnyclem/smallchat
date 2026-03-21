/**
 * MCP Resources — list, read, and subscribe to provider resources.
 *
 * Resources are provider-managed data objects (files, database rows,
 * API objects) that clients can discover, read, and subscribe to for
 * live change notifications.
 */

// ---------------------------------------------------------------------------
// Resource types
// ---------------------------------------------------------------------------

export interface MCPResource {
  /** Unique resource URI (e.g., "file:///path/to/file.txt") */
  uri: string;
  /** Human-readable name */
  name: string;
  /** Optional description */
  description?: string;
  /** MIME type */
  mimeType?: string;
  /** Provider that owns this resource */
  providerId: string;
}

export interface MCPResourceContent {
  /** Resource URI */
  uri: string;
  /** MIME type of the content */
  mimeType: string;
  /** Text content (for text resources) */
  text?: string;
  /** Base64-encoded binary content */
  blob?: string;
}

export interface MCPResourceTemplate {
  /** URI template (RFC 6570) */
  uriTemplate: string;
  /** Human-readable name */
  name: string;
  /** Description of what this template generates */
  description?: string;
  /** MIME type of resources produced */
  mimeType?: string;
}

export type ResourceChangeEvent = {
  type: 'created' | 'updated' | 'deleted';
  uri: string;
  timestamp: string;
};

// ---------------------------------------------------------------------------
// Resource handler interface
// ---------------------------------------------------------------------------

export interface ResourceHandler {
  /** Provider ID for this handler */
  providerId: string;
  /** List available resources, with optional cursor pagination */
  list(cursor?: string): Promise<{ resources: MCPResource[]; nextCursor?: string }>;
  /** Read a specific resource by URI */
  read(uri: string): Promise<MCPResourceContent>;
  /** List resource templates */
  listTemplates?(): Promise<MCPResourceTemplate[]>;
}

// ---------------------------------------------------------------------------
// Subscription manager
// ---------------------------------------------------------------------------

type SubscriptionCallback = (event: ResourceChangeEvent) => void;

interface Subscription {
  id: string;
  uri: string;
  callback: SubscriptionCallback;
}

// ---------------------------------------------------------------------------
// Resource registry
// ---------------------------------------------------------------------------

export class ResourceRegistry {
  private handlers: Map<string, ResourceHandler> = new Map();
  private subscriptions: Map<string, Subscription[]> = new Map();
  private subscriptionCounter = 0;

  /** Register a resource handler for a provider */
  registerHandler(handler: ResourceHandler): void {
    this.handlers.set(handler.providerId, handler);
  }

  /** Remove a resource handler */
  unregisterHandler(providerId: string): void {
    this.handlers.delete(providerId);
    // Clean up subscriptions for this provider
    for (const [uri, subs] of this.subscriptions) {
      if (uri.startsWith(`${providerId}:`)) {
        this.subscriptions.delete(uri);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MCP resources/list
  // ---------------------------------------------------------------------------

  async list(cursor?: string): Promise<{ resources: MCPResource[]; nextCursor?: string }> {
    const allResources: MCPResource[] = [];
    let nextCursor: string | undefined;

    // Collect resources from all handlers
    for (const handler of this.handlers.values()) {
      try {
        const result = await handler.list(cursor);
        allResources.push(...result.resources);
        if (result.nextCursor) {
          nextCursor = result.nextCursor;
        }
      } catch {
        // Skip handlers that fail — partial results are better than none
      }
    }

    return { resources: allResources, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // MCP resources/read
  // ---------------------------------------------------------------------------

  async read(uri: string): Promise<MCPResourceContent> {
    // Find the handler that owns this resource
    for (const handler of this.handlers.values()) {
      try {
        const result = await handler.read(uri);
        if (result) return result;
      } catch {
        // Try next handler
      }
    }

    throw new ResourceNotFoundError(uri);
  }

  // ---------------------------------------------------------------------------
  // MCP resources/templates/list
  // ---------------------------------------------------------------------------

  async listTemplates(): Promise<MCPResourceTemplate[]> {
    const templates: MCPResourceTemplate[] = [];

    for (const handler of this.handlers.values()) {
      if (handler.listTemplates) {
        try {
          const result = await handler.listTemplates();
          templates.push(...result);
        } catch {
          // Skip handlers that fail
        }
      }
    }

    return templates;
  }

  // ---------------------------------------------------------------------------
  // MCP resources/subscribe & resources/unsubscribe
  // ---------------------------------------------------------------------------

  subscribe(uri: string, callback: SubscriptionCallback): string {
    const id = `sub_${++this.subscriptionCounter}`;
    const subscription: Subscription = { id, uri, callback };

    const subs = this.subscriptions.get(uri) ?? [];
    subs.push(subscription);
    this.subscriptions.set(uri, subs);

    return id;
  }

  unsubscribe(subscriptionId: string): boolean {
    for (const [uri, subs] of this.subscriptions) {
      const idx = subs.findIndex(s => s.id === subscriptionId);
      if (idx !== -1) {
        subs.splice(idx, 1);
        if (subs.length === 0) {
          this.subscriptions.delete(uri);
        }
        return true;
      }
    }
    return false;
  }

  /** Emit a change event to all subscribers of a URI */
  notifyChange(event: ResourceChangeEvent): void {
    const subs = this.subscriptions.get(event.uri);
    if (!subs) return;

    for (const sub of subs) {
      try {
        sub.callback(event);
      } catch {
        // Don't let one bad callback break others
      }
    }
  }

  /** Check if any subscriptions exist for a URI */
  hasSubscribers(uri: string): boolean {
    const subs = this.subscriptions.get(uri);
    return subs !== undefined && subs.length > 0;
  }

  /** Get count of active subscriptions */
  subscriptionCount(): number {
    let count = 0;
    for (const subs of this.subscriptions.values()) {
      count += subs.length;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ResourceNotFoundError extends Error {
  uri: string;

  constructor(uri: string) {
    super(`Resource not found: ${uri}`);
    this.name = 'ResourceNotFoundError';
    this.uri = uri;
  }
}
