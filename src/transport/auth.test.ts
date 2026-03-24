/**
 * Feature: Authentication Strategies
 *
 * Implements Bearer Token and OAuth2 Client Credentials auth strategies
 * for injecting credentials into outgoing HTTP requests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BearerTokenAuth, OAuth2ClientCredentialsAuth } from './auth.js';

describe('Feature: Bearer Token Authentication', () => {
  describe('Scenario: Apply bearer token to headers', () => {
    it('Given a bearer token, When apply is called, Then the Authorization header is set', async () => {
      const auth = new BearerTokenAuth({ token: 'my-secret-token' });
      const headers: Record<string, string> = {};

      await auth.apply(headers);

      expect(headers['Authorization']).toBe('Bearer my-secret-token');
    });
  });

  describe('Scenario: Get current token', () => {
    it('Given a bearer token auth, When getToken is called, Then the current token is returned', () => {
      const auth = new BearerTokenAuth({ token: 'abc123' });
      expect(auth.getToken()).toBe('abc123');
    });
  });

  describe('Scenario: Update token after external refresh', () => {
    it('Given a bearer token auth, When setToken is called, Then subsequent apply uses the new token', async () => {
      const auth = new BearerTokenAuth({ token: 'old-token' });
      auth.setToken('new-token');

      const headers: Record<string, string> = {};
      await auth.apply(headers);

      expect(headers['Authorization']).toBe('Bearer new-token');
      expect(auth.getToken()).toBe('new-token');
    });
  });

  describe('Scenario: Token overwrites existing Authorization header', () => {
    it('Given existing headers, When apply is called, Then the Authorization header is overwritten', async () => {
      const auth = new BearerTokenAuth({ token: 'correct' });
      const headers: Record<string, string> = { 'Authorization': 'Basic old' };

      await auth.apply(headers);

      expect(headers['Authorization']).toBe('Bearer correct');
    });
  });
});

describe('Feature: OAuth2 Client Credentials Authentication', () => {
  describe('Scenario: Fetch and cache access token', () => {
    it('Given valid client credentials, When apply is called, Then it fetches a token and sets the header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'oauth-token-123',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      const headers: Record<string, string> = {};
      await auth.apply(headers);

      expect(headers['Authorization']).toBe('Bearer oauth-token-123');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      vi.unstubAllGlobals();
    });
  });

  describe('Scenario: Cached token is reused', () => {
    it('Given a previously fetched token, When apply is called again within expiry, Then the cached token is used', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'cached-token',
          expires_in: 3600,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      const h1: Record<string, string> = {};
      const h2: Record<string, string> = {};
      await auth.apply(h1);
      await auth.apply(h2);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(h2['Authorization']).toBe('Bearer cached-token');

      vi.unstubAllGlobals();
    });
  });

  describe('Scenario: Token request includes scopes and audience', () => {
    it('Given scopes and audience, When apply is called, Then they are included in the token request', async () => {
      let requestBody = '';
      const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        requestBody = init.body as string;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            access_token: 'tok',
            expires_in: 3600,
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
        scopes: ['read', 'write'],
        audience: 'https://api.example.com',
      });

      await auth.apply({});

      expect(requestBody).toContain('scope=read+write');
      expect(requestBody).toContain('audience=https%3A%2F%2Fapi.example.com');

      vi.unstubAllGlobals();
    });
  });

  describe('Scenario: Token request fails', () => {
    it('Given a failed token request, When apply is called, Then an error is thrown', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('invalid_client'),
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'bad-id',
        clientSecret: 'bad-secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      await expect(auth.apply({})).rejects.toThrow('OAuth2 token request failed (401)');

      vi.unstubAllGlobals();
    });
  });

  describe('Scenario: Manual refresh clears cached token', () => {
    it('Given a cached token, When refresh is called, Then a new token is fetched', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            access_token: `token-${callCount}`,
            expires_in: 3600,
          }),
        });
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      const h1: Record<string, string> = {};
      await auth.apply(h1);
      expect(h1['Authorization']).toBe('Bearer token-1');

      await auth.refresh();

      const h2: Record<string, string> = {};
      await auth.apply(h2);
      expect(h2['Authorization']).toBe('Bearer token-2');

      vi.unstubAllGlobals();
    });
  });

  describe('Scenario: isTokenValid reflects token state', () => {
    it('Given no token fetched yet, When isTokenValid is called, Then it returns false', () => {
      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      expect(auth.isTokenValid()).toBe(false);
    });

    it('Given a valid token, When isTokenValid is called, Then it returns true', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'valid',
          expires_in: 3600,
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      await auth.apply({});
      expect(auth.isTokenValid()).toBe(true);

      vi.unstubAllGlobals();
    });
  });

  describe('Scenario: Default token type is Bearer', () => {
    it('Given a token response without token_type, When apply is called, Then Bearer is used', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'tok',
          expires_in: 3600,
          // No token_type
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const auth = new OAuth2ClientCredentialsAuth({
        clientId: 'id',
        clientSecret: 'secret',
        tokenUrl: 'https://auth.example.com/token',
      });

      const headers: Record<string, string> = {};
      await auth.apply(headers);
      expect(headers['Authorization']).toBe('Bearer tok');

      vi.unstubAllGlobals();
    });
  });
});
