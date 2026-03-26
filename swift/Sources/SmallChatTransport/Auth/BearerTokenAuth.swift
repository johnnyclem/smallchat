import Foundation

/// Bearer token authentication strategy.
///
/// Injects a static Bearer token into the Authorization header.
/// Thread-safe via actor isolation for token mutation.
public actor BearerTokenAuth: AuthStrategy {

    private var token: String

    public init(token: String) {
        self.token = token
    }

    public nonisolated func authenticate(request: inout TransportInput) async throws {
        let currentToken = await getToken()
        request.headers["Authorization"] = "Bearer \(currentToken)"
    }

    public nonisolated func refresh() async throws -> Bool {
        // Static tokens don't refresh automatically.
        return false
    }

    /// Update the token (e.g., after external refresh).
    public func setToken(_ newToken: String) {
        self.token = newToken
    }

    /// Get the current token.
    public func getToken() -> String {
        token
    }
}
