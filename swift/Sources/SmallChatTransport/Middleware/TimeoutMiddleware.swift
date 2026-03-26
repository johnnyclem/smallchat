import Foundation

/// Timeout middleware that wraps transport execution with a configurable deadline.
///
/// Uses `withThrowingTaskGroup` to race the operation against a timeout task.
/// Mirrors the TypeScript `withTimeout` function.
public struct TimeoutMiddleware: Sendable {

    /// Default timeout in seconds.
    public let timeout: TimeInterval

    public init(timeout: TimeInterval = 30) {
        self.timeout = timeout
    }

    /// Execute an async operation with a timeout.
    ///
    /// - Parameters:
    ///   - duration: Override the default timeout (in seconds). Pass `nil` to use the default.
    ///   - operation: The async operation to execute.
    /// - Returns: The result if the operation completes within the timeout.
    /// - Throws: `TransportError.timeout` if the deadline is exceeded.
    public func execute<T: Sendable>(
        timeout duration: TimeInterval? = nil,
        _ operation: @Sendable () async throws -> T
    ) async throws -> T {
        let effectiveTimeout = duration ?? self.timeout
        let timeoutNanoseconds = UInt64(effectiveTimeout * 1_000_000_000)

        return try await withThrowingTaskGroup(of: T.self) { group in
            // The actual operation
            group.addTask {
                try await operation()
            }

            // The timeout task
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                throw TransportError.timeout(durationMs: Int(effectiveTimeout * 1000))
            }

            // Return whichever finishes first
            guard let result = try await group.next() else {
                throw TransportError.timeout(durationMs: Int(effectiveTimeout * 1000))
            }
            // Cancel the other task
            group.cancelAll()
            return result
        }
    }
}
