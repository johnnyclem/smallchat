import Foundation

/// OAuth2 Client Credentials authentication strategy.
///
/// Implements the OAuth2 Client Credentials flow with automatic token
/// caching and refresh before expiry.
public actor OAuth2Auth: AuthStrategy {

    private let clientId: String
    private let clientSecret: String
    private let tokenURL: URL
    private let scopes: [String]
    private let audience: String?
    private let refreshBufferSeconds: TimeInterval

    private var cachedToken: CachedToken?

    private struct CachedToken: Sendable {
        let accessToken: String
        let expiresAt: Date
        let tokenType: String
    }

    public init(
        clientId: String,
        clientSecret: String,
        tokenURL: URL,
        scopes: [String] = [],
        audience: String? = nil,
        refreshBufferSeconds: TimeInterval = 30
    ) {
        self.clientId = clientId
        self.clientSecret = clientSecret
        self.tokenURL = tokenURL
        self.scopes = scopes
        self.audience = audience
        self.refreshBufferSeconds = refreshBufferSeconds
    }

    public nonisolated func authenticate(request: inout TransportInput) async throws {
        let token = try await getAccessToken()
        request.headers["Authorization"] = "\(token.tokenType) \(token.accessToken)"
    }

    public nonisolated func refresh() async throws -> Bool {
        await clearCache()
        _ = try await getAccessToken()
        return true
    }

    /// Check whether the current token is still valid.
    public func isTokenValid() -> Bool {
        guard let cached = cachedToken else { return false }
        return Date() < cached.expiresAt.addingTimeInterval(-refreshBufferSeconds)
    }

    // MARK: - Private

    private func clearCache() {
        cachedToken = nil
    }

    private func getAccessToken() async throws -> CachedToken {
        if let cached = cachedToken,
           Date() < cached.expiresAt.addingTimeInterval(-refreshBufferSeconds) {
            return cached
        }

        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "grant_type", value: "client_credentials"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "client_secret", value: clientSecret),
        ]
        if !scopes.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "scope", value: scopes.joined(separator: " ")))
        }
        if let audience {
            components.queryItems?.append(URLQueryItem(name: "audience", value: audience))
        }

        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = components.query?.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw TransportError.connectionFailed(message: "OAuth2 token request: invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "unknown error"
            throw TransportError.connectionFailed(
                message: "OAuth2 token request failed (\(httpResponse.statusCode)): \(body)"
            )
        }

        struct TokenResponse: Decodable {
            let access_token: String
            let expires_in: Int
            let token_type: String?
        }

        let tokenResponse = try JSONDecoder().decode(TokenResponse.self, from: data)

        let cached = CachedToken(
            accessToken: tokenResponse.access_token,
            expiresAt: Date().addingTimeInterval(TimeInterval(tokenResponse.expires_in)),
            tokenType: tokenResponse.token_type ?? "Bearer"
        )

        self.cachedToken = cached
        return cached
    }
}
