/**
 * Federation — protocol for connecting multiple Smallchat runtimes
 *
 * Allows multiple Smallchat runtimes to discover, advertise, and call each
 * other's tools. A federated network forms a mesh of runtime nodes, each
 * capable of forwarding intents to the most capable peer.
 *
 * Federation protocol overview:
 *
 *   Node A                    Node B
 *     |── announce ──────────>|   (hello, my capabilities)
 *     |<─ announce ───────────|
 *     |── resolve intent ────>|   (can you handle "search web"?)
 *     |<─ result / forward ───|
 *
 * Transport: HTTP/JSON or WebSocket
 * Discovery: manual peer list or mDNS (future)
 * Security: shared secret or mTLS (configurable)
 *
 * Usage:
 *
 *   import { FederationNode } from './federation';
 *
 *   const node = new FederationNode(runtime, {
 *     nodeId: 'node-a',
 *     listenPort: 4001,
 *     peers: [{ url: 'http://node-b:4002', secret: '...' }],
 *   });
 *
 *   await node.start();
 *
 *   // Now runtime.dispatch() will try local tools first, then peers
 */

import type { ToolRuntime } from '../runtime/runtime.js';
import type { ToolResult, ToolSchema } from '../core/types.js';

// ---------------------------------------------------------------------------
// Federation protocol types
// ---------------------------------------------------------------------------

export const FEDERATION_PROTOCOL_VERSION = '1.0';

export interface FederationNodeInfo {
  nodeId: string;
  protocolVersion: string;
  capabilities: FederationCapability[];
  endpoint: string;
  publicKey?: string;
}

export interface FederationCapability {
  toolName: string;
  providerId: string;
  description: string;
  confidence: number;
  schema?: ToolSchema;
}

export interface FederationDispatchRequest {
  requestId: string;
  intent: string;
  args?: Record<string, unknown>;
  hopCount: number;
  originNodeId: string;
  /** If set, only try this specific tool */
  targetTool?: string;
}

export interface FederationDispatchResponse {
  requestId: string;
  nodeId: string;
  result?: ToolResult;
  error?: string;
  hopCount: number;
}

export interface FederationAnnouncement {
  type: 'announce';
  node: FederationNodeInfo;
  timestamp: number;
}

export interface FederationPeerConfig {
  url: string;
  secret?: string;
  /** Whether to allow forwarding to this peer (default true) */
  allowForward?: boolean;
  /** Max hops before refusing to forward (default 3) */
  maxHops?: number;
}

export interface FederationNodeOptions {
  nodeId: string;
  listenPort?: number;
  listenHost?: string;
  peers?: FederationPeerConfig[];
  /** Shared secret for request authentication */
  secret?: string;
  /** Max hops to allow in federated requests (default 3) */
  maxHops?: number;
  /** Whether to forward unresolved intents to peers (default true) */
  enableForwarding?: boolean;
  /** Heartbeat interval in ms (default 30s) */
  heartbeatInterval?: number;
}

// ---------------------------------------------------------------------------
// FederationPeer — connection to a remote Smallchat runtime
// ---------------------------------------------------------------------------

export class FederationPeer {
  readonly config: FederationPeerConfig;
  private nodeInfo: FederationNodeInfo | null = null;
  private lastSeen: number = 0;
  private healthy: boolean = false;

  constructor(config: FederationPeerConfig) {
    this.config = config;
  }

  get url(): string { return this.config.url; }
  get isHealthy(): boolean { return this.healthy; }
  get peerNodeInfo(): FederationNodeInfo | null { return this.nodeInfo; }

  async announce(localNode: FederationNodeInfo): Promise<FederationNodeInfo | null> {
    try {
      const response = await this.signedRequest('/federation/announce', {
        method: 'POST',
        body: JSON.stringify({ type: 'announce', node: localNode, timestamp: Date.now() }),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as { node: FederationNodeInfo };
      this.nodeInfo = data.node;
      this.lastSeen = Date.now();
      this.healthy = true;
      return this.nodeInfo;
    } catch {
      this.healthy = false;
      return null;
    }
  }

  async dispatch(request: FederationDispatchRequest): Promise<FederationDispatchResponse | null> {
    try {
      const response = await this.signedRequest('/federation/dispatch', {
        method: 'POST',
        body: JSON.stringify(request),
      });

      if (!response.ok) return null;
      return (await response.json()) as FederationDispatchResponse;
    } catch {
      this.healthy = false;
      return null;
    }
  }

  async listCapabilities(): Promise<FederationCapability[]> {
    try {
      const response = await this.signedRequest('/federation/capabilities', { method: 'GET' });
      if (!response.ok) return [];
      const data = (await response.json()) as { capabilities: FederationCapability[] };
      return data.capabilities;
    } catch {
      return [];
    }
  }

  async ping(): Promise<boolean> {
    try {
      const response = await this.signedRequest('/federation/ping', { method: 'GET' });
      this.healthy = response.ok;
      this.lastSeen = Date.now();
      return this.healthy;
    } catch {
      this.healthy = false;
      return false;
    }
  }

  private async signedRequest(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Federation-Protocol': FEDERATION_PROTOCOL_VERSION,
    };

    if (this.config.secret) {
      const timestamp = Date.now().toString();
      const sig = await sign(this.config.secret, timestamp + (init.body?.toString() ?? ''));
      headers['X-Federation-Timestamp'] = timestamp;
      headers['X-Federation-Signature'] = sig;
    }

    return fetch(`${this.config.url}${path}`, { ...init, headers });
  }

  get timeSinceLastSeen(): number {
    return Date.now() - this.lastSeen;
  }
}

// ---------------------------------------------------------------------------
// FederationNode — the local federation endpoint
// ---------------------------------------------------------------------------

export class FederationNode {
  readonly nodeId: string;
  private runtime: ToolRuntime;
  private options: Required<FederationNodeOptions>;
  private peers: Map<string, FederationPeer> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(runtime: ToolRuntime, options: FederationNodeOptions) {
    this.runtime = runtime;
    this.nodeId = options.nodeId;
    this.options = {
      nodeId: options.nodeId,
      listenPort: options.listenPort ?? 4001,
      listenHost: options.listenHost ?? '0.0.0.0',
      peers: options.peers ?? [],
      secret: options.secret ?? '',
      maxHops: options.maxHops ?? 3,
      enableForwarding: options.enableForwarding ?? true,
      heartbeatInterval: options.heartbeatInterval ?? 30000,
    };

    // Register configured peers
    for (const peerConfig of this.options.peers) {
      this.peers.set(peerConfig.url, new FederationPeer(peerConfig));
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Announce to all peers
    await this.announceToAllPeers();

    // Start heartbeat
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.options.heartbeatInterval);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Peer management
  // ---------------------------------------------------------------------------

  addPeer(config: FederationPeerConfig): FederationPeer {
    const peer = new FederationPeer(config);
    this.peers.set(config.url, peer);
    if (this.running) {
      void peer.announce(this.buildNodeInfo());
    }
    return peer;
  }

  removePeer(url: string): boolean {
    return this.peers.delete(url);
  }

  getHealthyPeers(): FederationPeer[] {
    return Array.from(this.peers.values()).filter(p => p.isHealthy);
  }

  // ---------------------------------------------------------------------------
  // Federated dispatch
  // ---------------------------------------------------------------------------

  /**
   * Dispatch an intent locally first, then try peers if unresolved.
   */
  async dispatch(
    intent: string,
    args?: Record<string, unknown>,
    options: { hopCount?: number } = {},
  ): Promise<ToolResult> {
    const hopCount = options.hopCount ?? 0;

    // Always try local first
    const localResult = await this.runtime.dispatch(intent, args);

    // If local succeeded (not a fallback), return it
    if (!isFallbackResult(localResult)) {
      return localResult;
    }

    // Try peers if forwarding is enabled and we haven't exceeded hop limit
    if (this.options.enableForwarding && hopCount < this.options.maxHops) {
      const peers = this.getHealthyPeers();
      for (const peer of peers) {
        const request: FederationDispatchRequest = {
          requestId: generateRequestId(),
          intent,
          args,
          hopCount: hopCount + 1,
          originNodeId: this.nodeId,
        };

        const response = await peer.dispatch(request);
        if (response?.result && !isFallbackResult(response.result)) {
          return {
            ...response.result,
            metadata: {
              ...response.result.metadata,
              federatedFrom: response.nodeId,
              hopCount: response.hopCount,
            },
          };
        }
      }
    }

    return localResult;
  }

  // ---------------------------------------------------------------------------
  // HTTP handlers (integrate with your server framework)
  // ---------------------------------------------------------------------------

  /**
   * Build the HTTP request handlers for federation endpoints.
   *
   * Register these with your HTTP server:
   *   app.post('/federation/announce', handlers.handleAnnounce);
   *   app.post('/federation/dispatch', handlers.handleDispatch);
   *   app.get('/federation/capabilities', handlers.handleCapabilities);
   *   app.get('/federation/ping', handlers.handlePing);
   */
  buildHttpHandlers(): FederationHttpHandlers {
    const node = this;

    return {
      async handleAnnounce(req: unknown, res: unknown): Promise<void> {
        const r = req as Record<string, unknown>;
        const response = res as Record<string, unknown>;

        const body = r.body as FederationAnnouncement;
        if (body.type !== 'announce') {
          (response.status as (c: number) => typeof response)(400);
          (response.json as (d: unknown) => void)({ error: 'Expected type: announce' });
          return;
        }

        // Register the announcing peer
        const peerUrl = body.node.endpoint;
        if (!node.peers.has(peerUrl)) {
          node.addPeer({ url: peerUrl, secret: node.options.secret });
        }

        (response.json as (d: unknown) => void)({ node: node.buildNodeInfo() });
      },

      async handleDispatch(req: unknown, res: unknown): Promise<void> {
        const r = req as Record<string, unknown>;
        const response = res as Record<string, unknown>;

        const body = r.body as FederationDispatchRequest;

        if (body.hopCount >= node.options.maxHops) {
          (response.status as (c: number) => typeof response)(429);
          (response.json as (d: unknown) => void)({ error: 'Max hop count exceeded' });
          return;
        }

        const result = await node.dispatch(body.intent, body.args, { hopCount: body.hopCount });
        const fedResponse: FederationDispatchResponse = {
          requestId: body.requestId,
          nodeId: node.nodeId,
          result,
          hopCount: body.hopCount + 1,
        };

        (response.json as (d: unknown) => void)(fedResponse);
      },

      async handleCapabilities(_req: unknown, res: unknown): Promise<void> {
        const response = res as Record<string, unknown>;
        (response.json as (d: unknown) => void)({
          capabilities: node.buildCapabilities(),
        });
      },

      handlePing(_req: unknown, res: unknown): void {
        const response = res as Record<string, unknown>;
        (response.json as (d: unknown) => void)({
          nodeId: node.nodeId,
          timestamp: Date.now(),
          peerCount: node.peers.size,
          healthyPeerCount: node.getHealthyPeers().length,
        });
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  buildNodeInfo(): FederationNodeInfo {
    return {
      nodeId: this.nodeId,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      capabilities: this.buildCapabilities(),
      endpoint: `http://${this.options.listenHost}:${this.options.listenPort}`,
    };
  }

  buildCapabilities(): FederationCapability[] {
    const capabilities: FederationCapability[] = [];
    for (const toolClass of this.runtime.context.getClasses()) {
      for (const [, imp] of toolClass.dispatchTable) {
        capabilities.push({
          toolName: imp.toolName,
          providerId: imp.providerId,
          description: imp.schema?.description ?? '',
          confidence: 1.0,
          schema: imp.schema ?? undefined,
        });
      }
    }
    return capabilities;
  }

  private async announceToAllPeers(): Promise<void> {
    const nodeInfo = this.buildNodeInfo();
    await Promise.allSettled(
      Array.from(this.peers.values()).map(p => p.announce(nodeInfo)),
    );
  }

  private async heartbeat(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.peers.values()).map(p => p.ping()),
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP handler types
// ---------------------------------------------------------------------------

export interface FederationHttpHandlers {
  handleAnnounce(req: unknown, res: unknown): Promise<void>;
  handleDispatch(req: unknown, res: unknown): Promise<void>;
  handleCapabilities(req: unknown, res: unknown): Promise<void>;
  handlePing(req: unknown, res: unknown): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFallbackResult(result: ToolResult): boolean {
  return result.metadata?.fallback === true;
}

let reqCounter = 0;
function generateRequestId(): string {
  return `fed_${Date.now()}_${(++reqCounter).toString(36)}`;
}

async function sign(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
