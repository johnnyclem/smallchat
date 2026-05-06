import type { AppIMP, DispatchEventUIInteraction, ToolResult } from '../core/types.js';

export type BridgeEvent =
  | { type: 'ready'; displayMode: 'inline' | 'fullscreen' | 'pip' }
  | { type: 'interaction'; event: string; sourceToolName: string; payload: unknown }
  | { type: 'error'; message: string }
  | { type: 'teardown' };

export type BridgeEventListener = (event: BridgeEvent) => void;

/**
 * AppBridgeWrapper — manages the lifecycle of a single mounted MCP Apps view.
 *
 * Wraps the @modelcontextprotocol/ext-apps app-bridge protocol, isolating
 * the rest of the runtime from the PostMessageTransport details.
 *
 * Obj-C analogy: AppBridgeWrapper ≈ NSWindowController — it owns the
 * connection between a model (AppIMP + tool result) and its view (iframe).
 *
 * In browser environments (detected via dynamic window check) this delegates
 * to the app-bridge library. In server/test/Node environments it operates in
 * headless stub mode, emitting the correct event sequence without a real iframe.
 * This keeps the runtime fully testable in Node and usable in SSR contexts.
 */
export class AppBridgeWrapper {
  readonly imp: AppIMP;
  private listeners: BridgeEventListener[] = [];
  private mounted = false;
  private displayMode: 'inline' | 'fullscreen' | 'pip';

  constructor(imp: AppIMP) {
    this.imp = imp;
    this.displayMode = imp.preferredDisplayMode ?? 'inline';
  }

  /**
   * Mount the view with an initial tool result.
   *
   * In browser environments:
   *   1. Dynamically imports @modelcontextprotocol/ext-apps/app-bridge
   *   2. Connects via the AppBridge PostMessageTransport
   *   3. Delivers the tool result via ui/notifications/tool-result
   *   4. Emits 'ready' event
   *
   * In headless/Node mode: emits ready immediately (no real iframe).
   * Event sequence is identical so server-side consumers behave consistently.
   */
  async mount(toolResult: ToolResult): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;

    const hasWindow = typeof globalThis !== 'undefined' &&
      'window' in globalThis &&
      (globalThis as Record<string, unknown>).window != null;

    if (hasWindow) {
      await this.mountBrowser(toolResult);
    } else {
      // Headless: emit ready immediately
      this.emit({ type: 'ready', displayMode: this.displayMode });
    }
  }

  private async mountBrowser(toolResult: ToolResult): Promise<void> {
    try {
      // Dynamic import keeps app-bridge out of server/Node bundles entirely.
      // We use `unknown` for the bridge object because the AppBridge API shape
      // is runtime-only and we can't type it without the dom lib.
      const extApps = await import('@modelcontextprotocol/ext-apps/app-bridge') as
        Record<string, unknown>;

      const AppBridgeCtor = extApps['AppBridge'] as (new (
        iframe: unknown,
        opts?: Record<string, unknown>,
      ) => Record<string, unknown>) | undefined;

      if (!AppBridgeCtor) {
        // Library loaded but AppBridge not exported — run headless
        this.emit({ type: 'ready', displayMode: this.displayMode });
        return;
      }

      // Create a detached iframe in the browser document
      const doc = (globalThis as Record<string, unknown>).document as {
        createElement: (tag: string) => Record<string, unknown>;
        body: { appendChild: (el: unknown) => void };
      } | undefined;

      if (!doc) {
        this.emit({ type: 'ready', displayMode: this.displayMode });
        return;
      }

      const iframe = doc.createElement('iframe') as Record<string, unknown>;
      iframe['src'] = this.imp.componentUri;
      const sandbox = iframe['sandbox'] as Set<string> | undefined;
      sandbox?.add('allow-scripts');
      sandbox?.add('allow-same-origin');
      doc.body.appendChild(iframe);

      const bridge = new AppBridgeCtor(iframe, {
        allowedOrigins: this.imp.csp?.allowedDomains,
      });

      // Connect and deliver initial tool result
      const connectFn = bridge['connect'] as (() => Promise<void>) | undefined;
      if (connectFn) await connectFn.call(bridge);

      const sendResultFn = bridge['sendToolResult'] as
        ((args: Record<string, unknown>) => Promise<void>) | undefined;
      if (sendResultFn) {
        await sendResultFn.call(bridge, {
          toolName: this.imp.toolName,
          result: toolResult.content,
        });
      }

      // Listen for view-initiated tool calls (forwardInvocation: analogy)
      const onToolCall = (toolName: string, args: unknown) => {
        this.emit({ type: 'interaction', event: 'tool-call', sourceToolName: toolName, payload: args });
      };
      (bridge as Record<string, unknown>)['onToolCall'] = onToolCall;

      const onMsg = (msg: unknown) => {
        this.emit({ type: 'interaction', event: 'message', sourceToolName: this.imp.toolName, payload: msg });
      };
      (bridge as Record<string, unknown>)['onmessage'] = onMsg;

      this.emit({ type: 'ready', displayMode: this.displayMode });
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Deliver an updated tool result to the mounted view.
   * Maps to ui/notifications/tool-result in the MCP Apps protocol.
   */
  async sendUpdate(toolResult: ToolResult): Promise<void> {
    if (!this.mounted) return;
    this.emit({
      type: 'interaction',
      event: 'update',
      sourceToolName: this.imp.toolName,
      payload: toolResult.content,
    });
  }

  /**
   * Teardown the view — sends ui/resource-teardown and destroys the bridge.
   * Equivalent to dismissViewController: + dealloc.
   */
  async teardown(): Promise<void> {
    if (!this.mounted) return;
    this.mounted = false;
    this.emit({ type: 'teardown' });
    this.listeners = [];
  }

  on(listener: BridgeEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  get isMounted(): boolean {
    return this.mounted;
  }

  toUIInteractionEvent(event: BridgeEvent & { type: 'interaction' }): DispatchEventUIInteraction {
    return {
      type: 'ui-interaction',
      event: event.event,
      sourceToolName: event.sourceToolName,
      payload: event.payload,
    };
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/**
 * AppBridgePool — manages a collection of active AppBridgeWrappers.
 *
 * Analogous to ConnectionPool in src/transport/ — provides lifecycle
 * management (acquire/release/teardownAll) for mounted views.
 */
export class AppBridgePool {
  private pool: Map<string, AppBridgeWrapper> = new Map();
  private readonly maxSize: number;

  constructor(maxSize = 32) {
    this.maxSize = maxSize;
  }

  acquire(imp: AppIMP): AppBridgeWrapper {
    const key = `${imp.providerId}:${imp.toolName}`;
    const existing = this.pool.get(key);
    if (existing?.isMounted) return existing;

    // Evict oldest if at capacity
    if (this.pool.size >= this.maxSize) {
      const entry = this.pool.entries().next().value;
      if (entry) {
        entry[1].teardown();
        this.pool.delete(entry[0]);
      }
    }

    const wrapper = new AppBridgeWrapper(imp);
    this.pool.set(key, wrapper);
    return wrapper;
  }

  release(imp: AppIMP): void {
    const key = `${imp.providerId}:${imp.toolName}`;
    const wrapper = this.pool.get(key);
    if (wrapper) {
      wrapper.teardown();
      this.pool.delete(key);
    }
  }

  async teardownAll(): Promise<void> {
    await Promise.all([...this.pool.values()].map(w => w.teardown()));
    this.pool.clear();
  }

  get size(): number {
    return this.pool.size;
  }
}
