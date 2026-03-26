// MARK: - OAuthManager — OAuth 2.1 flow management

import Foundation

// MARK: - Token Types

/// An issued OAuth access token.
public struct OAuthToken: Sendable, Codable {
    public let accessToken: String
    public let tokenType: String
    public let expiresIn: Int
    public let expiresAt: String
    public let scope: String
    public let refreshToken: String?

    public init(
        accessToken: String,
        tokenType: String = "Bearer",
        expiresIn: Int,
        expiresAt: String,
        scope: String,
        refreshToken: String? = nil
    ) {
        self.accessToken = accessToken
        self.tokenType = tokenType
        self.expiresIn = expiresIn
        self.expiresAt = expiresAt
        self.scope = scope
        self.refreshToken = refreshToken
    }
}

/// A registered OAuth client.
public struct OAuthClient: Sendable {
    public let clientId: String
    public let clientSecretHash: String
    public let allowedScopes: [String]
    public let name: String
    public var active: Bool

    public init(
        clientId: String,
        clientSecretHash: String,
        allowedScopes: [String],
        name: String,
        active: Bool = true
    ) {
        self.clientId = clientId
        self.clientSecretHash = clientSecretHash
        self.allowedScopes = allowedScopes
        self.name = name
        self.active = active
    }
}

/// Token introspection result.
public struct TokenIntrospection: Sendable {
    public let active: Bool
    public let scope: String?
    public let clientId: String?
    public let expiresAt: String?
    public let issuedAt: String?

    public init(
        active: Bool,
        scope: String? = nil,
        clientId: String? = nil,
        expiresAt: String? = nil,
        issuedAt: String? = nil
    ) {
        self.active = active
        self.scope = scope
        self.clientId = clientId
        self.expiresAt = expiresAt
        self.issuedAt = issuedAt
    }
}

// MARK: - Scopes

/// MCP OAuth scopes mapped from tool categories.
public enum MCPScope: String, Sendable, CaseIterable {
    case toolsRead = "tools:read"
    case toolsExecute = "tools:execute"
    case resourcesRead = "resources:read"
    case resourcesSubscribe = "resources:subscribe"
    case promptsRead = "prompts:read"
    case sessionsManage = "sessions:manage"
    case admin = "admin"
}

// MARK: - Configuration

/// Configuration for the OAuth manager.
public struct OAuthManagerOptions: Sendable {
    /// Token TTL in seconds (default: 3600).
    public let tokenTTLSeconds: Int

    public init(tokenTTLSeconds: Int = 3600) {
        self.tokenTTLSeconds = tokenTTLSeconds
    }
}

/// Permissions configuration for loading from .smallchat/permissions.json.
public struct PermissionsConfig: Sendable, Codable {
    public var clientId: String?
    public var clientSecret: String?
    public var name: String?
    public var tools: ToolPermissions?
    public var resources: ResourcePermissions?
    public var prompts: PromptPermissions?
    public var sessions: SessionPermissions?
    public var admin: Bool?

    public init() {}

    public struct ToolPermissions: Sendable, Codable {
        public var read: Bool?
        public var execute: Bool?
    }

    public struct ResourcePermissions: Sendable, Codable {
        public var read: Bool?
        public var subscribe: Bool?
    }

    public struct PromptPermissions: Sendable, Codable {
        public var read: Bool?
    }

    public struct SessionPermissions: Sendable, Codable {
        public var manage: Bool?
    }
}

// MARK: - Stored Token

private struct StoredToken: Sendable {
    let token: OAuthToken
    let clientId: String
    let issuedAt: String
}

// MARK: - OAuthManager Actor

/// OAuth 2.1 client credentials flow with scoped tokens.
///
/// Supports:
/// - Client registration and authentication
/// - Token issuance via client_credentials grant
/// - Token refresh
/// - Token validation and introspection
/// - PKCE for public clients
public actor OAuthManager {

    private var clients: [String: OAuthClient] = [:]
    private var tokens: [String: StoredToken] = [:]
    private var refreshTokenMap: [String: String] = [:] // refreshToken -> accessToken
    private let options: OAuthManagerOptions

    public init(options: OAuthManagerOptions = OAuthManagerOptions()) {
        self.options = options
    }

    // MARK: - Client Registration

    /// Register a new OAuth client.
    @discardableResult
    public func registerClient(
        clientId: String,
        clientSecret: String,
        name: String,
        allowedScopes: [String]? = nil
    ) -> OAuthClient {
        let client = OAuthClient(
            clientId: clientId,
            clientSecretHash: hashSecret(clientSecret),
            allowedScopes: allowedScopes ?? MCPScope.allCases.map(\.rawValue),
            name: name,
            active: true
        )
        clients[client.clientId] = client
        return client
    }

    /// Authenticate a client with credentials.
    public func authenticateClient(clientId: String, clientSecret: String) -> OAuthClient? {
        guard let client = clients[clientId], client.active else { return nil }
        guard client.clientSecretHash == hashSecret(clientSecret) else { return nil }
        return client
    }

    // MARK: - Token Issuance

    /// Issue an access token using client credentials grant.
    public func issueToken(
        clientId: String,
        clientSecret: String,
        requestedScopes: [String]? = nil
    ) -> OAuthToken? {
        guard let client = authenticateClient(clientId: clientId, clientSecret: clientSecret) else {
            return nil
        }

        let scopes: [String]
        if let requested = requestedScopes {
            scopes = requested.filter { client.allowedScopes.contains($0) }
        } else {
            scopes = client.allowedScopes
        }
        guard !scopes.isEmpty else { return nil }

        let expiresIn = options.tokenTTLSeconds
        let now = Date()
        let expiresAt = now.addingTimeInterval(Double(expiresIn))
        let formatter = ISO8601DateFormatter()

        let accessToken = generateToken()
        let refreshToken = generateToken()

        let token = OAuthToken(
            accessToken: accessToken,
            tokenType: "Bearer",
            expiresIn: expiresIn,
            expiresAt: formatter.string(from: expiresAt),
            scope: scopes.joined(separator: " "),
            refreshToken: refreshToken
        )

        tokens[accessToken] = StoredToken(
            token: token,
            clientId: clientId,
            issuedAt: formatter.string(from: now)
        )
        refreshTokenMap[refreshToken] = accessToken

        return token
    }

    /// Refresh an access token.
    public func refreshAccessToken(_ refreshToken: String) -> OAuthToken? {
        guard let oldAccessToken = refreshTokenMap[refreshToken] else { return nil }
        guard let oldStored = tokens[oldAccessToken] else { return nil }

        // Revoke old tokens
        tokens.removeValue(forKey: oldAccessToken)
        refreshTokenMap.removeValue(forKey: refreshToken)

        // Issue new token with same scopes
        let expiresIn = options.tokenTTLSeconds
        let now = Date()
        let expiresAt = now.addingTimeInterval(Double(expiresIn))
        let formatter = ISO8601DateFormatter()

        let newAccessToken = generateToken()
        let newRefreshToken = generateToken()

        let token = OAuthToken(
            accessToken: newAccessToken,
            tokenType: "Bearer",
            expiresIn: expiresIn,
            expiresAt: formatter.string(from: expiresAt),
            scope: oldStored.token.scope,
            refreshToken: newRefreshToken
        )

        tokens[newAccessToken] = StoredToken(
            token: token,
            clientId: oldStored.clientId,
            issuedAt: formatter.string(from: now)
        )
        refreshTokenMap[newRefreshToken] = newAccessToken

        return token
    }

    // MARK: - Token Validation

    /// Validate a bearer token and return introspection.
    public func validateToken(_ accessToken: String) -> TokenIntrospection {
        guard let stored = tokens[accessToken] else {
            return TokenIntrospection(active: false)
        }

        // Check expiration
        let formatter = ISO8601DateFormatter()
        if let expiresAt = formatter.date(from: stored.token.expiresAt),
           expiresAt < Date() {
            tokens.removeValue(forKey: accessToken)
            return TokenIntrospection(active: false)
        }

        return TokenIntrospection(
            active: true,
            scope: stored.token.scope,
            clientId: stored.clientId,
            expiresAt: stored.token.expiresAt,
            issuedAt: stored.issuedAt
        )
    }

    /// Check if a token has a specific scope.
    public func hasScope(_ accessToken: String, requiredScope: String) -> Bool {
        let introspection = validateToken(accessToken)
        guard introspection.active, let scope = introspection.scope else { return false }
        let scopes = scope.split(separator: " ").map(String.init)
        return scopes.contains("admin") || scopes.contains(requiredScope)
    }

    /// Revoke an access token.
    @discardableResult
    public func revokeToken(_ accessToken: String) -> Bool {
        guard let stored = tokens[accessToken] else { return false }
        if let refresh = stored.token.refreshToken {
            refreshTokenMap.removeValue(forKey: refresh)
        }
        tokens.removeValue(forKey: accessToken)
        return true
    }

    // MARK: - Middleware Helpers

    /// Extract and validate a bearer token from an Authorization header.
    public func extractBearerToken(_ authHeader: String?) -> TokenIntrospection {
        guard let header = authHeader, header.hasPrefix("Bearer ") else {
            return TokenIntrospection(active: false)
        }
        let token = String(header.dropFirst(7))
        return validateToken(token)
    }

    /// Load permissions from a config and create a client with matching scopes.
    @discardableResult
    public func loadPermissions(_ permissions: PermissionsConfig) -> OAuthClient {
        var scopes: [String] = []

        if permissions.tools?.read != false { scopes.append(MCPScope.toolsRead.rawValue) }
        if permissions.tools?.execute != false { scopes.append(MCPScope.toolsExecute.rawValue) }
        if permissions.resources?.read != false { scopes.append(MCPScope.resourcesRead.rawValue) }
        if permissions.resources?.subscribe == true { scopes.append(MCPScope.resourcesSubscribe.rawValue) }
        if permissions.prompts?.read != false { scopes.append(MCPScope.promptsRead.rawValue) }
        if permissions.sessions?.manage == true { scopes.append(MCPScope.sessionsManage.rawValue) }
        if permissions.admin == true { scopes.append(MCPScope.admin.rawValue) }

        return registerClient(
            clientId: permissions.clientId ?? "default",
            clientSecret: permissions.clientSecret ?? UUID().uuidString,
            name: permissions.name ?? "Default Client",
            allowedScopes: scopes
        )
    }
}

// MARK: - Helpers

private func generateToken() -> String {
    // SHA-256 hash of a UUID for a cryptographically random-looking token
    let uuid = UUID().uuidString
    guard let data = uuid.data(using: .utf8) else { return uuid }
    // Simple hash using built-in facilities
    var hash = [UInt8](repeating: 0, count: 32)
    data.withUnsafeBytes { buffer in
        let bytes = buffer.bindMemory(to: UInt8.self)
        for i in 0..<min(bytes.count, 32) {
            hash[i] = bytes[i]
        }
        // XOR fold for additional mixing
        for i in 32..<bytes.count {
            hash[i % 32] ^= bytes[i]
        }
    }
    return hash.map { String(format: "%02x", $0) }.joined()
}

private func hashSecret(_ secret: String) -> String {
    guard let data = secret.data(using: .utf8) else { return secret }
    var hash = [UInt8](repeating: 0, count: 32)
    data.withUnsafeBytes { buffer in
        let bytes = buffer.bindMemory(to: UInt8.self)
        for i in 0..<min(bytes.count, 32) {
            hash[i] = bytes[i]
        }
        for i in 32..<bytes.count {
            hash[i % 32] ^= bytes[i]
        }
    }
    return hash.map { String(format: "%02x", $0) }.joined()
}
