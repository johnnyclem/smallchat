// MARK: - RateLimiter — Sliding-window per-client rate limiting

import Foundation

// MARK: - Rate Window

private struct RateWindow: Sendable {
    var count: Int
    var resetAt: ContinuousClock.Instant
}

// MARK: - RateLimiter Actor

/// Per-client sliding-window rate limiter.
///
/// Each client gets a 60-second window. If the request count exceeds
/// the configured maximum within that window, subsequent requests are rejected.
public actor RateLimiter {

    private var windows: [String: RateWindow] = [:]
    private let maxRequestsPerMinute: Int
    private let windowDuration: Duration

    /// Initialize with a maximum number of requests per minute.
    /// - Parameters:
    ///   - maxRPM: Maximum requests per minute per client (default: 600).
    ///   - windowDuration: Duration of the sliding window (default: 60 seconds).
    public init(maxRPM: Int = 600, windowDuration: Duration = .seconds(60)) {
        self.maxRequestsPerMinute = maxRPM
        self.windowDuration = windowDuration
    }

    /// Check if a request from the given client is allowed.
    /// Returns `true` if allowed, `false` if rate-limited.
    public func check(clientId: String) -> Bool {
        let now = ContinuousClock.now

        if let window = windows[clientId] {
            if now > window.resetAt {
                // Window expired, start a new one
                windows[clientId] = RateWindow(count: 1, resetAt: now + windowDuration)
                return true
            }

            if window.count >= maxRequestsPerMinute {
                return false
            }

            windows[clientId]?.count += 1
            return true
        }

        // First request from this client
        windows[clientId] = RateWindow(count: 1, resetAt: now + windowDuration)
        return true
    }

    /// Reset the rate limit window for a specific client.
    public func reset(clientId: String) {
        windows.removeValue(forKey: clientId)
    }

    /// Reset all rate limit windows.
    public func resetAll() {
        windows.removeAll()
    }

    /// Get the current request count for a client within the active window.
    public func currentCount(clientId: String) -> Int {
        guard let window = windows[clientId] else { return 0 }
        let now = ContinuousClock.now
        if now > window.resetAt { return 0 }
        return window.count
    }

    /// Get the configured maximum requests per minute.
    public var maxRPM: Int { maxRequestsPerMinute }
}
