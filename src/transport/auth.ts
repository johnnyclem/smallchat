/**
 * Auth Strategies — Bearer Token and OAuth2 Client Credentials.
 *
 * Implements the AuthStrategy interface to inject credentials into
 * outgoing HTTP requests. OAuth2 handles automatic token refresh.
 */

import type { AuthStrategy, BearerTokenConfig, OAuth2ClientCredentialsConfig } from './types.js';

// ---------------------------------------------------------------------------
// Bearer Token
// ---------------------------------------------------------------------------

/**
 * BearerTokenAuth — injects a static Bearer token into the Authorization header.
 */
export class BearerTokenAuth implements AuthStrategy {
  private token: string;

  constructor(config: BearerTokenConfig) {
    this.token = config.token;
  }

  async apply(headers: Record<string, string>): Promise<void> {
    headers['Authorization'] = `Bearer ${this.token}`;
  }

  /** Update the token (e.g., after external refresh) */
  setToken(token: string): void {
    this.token = token;
  }

  getToken(): string {
    return this.token;
  }
}

// ---------------------------------------------------------------------------
// OAuth2 Client Credentials
// ---------------------------------------------------------------------------

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  tokenType: string;
}

/**
 * OAuth2ClientCredentialsAuth — implements the OAuth2 Client Credentials flow.
 *
 * Automatically fetches and caches access tokens, refreshing them before expiry.
 */
export class OAuth2ClientCredentialsAuth implements AuthStrategy {
  private config: OAuth2ClientCredentialsConfig;
  private cachedToken: CachedToken | null = null;
  /** Buffer in ms before actual expiry to trigger refresh (default: 30s) */
  private refreshBufferMs: number;

  constructor(config: OAuth2ClientCredentialsConfig, refreshBufferMs = 30_000) {
    this.config = config;
    this.refreshBufferMs = refreshBufferMs;
  }

  async apply(headers: Record<string, string>): Promise<void> {
    const token = await this.getAccessToken();
    headers['Authorization'] = `${token.tokenType} ${token.accessToken}`;
  }

  async refresh(): Promise<void> {
    this.cachedToken = null;
    await this.getAccessToken();
  }

  private async getAccessToken(): Promise<CachedToken> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - this.refreshBufferMs) {
      return this.cachedToken;
    }

    const params = new URLSearchParams();
    params.set('grant_type', 'client_credentials');
    params.set('client_id', this.config.clientId);
    params.set('client_secret', this.config.clientSecret);

    if (this.config.scopes?.length) {
      params.set('scope', this.config.scopes.join(' '));
    }
    if (this.config.audience) {
      params.set('audience', this.config.audience);
    }

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => 'unknown error');
      throw new Error(`OAuth2 token request failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      token_type?: string;
    };

    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      tokenType: data.token_type ?? 'Bearer',
    };

    return this.cachedToken;
  }

  /** Check whether the current token is still valid */
  isTokenValid(): boolean {
    return this.cachedToken != null && Date.now() < this.cachedToken.expiresAt - this.refreshBufferMs;
  }
}
