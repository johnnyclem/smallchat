/**
 * Webhook Receivers — tools triggered by incoming webhooks
 *
 * Defines a WebhookReceiver system that:
 *  1. Registers named webhook endpoints with event schemas
 *  2. Validates incoming webhook payloads (HMAC signature verification)
 *  3. Dispatches webhook events to the ToolRuntime
 *  4. Exposes webhook-triggered tools that can be used in dispatch
 *
 * Integration with HTTP servers:
 *  - Express / Fastify: use WebhookRouter.handleRequest()
 *  - Node.js http: use WebhookRouter.handleIncomingMessage()
 *
 * Usage:
 *
 *   import { WebhookRouter, WebhookReceiver } from './transports/webhook';
 *
 *   const router = new WebhookRouter({ runtime, secret: process.env.WEBHOOK_SECRET });
 *
 *   // Register a webhook for GitHub push events
 *   router.register({
 *     id: 'github-push',
 *     path: '/webhooks/github',
 *     secret: process.env.GITHUB_WEBHOOK_SECRET,
 *     signatureHeader: 'X-Hub-Signature-256',
 *     signatureAlgorithm: 'sha256',
 *     events: ['push', 'pull_request'],
 *     handler: async (payload, event) => {
 *       return runtime.dispatch('process github event', { event, payload });
 *     },
 *   });
 *
 *   // Express
 *   app.post('/webhooks/*', router.expressMiddleware());
 */

import type { ToolRuntime } from '../runtime/runtime.js';
import type { ToolResult, ToolIMP, ArgumentConstraints } from '../core/types.js';

// ---------------------------------------------------------------------------
// Webhook definition types
// ---------------------------------------------------------------------------

export type SignatureAlgorithm = 'sha256' | 'sha1' | 'sha512';

export interface WebhookReceiverDef {
  /** Unique webhook ID */
  id: string;
  /** URL path this webhook listens on (e.g. '/webhooks/github') */
  path: string;
  /** Optional HMAC secret for signature verification */
  secret?: string;
  /** Header containing the signature (e.g. 'X-Hub-Signature-256') */
  signatureHeader?: string;
  /** HMAC algorithm (default 'sha256') */
  signatureAlgorithm?: SignatureAlgorithm;
  /** Event type header (e.g. 'X-GitHub-Event') */
  eventTypeHeader?: string;
  /** Optional filter — only process these event types */
  events?: string[];
  /** Handler function called with the parsed payload */
  handler: WebhookHandler;
  /** Whether to respond with 200 immediately before processing (async delivery) */
  asyncDelivery?: boolean;
}

export type WebhookHandler = (
  payload: unknown,
  meta: WebhookEventMeta,
) => Promise<ToolResult | void>;

export interface WebhookEventMeta {
  webhookId: string;
  eventType?: string;
  deliveryId?: string;
  timestamp: number;
  rawHeaders: Record<string, string>;
}

export interface WebhookIncomingRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
  method: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// WebhookRouter
// ---------------------------------------------------------------------------

export class WebhookRouter {
  private receivers: Map<string, WebhookReceiverDef> = new Map();
  private pathIndex: Map<string, string> = new Map(); // path → id
  private runtime?: ToolRuntime;
  private deliveryLog: WebhookDelivery[] = [];
  private maxLogSize: number;

  constructor(options: WebhookRouterOptions = {}) {
    this.runtime = options.runtime;
    this.maxLogSize = options.maxLogSize ?? 1000;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  register(def: WebhookReceiverDef): void {
    this.receivers.set(def.id, def);
    this.pathIndex.set(def.path, def.id);
  }

  unregister(id: string): boolean {
    const def = this.receivers.get(id);
    if (!def) return false;
    this.pathIndex.delete(def.path);
    this.receivers.delete(id);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Request handling
  // ---------------------------------------------------------------------------

  async handleRequest(req: WebhookIncomingRequest): Promise<WebhookResponse> {
    if (req.method !== 'POST' && req.method !== 'PUT') {
      return { status: 405, body: 'Method Not Allowed' };
    }

    const webhookId = this.pathIndex.get(req.path);
    if (!webhookId) {
      return { status: 404, body: 'Webhook not found' };
    }

    const def = this.receivers.get(webhookId)!;

    // Build normalized headers
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : (v ?? '');
    }

    // Signature verification
    if (def.secret && def.signatureHeader) {
      const headerValue = headers[def.signatureHeader.toLowerCase()];
      const body = typeof req.body === 'string' ? req.body : req.body.toString('utf8');

      const valid = await verifySignature(
        body,
        def.secret,
        headerValue ?? '',
        def.signatureAlgorithm ?? 'sha256',
      );

      if (!valid) {
        this.logDelivery(webhookId, 'rejected', 'Signature verification failed');
        return { status: 401, body: 'Signature verification failed' };
      }
    }

    // Parse payload
    let payload: unknown;
    try {
      const bodyStr = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
      payload = JSON.parse(bodyStr);
    } catch {
      const bodyStr = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
      payload = bodyStr;
    }

    // Event type filter
    const eventType = def.eventTypeHeader
      ? headers[def.eventTypeHeader.toLowerCase()]
      : undefined;

    if (def.events && eventType && !def.events.includes(eventType)) {
      return { status: 200, body: JSON.stringify({ status: 'ignored', reason: 'event filtered' }) };
    }

    const meta: WebhookEventMeta = {
      webhookId,
      eventType,
      deliveryId: headers['x-github-delivery'] ?? headers['x-request-id'] ?? generateDeliveryId(),
      timestamp: Date.now(),
      rawHeaders: headers,
    };

    // Async delivery: respond immediately, process in background
    if (def.asyncDelivery) {
      void this.processWebhook(def, payload, meta);
      return { status: 200, body: JSON.stringify({ status: 'accepted' }) };
    }

    // Synchronous processing
    try {
      const result = await def.handler(payload, meta);
      this.logDelivery(webhookId, 'delivered', undefined, result ?? undefined);

      return {
        status: 200,
        body: JSON.stringify(result ?? { status: 'ok' }),
        headers: { 'Content-Type': 'application/json' },
      };
    } catch (err) {
      this.logDelivery(webhookId, 'failed', (err as Error).message);
      return { status: 500, body: JSON.stringify({ error: (err as Error).message }) };
    }
  }

  // ---------------------------------------------------------------------------
  // Express middleware
  // ---------------------------------------------------------------------------

  expressMiddleware(): (req: unknown, res: unknown, next: unknown) => void {
    return async (req: unknown, res: unknown, _next: unknown) => {
      const r = req as Record<string, unknown>;
      const response_obj = res as Record<string, unknown>;

      const chunks: Buffer[] = [];
      const bodyStream = r.body
        ? Promise.resolve(
          typeof r.body === 'string'
            ? r.body
            : JSON.stringify(r.body),
        )
        : new Promise<string>(resolve => {
          const stream = r as unknown as { on(ev: string, cb: (d?: unknown) => void): void };
          stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });

      const body = await bodyStream;

      const incoming: WebhookIncomingRequest = {
        path: String(r.path ?? r.url ?? ''),
        method: String(r.method ?? 'POST'),
        headers: r.headers as Record<string, string>,
        body,
      };

      const result = await this.handleRequest(incoming);

      (response_obj.status as (code: number) => typeof response_obj)(result.status);
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          (response_obj.setHeader as (k: string, v: string) => void)(k, v);
        }
      }
      (response_obj.send as (body: string) => void)(result.body);
    };
  }

  // ---------------------------------------------------------------------------
  // Delivery log
  // ---------------------------------------------------------------------------

  getDeliveries(webhookId?: string): WebhookDelivery[] {
    return webhookId
      ? this.deliveryLog.filter(d => d.webhookId === webhookId)
      : [...this.deliveryLog];
  }

  // ---------------------------------------------------------------------------
  // ToolIMP integration — expose webhook registration as a tool
  // ---------------------------------------------------------------------------

  createRegistrationToolIMP(providerId: string): ToolIMP {
    const router = this;
    const constraints: ArgumentConstraints = {
      required: [],
      optional: [],
      validate: () => ({ valid: true, errors: [] }),
    };

    const schema = {
      name: 'webhook_register',
      description: 'Register a new webhook receiver endpoint',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Unique webhook ID' },
          path: { type: 'string', description: 'URL path, e.g. /webhooks/stripe' },
          secret: { type: 'string', description: 'HMAC secret for signature verification' },
          eventTypeHeader: { type: 'string', description: 'Header containing event type' },
          events: { type: 'array', description: 'Event types to accept (empty = all)' },
          dispatchIntent: { type: 'string', description: 'Smallchat intent to dispatch on delivery' },
        },
        required: ['id', 'path'],
      },
      arguments: [],
    };

    return {
      providerId,
      toolName: 'webhook_register',
      transportType: 'local',
      schema,
      schemaLoader: async () => schema,
      constraints,
      async execute(args): Promise<ToolResult> {
        const def: WebhookReceiverDef = {
          id: String(args.id),
          path: String(args.path),
          secret: args.secret ? String(args.secret) : undefined,
          eventTypeHeader: args.eventTypeHeader ? String(args.eventTypeHeader) : undefined,
          events: Array.isArray(args.events) ? args.events.map(String) : undefined,
          handler: async (payload, meta) => {
            if (router.runtime && args.dispatchIntent) {
              return router.runtime.dispatch(String(args.dispatchIntent), {
                payload,
                ...meta,
              });
            }
            return { content: { received: true, meta }, isError: false };
          },
        };

        router.register(def);
        return { content: { registered: true, id: def.id, path: def.path }, isError: false };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async processWebhook(
    def: WebhookReceiverDef,
    payload: unknown,
    meta: WebhookEventMeta,
  ): Promise<void> {
    try {
      const result = await def.handler(payload, meta);
      this.logDelivery(def.id, 'delivered', undefined, result ?? undefined);
    } catch (err) {
      this.logDelivery(def.id, 'failed', (err as Error).message);
    }
  }

  private logDelivery(
    webhookId: string,
    status: WebhookDelivery['status'],
    error?: string,
    result?: unknown,
  ): void {
    if (this.deliveryLog.length >= this.maxLogSize) {
      this.deliveryLog.shift();
    }
    this.deliveryLog.push({
      webhookId,
      timestamp: Date.now(),
      status,
      error,
      result,
    });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookRouterOptions {
  runtime?: ToolRuntime;
  maxLogSize?: number;
}

export interface WebhookDelivery {
  webhookId: string;
  timestamp: number;
  status: 'delivered' | 'failed' | 'rejected' | 'ignored';
  error?: string;
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Pre-built webhook receivers for popular services
// ---------------------------------------------------------------------------

export function createGitHubWebhookReceiver(
  path: string,
  secret: string,
  handler: WebhookHandler,
): WebhookReceiverDef {
  return {
    id: 'github',
    path,
    secret,
    signatureHeader: 'X-Hub-Signature-256',
    signatureAlgorithm: 'sha256',
    eventTypeHeader: 'X-GitHub-Event',
    handler,
  };
}

export function createStripeWebhookReceiver(
  path: string,
  secret: string,
  handler: WebhookHandler,
): WebhookReceiverDef {
  return {
    id: 'stripe',
    path,
    secret,
    signatureHeader: 'Stripe-Signature',
    signatureAlgorithm: 'sha256',
    handler,
  };
}

export function createSlackWebhookReceiver(
  path: string,
  signingSecret: string,
  handler: WebhookHandler,
): WebhookReceiverDef {
  return {
    id: 'slack',
    path,
    secret: signingSecret,
    signatureHeader: 'X-Slack-Signature',
    signatureAlgorithm: 'sha256',
    eventTypeHeader: 'X-Slack-Event-Type',
    handler,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function verifySignature(
  body: string,
  secret: string,
  providedSignature: string,
  algorithm: SignatureAlgorithm,
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: `SHA-${algorithm === 'sha1' ? 1 : algorithm === 'sha512' ? 512 : 256}` },
      false,
      ['sign'],
    );

    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const computed = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Strip "sha256=", "sha1=", etc. prefixes
    const clean = providedSignature.replace(/^(sha\d+=)/, '');
    return timingSafeEqual(computed, clean);
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

let deliveryCounter = 0;
function generateDeliveryId(): string {
  return `wh_${Date.now()}_${(++deliveryCounter).toString(36)}`;
}
