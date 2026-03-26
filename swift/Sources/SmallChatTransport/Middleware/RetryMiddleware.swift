import Foundation

/// Retry middleware that wraps transport execution with exponential backoff.
///
/// Mirrors the TypeScript `withRetry` function.
public struct RetryMiddleware: Sendable {

    private let config: RetryConfig

    public init(config: RetryConfig = RetryConfig()) {
        self.config = config
    }

    /// Execute an async operation with retry and exponential backoff.
    ///
    /// - Parameters:
    ///   - operation: A closure that takes the attempt number (0-based) and returns a result.
    /// - Returns: The result of the first successful invocation.
    /// - Throws: The last error if all attempts are exhausted.
    public func execute<T: Sendable>(
        _ operation: @Sendable (Int) async throws -> T
    ) async throws -> T {
        var lastError: (any Error)?

        for attempt in 0...config.maxRetries {
            do {
                return try await operation(attempt)
            } catch {
                lastError = error

                // Don't retry on the last attempt or non-retryable errors
                if attempt >= config.maxRetries || !isRetryable(error) {
                    throw error
                }

                let delay = calculateDelay(attempt: attempt)
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            }
        }

        throw lastError ?? TransportError.unknown(message: "Retry exhausted with no error")
    }

    // MARK: - Delay Calculation

    /// Calculate exponential backoff delay with jitter for a given attempt.
    public func calculateDelay(attempt: Int) -> TimeInterval {
        // Exponential backoff: base * 2^attempt
        let exponentialDelay = config.baseDelay * pow(2.0, Double(attempt))

        // Cap at maxDelay
        let cappedDelay = min(exponentialDelay, config.maxDelay)

        // Add jitter: +/- jitter% of the delay
        let jitterRange = cappedDelay * config.jitter
        let jitterOffset = (Double.random(in: -1...1)) * jitterRange

        return max(0, cappedDelay + jitterOffset)
    }

    // MARK: - Retryability Check

    private func isRetryable(_ error: any Error) -> Bool {
        if let transportError = error as? TransportError {
            return transportError.isRetryable
        }
        // Network-level errors are generally retryable
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain {
            return true
        }
        return false
    }
}
