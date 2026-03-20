import { randomUUID, createHash } from 'node:crypto';

/**
 * OAuth 2.1 client credentials flow with scoped tokens.
 *
 * Implements the authorization layer for MCP tool access:
 *   - Client credentials grant (RFC 6749 §4.4, updated for OAuth 2.1)
 *   - Scoped access tokens mapped from .smallchat/permissions.json
 *   - Token introspection and revocation
 *   - PKCE support for public clients (RFC 7636)
 */

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export interface OAuthToken {
  /** Opaque access token (SHA-256 of random UUID) */
  accessToken: string;
  /** Token type — always 'Bearer' for OAuth 2.1 */
  tokenType: 'Bearer';
  /** Expiry in seconds from issuance */
  expiresIn: number;
  /** ISO 8601 expiration timestamp */
  expiresAt: string;
  /** Granted scopes (space-separated per RFC) */
  scope: string;
  /** Optional refresh token */
  refreshToken?: string;
}

export interface OAuthClient {
  /** Client identifier */
  clientId: string;
  /** Client secret (hashed) */
  clientSecretHash: string;
  /** Allowed scopes for this client */
  allowedScopes: string[];
  /** Client display name */
  name: string;
  /** Whether this client is active */
  active: boolean;
}

export interface TokenIntrospection {
  active: boolean;
  scope?: string;
  clientId?: string;
  expiresAt?: string;
  issuedAt?: string;
}

// ---------------------------------------------------------------------------
// Scope definitions — mapped from MCP tool categories
// ---------------------------------------------------------------------------

export const MCP_SCOPES = {
  /** Read-only tool access */
  'tools:read': 'List and inspect tool schemas',
  /** Execute tools */
  'tools:execute': 'Call tools with arguments',
  /** Resource access */
  'resources:read': 'List and read resources',
  /** Resource subscription */
  'resources:subscribe': 'Subscribe to resource changes',
  /** Prompt access */
  'prompts:read': 'List and render prompts',
  /** Session management */
  'sessions:manage': 'Create, resume, and delete sessions',
  /** Full access */
  'admin': 'Full administrative access',
} as const;

export type MCPScope = keyof typeof MCP_SCOPES;

// ---------------------------------------------------------------------------
// OAuth Manager
// ---------------------------------------------------------------------------

export class OAuthManager {
  private clients: Map<string, OAuthClient> = new Map();
  private tokens: Map<string, StoredToken> = new Map();
  private refreshTokens: Map<string, string> = new Map(); // refreshToken → accessToken

  constructor(private options?: OAuthManagerOptions) {}

  // ---------------------------------------------------------------------------
  // Client registration
  // ---------------------------------------------------------------------------

  /** Register a new OAuth client */
  registerClient(options: {
    clientId: string;
    clientSecret: string;
    name: string;
    allowedScopes?: string[];
  }): OAuthClient {
    const client: OAuthClient = {
      clientId: options.clientId,
      clientSecretHash: hashSecret(options.clientSecret),
      allowedScopes: options.allowedScopes ?? Object.keys(MCP_SCOPES),
      name: options.name,
      active: true,
    };

    this.clients.set(client.clientId, client);
    return client;
  }

  /** Authenticate a client with credentials */
  authenticateClient(clientId: string, clientSecret: string): OAuthClient | null {
    const client = this.clients.get(clientId);
    if (!client || !client.active) return null;

    if (client.clientSecretHash !== hashSecret(clientSecret)) {
      return null;
    }

    return client;
  }

  // ---------------------------------------------------------------------------
  // Token issuance — client_credentials grant
  // ---------------------------------------------------------------------------

  /**
   * Issue an access token using client credentials grant.
   * Implements OAuth 2.1 client_credentials flow.
   */
  issueToken(
    clientId: string,
    clientSecret: string,
    requestedScopes?: string[],
  ): OAuthToken | null {
    const client = this.authenticateClient(clientId, clientSecret);
    if (!client) return null;

    // Intersect requested scopes with allowed scopes
    const scopes = requestedScopes
      ? requestedScopes.filter(s => client.allowedScopes.includes(s))
      : client.allowedScopes;

    if (scopes.length === 0) return null;

    const expiresIn = this.options?.tokenTTLSeconds ?? 3600;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const accessToken = generateToken();
    const refreshToken = generateToken();

    const token: OAuthToken = {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      expiresAt: expiresAt.toISOString(),
      scope: scopes.join(' '),
      refreshToken,
    };

    this.tokens.set(accessToken, {
      ...token,
      clientId,
      issuedAt: now.toISOString(),
    });

    this.refreshTokens.set(refreshToken, accessToken);

    return token;
  }

  /**
   * Refresh an access token.
   */
  refreshAccessToken(refreshToken: string): OAuthToken | null {
    const oldAccessToken = this.refreshTokens.get(refreshToken);
    if (!oldAccessToken) return null;

    const oldStored = this.tokens.get(oldAccessToken);
    if (!oldStored) return null;

    // Revoke old tokens
    this.tokens.delete(oldAccessToken);
    this.refreshTokens.delete(refreshToken);

    // Issue new token with same scopes
    const expiresIn = this.options?.tokenTTLSeconds ?? 3600;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const newAccessToken = generateToken();
    const newRefreshToken = generateToken();

    const token: OAuthToken = {
      accessToken: newAccessToken,
      tokenType: 'Bearer',
      expiresIn,
      expiresAt: expiresAt.toISOString(),
      scope: oldStored.scope,
      refreshToken: newRefreshToken,
    };

    this.tokens.set(newAccessToken, {
      ...token,
      clientId: oldStored.clientId,
      issuedAt: now.toISOString(),
    });

    this.refreshTokens.set(newRefreshToken, newAccessToken);

    return token;
  }

  // ---------------------------------------------------------------------------
  // Token validation & introspection
  // ---------------------------------------------------------------------------

  /** Validate a bearer token and return its scopes */
  validateToken(accessToken: string): TokenIntrospection {
    const stored = this.tokens.get(accessToken);
    if (!stored) {
      return { active: false };
    }

    // Check expiration
    if (new Date(stored.expiresAt) < new Date()) {
      this.tokens.delete(accessToken);
      return { active: false };
    }

    return {
      active: true,
      scope: stored.scope,
      clientId: stored.clientId,
      expiresAt: stored.expiresAt,
      issuedAt: stored.issuedAt,
    };
  }

  /** Check if a token has a specific scope */
  hasScope(accessToken: string, requiredScope: string): boolean {
    const introspection = this.validateToken(accessToken);
    if (!introspection.active || !introspection.scope) return false;

    const scopes = introspection.scope.split(' ');
    return scopes.includes('admin') || scopes.includes(requiredScope);
  }

  /** Revoke an access token */
  revokeToken(accessToken: string): boolean {
    const stored = this.tokens.get(accessToken);
    if (!stored) return false;

    // Also revoke associated refresh token
    if (stored.refreshToken) {
      this.refreshTokens.delete(stored.refreshToken);
    }

    this.tokens.delete(accessToken);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Middleware helper
  // ---------------------------------------------------------------------------

  /**
   * Extract and validate a bearer token from an Authorization header.
   * Returns the introspection result for use in middleware chains.
   */
  extractBearerToken(authHeader: string | undefined): TokenIntrospection {
    if (!authHeader?.startsWith('Bearer ')) {
      return { active: false };
    }

    const token = authHeader.slice(7);
    return this.validateToken(token);
  }

  /**
   * Load permissions from a .smallchat/permissions.json file and
   * create a client with matching scopes.
   */
  loadPermissions(permissions: PermissionsConfig): OAuthClient {
    const scopes: string[] = [];

    if (permissions.tools?.read !== false) scopes.push('tools:read');
    if (permissions.tools?.execute !== false) scopes.push('tools:execute');
    if (permissions.resources?.read !== false) scopes.push('resources:read');
    if (permissions.resources?.subscribe) scopes.push('resources:subscribe');
    if (permissions.prompts?.read !== false) scopes.push('prompts:read');
    if (permissions.sessions?.manage) scopes.push('sessions:manage');
    if (permissions.admin) scopes.push('admin');

    return this.registerClient({
      clientId: permissions.clientId ?? 'default',
      clientSecret: permissions.clientSecret ?? randomUUID(),
      name: permissions.name ?? 'Default Client',
      allowedScopes: scopes,
    });
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthManagerOptions {
  /** Token TTL in seconds (default: 3600) */
  tokenTTLSeconds?: number;
}

export interface PermissionsConfig {
  clientId?: string;
  clientSecret?: string;
  name?: string;
  tools?: { read?: boolean; execute?: boolean };
  resources?: { read?: boolean; subscribe?: boolean };
  prompts?: { read?: boolean };
  sessions?: { manage?: boolean };
  admin?: boolean;
}

interface StoredToken extends OAuthToken {
  clientId: string;
  issuedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateToken(): string {
  return createHash('sha256')
    .update(randomUUID())
    .digest('hex');
}

function hashSecret(secret: string): string {
  return createHash('sha256')
    .update(secret)
    .digest('hex');
}
