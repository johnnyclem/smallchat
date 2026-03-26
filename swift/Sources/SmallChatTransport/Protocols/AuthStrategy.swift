import Foundation

/// Protocol for authentication strategies that inject credentials into requests.
///
/// Mirrors the TypeScript `AuthStrategy` interface.
public protocol AuthStrategy: Sendable {

    /// Apply authentication to a request by mutating its headers or other fields.
    func authenticate(request: inout TransportInput) async throws

    /// Attempt to refresh credentials (e.g., token refresh).
    /// Returns `true` if credentials were successfully refreshed.
    func refresh() async throws -> Bool
}

// MARK: - Default Implementation

extension AuthStrategy {
    /// Default: refresh is not supported.
    public func refresh() async throws -> Bool { false }
}
