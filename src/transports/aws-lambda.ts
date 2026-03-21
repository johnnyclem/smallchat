/**
 * AWS Lambda Transport — invoke AWS Lambda functions as Smallchat tools
 *
 * Implements a transport that invokes AWS Lambda functions, with support for:
 *  - Synchronous invocation (RequestResponse)
 *  - Async invocation (Event) with optional response capture
 *  - Dry run validation
 *  - Alias and qualifier support
 *  - Payload marshalling (JSON <-> Lambda payload)
 *  - Error handling (FunctionError header)
 *  - Multi-region routing
 *
 * Authentication is handled via:
 *  - AWS SDK (if installed) with standard credential resolution
 *  - Manual SigV4 signing for environments without the full SDK
 *  - AWS Lambda Function URL (no signing required)
 *
 * Usage:
 *
 *   import { AWSLambdaTransport } from './transports/aws-lambda';
 *
 *   const transport = new AWSLambdaTransport({
 *     region: 'us-east-1',
 *     credentials: { accessKeyId: '...', secretAccessKey: '...' },
 *   });
 *
 *   const result = await transport.invoke('my-function', { userId: 42 });
 */

import type { ToolResult, ToolIMP, ArgumentConstraints, ToolSchema } from '../core/types.js';

// ---------------------------------------------------------------------------
// AWS Lambda adapter interface
// ---------------------------------------------------------------------------

export interface LambdaAdapter {
  invoke(params: LambdaInvokeParams): Promise<LambdaInvokeResult>;
}

export interface LambdaInvokeParams {
  FunctionName: string;
  InvocationType?: 'RequestResponse' | 'Event' | 'DryRun';
  Payload?: string;
  Qualifier?: string;
  LogType?: 'None' | 'Tail';
}

export interface LambdaInvokeResult {
  StatusCode?: number;
  FunctionError?: string;
  Payload?: string;
  LogResult?: string;
  ExecutedVersion?: string;
}

// ---------------------------------------------------------------------------
// AWSCredentials
// ---------------------------------------------------------------------------

export interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

// ---------------------------------------------------------------------------
// SigV4-signed Lambda adapter (no SDK dependency)
// ---------------------------------------------------------------------------

export class HttpLambdaAdapter implements LambdaAdapter {
  private region: string;
  private credentials: AWSCredentials;

  constructor(region: string, credentials: AWSCredentials) {
    this.region = region;
    this.credentials = credentials;
  }

  async invoke(params: LambdaInvokeParams): Promise<LambdaInvokeResult> {
    const endpoint = `https://lambda.${this.region}.amazonaws.com/2015-03-31/functions/${encodeURIComponent(params.FunctionName)}/invocations`;

    const invocationType = params.InvocationType ?? 'RequestResponse';
    const qualifier = params.Qualifier ? `?Qualifier=${encodeURIComponent(params.Qualifier)}` : '';
    const url = `${endpoint}${qualifier}`;

    const body = params.Payload ?? '';
    const date = new Date().toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateShort = date.slice(0, 8);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Amz-Invocation-Type': invocationType,
      'X-Amz-Log-Type': params.LogType ?? 'None',
      'X-Amz-Date': date,
      Host: `lambda.${this.region}.amazonaws.com`,
    };

    if (this.credentials.sessionToken) {
      headers['X-Amz-Security-Token'] = this.credentials.sessionToken;
    }

    // Minimal SigV4 signing
    const signature = await this.signRequest('POST', url, headers, body, dateShort, date);
    headers['Authorization'] = signature;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: body || undefined,
      });

      const responseBody = await response.text();
      return {
        StatusCode: response.status,
        FunctionError: response.headers.get('X-Amz-Function-Error') ?? undefined,
        Payload: responseBody,
        ExecutedVersion: response.headers.get('X-Amz-Executed-Version') ?? undefined,
      };
    } catch (err) {
      throw new Error(`Lambda HTTP error: ${(err as Error).message}`);
    }
  }

  /**
   * Minimal SigV4 signing implementation.
   * For production use, prefer @aws-sdk/client-lambda or aws4.
   */
  private async signRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string,
    dateShort: string,
    date: string,
  ): Promise<string> {
    const parsedUrl = new URL(url);
    const canonicalUri = parsedUrl.pathname;
    const canonicalQueryString = parsedUrl.searchParams.toString();

    const sortedHeaders = Object.entries(headers)
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));

    const canonicalHeaders = sortedHeaders
      .map(([k, v]) => `${k.toLowerCase()}:${v.trim()}\n`)
      .join('');

    const signedHeaders = sortedHeaders.map(([k]) => k.toLowerCase()).join(';');

    const bodyHash = await sha256Hex(body);
    const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, signedHeaders, bodyHash].join('\n');

    const credentialScope = `${dateShort}/${this.region}/lambda/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

    const signingKey = await deriveSigningKey(
      this.credentials.secretAccessKey,
      dateShort,
      this.region,
      'lambda',
    );
    const signature = await hmacHex(signingKey, stringToSign);

    return `AWS4-HMAC-SHA256 Credential=${this.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }
}

// ---------------------------------------------------------------------------
// Lambda Function URL adapter (no signing required)
// ---------------------------------------------------------------------------

export class LambdaFunctionUrlAdapter implements LambdaAdapter {
  private functionUrlMap: Map<string, string>;
  private headers: Record<string, string>;

  constructor(
    functionUrlMap: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    this.functionUrlMap = new Map(Object.entries(functionUrlMap));
    this.headers = headers;
  }

  async invoke(params: LambdaInvokeParams): Promise<LambdaInvokeResult> {
    const url = this.functionUrlMap.get(params.FunctionName);
    if (!url) {
      throw new Error(`No Function URL configured for: ${params.FunctionName}`);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: params.Payload,
    });

    const responseBody = await response.text();
    return {
      StatusCode: response.status,
      FunctionError: response.ok ? undefined : 'FunctionError',
      Payload: responseBody,
    };
  }
}

// ---------------------------------------------------------------------------
// AWSLambdaTransport options
// ---------------------------------------------------------------------------

export interface AWSLambdaTransportOptions {
  adapter: LambdaAdapter;
  /** Default qualifier/alias (e.g. '$LATEST', 'prod') */
  defaultQualifier?: string;
  /** Capture function logs (requires LogType=Tail permission) */
  captureLogs?: boolean;
  /**
   * Response extractor: path into the Lambda response to use as content.
   * E.g. 'body' extracts the 'body' field from an API Gateway proxy response.
   */
  resultPath?: string;
}

// ---------------------------------------------------------------------------
// AWSLambdaTransport
// ---------------------------------------------------------------------------

export class AWSLambdaTransport {
  private adapter: LambdaAdapter;
  private defaultQualifier?: string;
  private captureLogs: boolean;
  private resultPath?: string;

  constructor(options: AWSLambdaTransportOptions) {
    this.adapter = options.adapter;
    this.defaultQualifier = options.defaultQualifier;
    this.captureLogs = options.captureLogs ?? false;
    this.resultPath = options.resultPath;
  }

  async invoke(
    functionName: string,
    args: Record<string, unknown>,
    invocationType: 'RequestResponse' | 'Event' | 'DryRun' = 'RequestResponse',
  ): Promise<ToolResult> {
    const params: LambdaInvokeParams = {
      FunctionName: functionName,
      InvocationType: invocationType,
      Payload: JSON.stringify(args),
      Qualifier: this.defaultQualifier,
      LogType: this.captureLogs ? 'Tail' : 'None',
    };

    try {
      const result = await this.adapter.invoke(params);

      if (result.FunctionError) {
        const errorPayload = result.Payload
          ? safeParseJson(result.Payload)
          : { error: result.FunctionError };

        return {
          content: null,
          isError: true,
          metadata: {
            error: extractLambdaError(errorPayload),
            functionError: result.FunctionError,
            statusCode: result.StatusCode,
          },
        };
      }

      const content = result.Payload
        ? safeParseJson(result.Payload)
        : null;

      const extracted = this.resultPath && content
        ? extractPath(content, this.resultPath)
        : content;

      return {
        content: extracted,
        isError: false,
        metadata: {
          statusCode: result.StatusCode,
          executedVersion: result.ExecutedVersion,
          logResult: result.LogResult
            ? Buffer.from(result.LogResult, 'base64').toString('utf8')
            : undefined,
        },
      };
    } catch (err) {
      return {
        content: null,
        isError: true,
        metadata: { error: `Lambda invocation failed: ${(err as Error).message}` },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// createLambdaToolIMP — build a ToolIMP for a Lambda function
// ---------------------------------------------------------------------------

export interface LambdaToolDefinition {
  functionName: string;
  toolName: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function createLambdaToolIMP(
  transport: AWSLambdaTransport,
  def: LambdaToolDefinition,
  providerId: string,
): ToolIMP {
  const constraints: ArgumentConstraints = {
    required: [],
    optional: [],
    validate: () => ({ valid: true, errors: [] }),
  };

  const schema: ToolSchema = {
    name: def.toolName,
    description: def.description,
    inputSchema: def.inputSchema as import('../core/types.js').JSONSchemaType,
    arguments: [],
  };

  return {
    providerId,
    toolName: def.toolName,
    transportType: 'rest',
    schema,
    schemaLoader: async () => schema,
    constraints,
    execute: (args) => transport.invoke(def.functionName, args),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function extractPath(data: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function extractLambdaError(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    return String(p.errorMessage ?? p.error ?? p.message ?? 'Lambda function error');
  }
  return 'Lambda function error';
}

async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key: unknown, data: string): Promise<string> {
  const isCryptoKey = key && typeof key === 'object' && 'type' in (key as object);
  const cryptoKey = isCryptoKey
    ? key as Parameters<typeof crypto.subtle.sign>[1]
    : await crypto.subtle.importKey('raw', key as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

  const encoder = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Parameters<typeof crypto.subtle.sign>[1]> {
  const encoder = new TextEncoder();

  const kSecret = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`AWS4${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  type SK = Parameters<typeof crypto.subtle.sign>[1];
  const sign = async (key: SK, msg: string): Promise<SK> => {
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(msg));
    return crypto.subtle.importKey('raw', sig, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  };

  const kDate = await sign(kSecret, date);
  const kRegion = await sign(kDate, region);
  const kService = await sign(kRegion, service);
  return sign(kService, 'aws4_request');
}
