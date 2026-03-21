/**
 * Input Serialization & Output Parsing.
 *
 * Handles the mapping between SCObject arguments and the wire formats
 * required by HTTP transports (JSON body, query parameters, path params,
 * multipart form data).
 *
 * Also handles parsing HTTP responses (JSON, text, binary) back into
 * TransportOutput with proper content typing.
 */

import type { HttpMethod, HttpTransportRoute, TransportOutput } from './types.js';

// ---------------------------------------------------------------------------
// Input Serialization
// ---------------------------------------------------------------------------

export interface SerializedRequest {
  /** Final URL with path and query parameters applied */
  url: string;
  /** HTTP method */
  method: HttpMethod;
  /** Request headers */
  headers: Record<string, string>;
  /** Request body (null for GET/HEAD/DELETE without body) */
  body: string | FormData | null;
}

/**
 * Serialize tool arguments into an HTTP request based on the route config.
 *
 * Routing logic:
 *   - Path params: interpolated into the URL path (e.g., /users/{id})
 *   - Query params: appended as URL search params
 *   - Body params: serialized as JSON body (POST/PUT/PATCH)
 *   - If no route config, all args go in the body for POST or query for GET
 */
export function serializeInput(
  baseUrl: string,
  args: Record<string, unknown>,
  route?: HttpTransportRoute,
): SerializedRequest {
  const method = route?.method ?? 'POST';
  const headers: Record<string, string> = { ...route?.headers };

  // Build the URL path
  let path = route?.path ?? '';

  // Interpolate path parameters
  const pathParams = new Set(route?.pathParams ?? []);
  for (const param of pathParams) {
    const value = args[param];
    if (value !== undefined) {
      path = path.replace(`{${param}}`, encodeURIComponent(String(value)));
    }
  }

  // Build query parameters
  const queryParams = new Set(route?.queryParams ?? []);
  const searchParams = new URLSearchParams();

  // For GET requests without explicit route, put all args as query params
  if (!route && (method === 'GET' || method === 'HEAD' || method === 'DELETE')) {
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && value !== null) {
        searchParams.set(key, serializeQueryValue(value));
      }
    }
  } else {
    for (const param of queryParams) {
      const value = args[param];
      if (value !== undefined && value !== null) {
        searchParams.set(param, serializeQueryValue(value));
      }
    }
  }

  // Build the full URL
  const base = baseUrl.replace(/\/$/, '');
  const fullPath = path ? `${base}/${path.replace(/^\//, '')}` : base;
  const queryString = searchParams.toString();
  const url = queryString ? `${fullPath}?${queryString}` : fullPath;

  // Build the body
  let body: string | null = null;

  if (method !== 'GET' && method !== 'HEAD') {
    const bodyParams = new Set(route?.bodyParams ?? []);
    let bodyData: Record<string, unknown>;

    if (bodyParams.size > 0) {
      // Only include specified body params
      bodyData = {};
      for (const param of bodyParams) {
        if (param in args) {
          bodyData[param] = args[param];
        }
      }
    } else if (route) {
      // Exclude path and query params, send the rest as body
      bodyData = {};
      for (const [key, value] of Object.entries(args)) {
        if (!pathParams.has(key) && !queryParams.has(key)) {
          bodyData[key] = value;
        }
      }
    } else {
      // No route config — send all args as body
      bodyData = args;
    }

    if (Object.keys(bodyData).length > 0) {
      body = JSON.stringify(bodyData);
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    }
  }

  return { url, method, headers, body };
}

/** Serialize a value for use as a query parameter */
function serializeQueryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(',');
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an HTTP response into a TransportOutput.
 *
 * Content-Type routing:
 *   - application/json → parsed JSON
 *   - text/*           → string
 *   - application/octet-stream, image/*, etc. → base64-encoded string
 *   - No content (204) → null
 */
export async function parseOutput(response: Response): Promise<TransportOutput> {
  const statusCode = response.status;
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  // No content
  if (statusCode === 204 || response.headers.get('content-length') === '0') {
    return {
      content: null,
      isError: !response.ok,
      metadata: { statusCode, headers: responseHeaders },
    };
  }

  const contentType = response.headers.get('content-type') ?? '';
  let content: unknown;

  try {
    if (contentType.includes('application/json')) {
      content = await response.json();
    } else if (contentType.includes('text/')) {
      content = await response.text();
    } else if (isBinaryContentType(contentType)) {
      const buffer = await response.arrayBuffer();
      content = {
        type: 'binary',
        contentType,
        base64: arrayBufferToBase64(buffer),
        size: buffer.byteLength,
      };
    } else {
      // Try JSON first, fall back to text
      const text = await response.text();
      try {
        content = JSON.parse(text);
      } catch {
        content = text;
      }
    }
  } catch {
    content = null;
  }

  return {
    content,
    isError: !response.ok,
    metadata: { statusCode, headers: responseHeaders },
  };
}

/** Check if a content type represents binary data */
function isBinaryContentType(contentType: string): boolean {
  return (
    contentType.includes('application/octet-stream') ||
    contentType.includes('image/') ||
    contentType.includes('audio/') ||
    contentType.includes('video/') ||
    contentType.includes('application/pdf') ||
    contentType.includes('application/zip')
  );
}

/** Convert an ArrayBuffer to a base64 string */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}
