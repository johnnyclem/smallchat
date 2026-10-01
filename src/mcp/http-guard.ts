/**
 * HTTP guards for `smallchat serve --http`, applied before any request
 * reaches the MCP layer:
 *
 *   - Host: the Host header's hostname (port-agnostic) must be allowed —
 *     by default the loopback names when bound to loopback. Defeats DNS
 *     rebinding, where a web page's own hostname resolves to 127.0.0.1.
 *   - Origin: a request that carries an Origin must name an allowed one
 *     (none by default). Browsers always send Origin on cross-site POSTs.
 *   - Bearer token: required by default, compared in constant time. It is
 *     generated into a 0600 file on first use (ensureTokenFile).
 *   - Body: POSTs must be application/json, at most `maxBodyBytes`, and
 *     parse as a JSON-RPC message or batch; a client that disconnects
 *     mid-body is dropped without a response.
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';

/** Default location of the generated bearer token. */
export const DEFAULT_TOKEN_FILE = join(homedir(), '.smallchat', 'serve-token');

/** Default request body cap for POST /mcp. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** Whether a bind address is loopback-only. */
export function isLoopbackBind(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * The hostnames a server bound to `bindHost` accepts in Host by default:
 * the loopback names for a loopback bind, the bind address itself for a
 * specific address. A wildcard bind (0.0.0.0, ::) has no safe default and
 * returns null — the caller must configure allowed hosts.
 */
export function defaultAllowedHostnames(bindHost: string): string[] | null {
  if (isLoopbackBind(bindHost)) return [...LOOPBACK_HOSTNAMES];
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]' || bindHost === '') return null;
  return [hostnameOf(bindHost) ?? bindHost];
}

/** The hostname of a Host header value (port stripped, IPv6 bracketed), or null. */
export function hostnameOf(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname || null;
  } catch {
    return null;
  }
}

/** Whether the Host header names an allowed hostname. */
export function hostAllowed(hostHeader: string | undefined, allowedHostnames: readonly string[]): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader);
  return hostname !== null && allowedHostnames.includes(hostname.toLowerCase());
}

/** Whether a request's Origin is acceptable: absent, or exactly allowed. */
export function originAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!match) return false;
  // Compare digests so the comparison is constant-time regardless of length.
  const given = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, expected);
}

/** Whether a Content-Type header is JSON. */
export function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

/** A request refused at the HTTP layer, with the status to answer. */
export class HttpRejection extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rpcCode = -32000,
  ) {
    super(message);
    this.name = 'HttpRejection';
  }
}

/** The client went away before sending its whole body; answer nothing. */
export class ClientAbortedError extends Error {
  constructor() {
    super('client disconnected before sending the request body');
    this.name = 'ClientAbortedError';
  }
}

/**
 * Read a request body of at most `maxBytes`. Rejects with HttpRejection
 * (413) when it is larger, ClientAbortedError when the client disconnects
 * first. Never throws synchronously, never leaves a listener behind.
 */
export function readBody(req: IncomingMessage, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new HttpRejection(413, `Request body exceeds ${maxBytes} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const finish = (err: Error | null, body?: Buffer) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
      if (err) reject(err);
      else resolve(body!);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        // Stop buffering; drain the rest so the 413 can still be written.
        req.resume();
        finish(new HttpRejection(413, `Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(new ClientAbortedError());
    const onAborted = () => finish(new ClientAbortedError());
    const onClose = () => {
      if (!req.complete) finish(new ClientAbortedError());
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

/**
 * Parse a POST body as a JSON-RPC message or a non-empty batch of them.
 * Throws HttpRejection(400) with the JSON-RPC parse/invalid-request code.
 */
export function parseJsonRpcBody(body: Buffer): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    throw new HttpRejection(400, 'Parse error: body is not valid JSON', -32700);
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (messages.length === 0 || !messages.every(isJsonRpcEnvelope)) {
    throw new HttpRejection(400, 'Invalid Request: expected a JSON-RPC 2.0 message object', -32600);
  }
  return parsed;
}

function isJsonRpcEnvelope(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { jsonrpc?: unknown }).jsonrpc === '2.0';
}

/** Whether a parsed body is (only) an initialize request. */
export function isInitializeBody(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(m => (m as { method?: unknown }).method === 'initialize');
}

/**
 * Read the bearer token from `path`, or generate one there (mode 0600, in
 * a 0700 directory) if the file does not exist. Refuses a token file that
 * group or others can read, or one too short to be a secret.
 */
export function ensureTokenFile(path = DEFAULT_TOKEN_FILE): { token: string; created: boolean } {
  if (existsSync(path)) {
    const mode = statSync(path).mode;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
      throw new Error(`${path} is readable by other users (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
    }
    const token = readFileSync(path, 'utf-8').trim();
    if (token.length < 32) {
      throw new Error(`${path} holds a token shorter than 32 characters; delete it to generate a new one`);
    }
    return { token, created: false };
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return { token, created: true };
}
