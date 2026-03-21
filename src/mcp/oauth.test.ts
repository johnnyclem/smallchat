import { describe, it, expect, beforeEach } from 'vitest';
import { OAuthManager } from './oauth.js';

describe('OAuthManager', () => {
  let oauth: OAuthManager;

  beforeEach(() => {
    oauth = new OAuthManager({ tokenTTLSeconds: 3600 });
  });

  describe('client registration', () => {
    it('registers a client', () => {
      const client = oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test Client',
      });
      expect(client.clientId).toBe('test-client');
      expect(client.name).toBe('Test Client');
      expect(client.active).toBe(true);
    });

    it('authenticates with correct credentials', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
      });
      const client = oauth.authenticateClient('test-client', 'secret123');
      expect(client).not.toBeNull();
      expect(client!.clientId).toBe('test-client');
    });

    it('rejects wrong credentials', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
      });
      expect(oauth.authenticateClient('test-client', 'wrong')).toBeNull();
      expect(oauth.authenticateClient('unknown', 'secret123')).toBeNull();
    });
  });

  describe('token issuance', () => {
    beforeEach(() => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
        allowedScopes: ['tools:read', 'tools:execute'],
      });
    });

    it('issues a token with client credentials', () => {
      const token = oauth.issueToken('test-client', 'secret123');
      expect(token).not.toBeNull();
      expect(token!.accessToken).toBeTruthy();
      expect(token!.tokenType).toBe('Bearer');
      expect(token!.expiresIn).toBe(3600);
      expect(token!.scope).toBe('tools:read tools:execute');
      expect(token!.refreshToken).toBeTruthy();
    });

    it('intersects requested scopes with allowed scopes', () => {
      const token = oauth.issueToken('test-client', 'secret123', ['tools:read', 'admin']);
      expect(token).not.toBeNull();
      expect(token!.scope).toBe('tools:read');
    });

    it('returns null for invalid credentials', () => {
      expect(oauth.issueToken('test-client', 'wrong')).toBeNull();
    });

    it('returns null when no scopes match', () => {
      expect(oauth.issueToken('test-client', 'secret123', ['admin'])).toBeNull();
    });
  });

  describe('token validation', () => {
    it('validates a valid token', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
      });
      const token = oauth.issueToken('test-client', 'secret123')!;
      const introspection = oauth.validateToken(token.accessToken);
      expect(introspection.active).toBe(true);
      expect(introspection.clientId).toBe('test-client');
    });

    it('returns inactive for unknown token', () => {
      expect(oauth.validateToken('unknown-token').active).toBe(false);
    });

    it('checks scope membership', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
        allowedScopes: ['tools:read'],
      });
      const token = oauth.issueToken('test-client', 'secret123')!;
      expect(oauth.hasScope(token.accessToken, 'tools:read')).toBe(true);
      expect(oauth.hasScope(token.accessToken, 'admin')).toBe(false);
    });

    it('admin scope grants access to all scopes', () => {
      oauth.registerClient({
        clientId: 'admin-client',
        clientSecret: 'secret123',
        name: 'Admin',
        allowedScopes: ['admin'],
      });
      const token = oauth.issueToken('admin-client', 'secret123')!;
      expect(oauth.hasScope(token.accessToken, 'tools:read')).toBe(true);
      expect(oauth.hasScope(token.accessToken, 'resources:read')).toBe(true);
    });
  });

  describe('token refresh', () => {
    it('refreshes a token', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
      });
      const original = oauth.issueToken('test-client', 'secret123')!;
      const refreshed = oauth.refreshAccessToken(original.refreshToken!)!;

      expect(refreshed).not.toBeNull();
      expect(refreshed.accessToken).not.toBe(original.accessToken);
      expect(refreshed.refreshToken).not.toBe(original.refreshToken);

      // Old token should be revoked
      expect(oauth.validateToken(original.accessToken).active).toBe(false);
      // New token should be valid
      expect(oauth.validateToken(refreshed.accessToken).active).toBe(true);
    });

    it('returns null for unknown refresh token', () => {
      expect(oauth.refreshAccessToken('unknown')).toBeNull();
    });
  });

  describe('token revocation', () => {
    it('revokes a token', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
      });
      const token = oauth.issueToken('test-client', 'secret123')!;
      expect(oauth.revokeToken(token.accessToken)).toBe(true);
      expect(oauth.validateToken(token.accessToken).active).toBe(false);
    });
  });

  describe('bearer token extraction', () => {
    it('extracts bearer token from Authorization header', () => {
      oauth.registerClient({
        clientId: 'test-client',
        clientSecret: 'secret123',
        name: 'Test',
      });
      const token = oauth.issueToken('test-client', 'secret123')!;
      const result = oauth.extractBearerToken(`Bearer ${token.accessToken}`);
      expect(result.active).toBe(true);
    });

    it('returns inactive for missing header', () => {
      expect(oauth.extractBearerToken(undefined).active).toBe(false);
    });

    it('returns inactive for non-Bearer scheme', () => {
      expect(oauth.extractBearerToken('Basic abc123').active).toBe(false);
    });
  });

  describe('permissions loading', () => {
    it('loads permissions and creates a client', () => {
      const client = oauth.loadPermissions({
        clientId: 'from-permissions',
        clientSecret: 'secret',
        name: 'Permissions Client',
        tools: { read: true, execute: true },
        resources: { read: true },
        prompts: { read: true },
      });

      expect(client.clientId).toBe('from-permissions');
      expect(client.allowedScopes).toContain('tools:read');
      expect(client.allowedScopes).toContain('tools:execute');
      expect(client.allowedScopes).toContain('resources:read');
      expect(client.allowedScopes).toContain('prompts:read');
      expect(client.allowedScopes).not.toContain('admin');
    });
  });
});
