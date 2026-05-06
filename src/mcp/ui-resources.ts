import type { McpUiResourceMeta } from './types.js';

/** Content provider — static string or lazy async loader */
export type UIContentProvider = string | (() => Promise<string>);

export interface UIResourceEntry {
  toolName: string;
  uri: string;
  description?: string;
  meta: McpUiResourceMeta;
  content: UIContentProvider;
}

export interface UIResourceContent {
  uri: string;
  mimeType: 'text/html;profile=mcp-app';
  text: string;
}

/**
 * UIResourceRegistry — stores and serves ui:// resources for MCP Apps.
 *
 * Each MCP App tool that declares a ui:// resource registers an HTML bundle
 * here. The McpRouter delegates resources/read for ui:// URIs to this registry.
 *
 * Obj-C analogy: UIResourceRegistry ≈ NSBundle — it stores the compiled
 * resource bundles (HTML) and serves them on demand. The uri:// scheme is
 * analogous to NSBundle's resource paths.
 *
 * URI scheme: ui://<serverName>/<toolName>
 *   e.g. "ui://smallchat/weather_view"
 *
 * Security: Content is served with MIME type text/html;profile=mcp-app so
 * hosts know to render it in a sandboxed iframe, not as raw HTML.
 */
export class UIResourceRegistry {
  private resources: Map<string, UIResourceEntry> = new Map();
  private readonly serverName: string;

  constructor(serverName = 'smallchat') {
    this.serverName = serverName;
  }

  /**
   * Register a ui:// resource for a tool.
   *
   * @param toolName  - The MCP tool name (e.g. "weather_view")
   * @param content   - HTML string or async loader (for lazy loading)
   * @param options   - Optional CSP/permission metadata and description
   */
  register(
    toolName: string,
    content: UIContentProvider,
    options?: {
      description?: string;
      meta?: McpUiResourceMeta;
      customUri?: string;
    },
  ): string {
    const uri = options?.customUri ?? this.buildUri(toolName);
    this.resources.set(uri, {
      toolName,
      uri,
      description: options?.description,
      meta: options?.meta ?? {},
      content,
    });
    return uri;
  }

  /**
   * Read a ui:// resource — returns its HTML content with the MCP Apps MIME type.
   * Returns null if the URI is not registered.
   */
  async read(uri: string): Promise<UIResourceContent | null> {
    const entry = this.resources.get(uri);
    if (!entry) return null;

    const text = typeof entry.content === 'string'
      ? entry.content
      : await entry.content();

    return { uri, mimeType: 'text/html;profile=mcp-app', text };
  }

  /** Check whether a URI is a registered ui:// resource */
  has(uri: string): boolean {
    return this.resources.has(uri);
  }

  /** Check whether any registered URI matches the ui:// scheme */
  isUIUri(uri: string): boolean {
    return uri.startsWith('ui://');
  }

  /** Get the canonical ui:// URI for a tool by name */
  getUriForTool(toolName: string): string | null {
    for (const entry of this.resources.values()) {
      if (entry.toolName === toolName) return entry.uri;
    }
    return null;
  }

  /** List all registered ui:// resources as MCP resource descriptors */
  list(): Array<{ uri: string; name: string; description?: string; mimeType: string }> {
    return [...this.resources.values()].map(entry => ({
      uri: entry.uri,
      name: entry.toolName,
      description: entry.description,
      mimeType: 'text/html;profile=mcp-app',
    }));
  }

  /** Total number of registered UI resources */
  get size(): number {
    return this.resources.size;
  }

  private buildUri(toolName: string): string {
    return `ui://${this.serverName}/${toolName}`;
  }
}
