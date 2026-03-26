import Foundation

/// Actor-based connection pool that manages reusable transport connections.
///
/// Implements an acquire/release pattern with configurable pool size.
/// Queues requests when all connections are in use.
///
/// Mirrors the TypeScript `ConnectionPool` class.
public actor ConnectionPool {

    /// Configuration for the connection pool.
    public struct Config: Sendable {
        /// Maximum concurrent connections per host (default: 10).
        public var maxConnections: Int
        /// Keep-alive timeout in seconds (default: 30).
        public var keepAliveTimeout: TimeInterval
        /// Maximum idle connections to keep (default: 5).
        public var maxIdleConnections: Int

        public init(
            maxConnections: Int = 10,
            keepAliveTimeout: TimeInterval = 30,
            maxIdleConnections: Int = 5
        ) {
            self.maxConnections = maxConnections
            self.keepAliveTimeout = keepAliveTimeout
            self.maxIdleConnections = maxIdleConnections
        }
    }

    private let config: Config
    private var activeConnections: [String: Int] = [:]
    private var waitQueue: [String: [CheckedContinuation<Void, any Error>]] = [:]
    private var disposed: Bool = false

    public init(maxConnections: Int = 10) {
        self.config = Config(maxConnections: maxConnections)
    }

    public init(config: Config) {
        self.config = config
    }

    // MARK: - Acquire / Release

    /// Acquire a connection slot for the given host.
    /// Suspends if the host has reached its connection limit.
    public func acquire(host: String) async throws {
        if disposed {
            throw TransportError.disposed
        }

        let active = activeConnections[host] ?? 0
        if active >= config.maxConnections {
            // Wait for a slot
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                var queue = waitQueue[host] ?? []
                queue.append(continuation)
                waitQueue[host] = queue
            }
        }

        activeConnections[host] = (activeConnections[host] ?? 0) + 1
    }

    /// Release a connection slot for the given host.
    /// Resumes the next waiting acquirer if any.
    public func release(host: String) {
        let active = (activeConnections[host] ?? 1) - 1
        if active <= 0 {
            activeConnections.removeValue(forKey: host)
        } else {
            activeConnections[host] = active
        }

        // Resume next waiter
        if var queue = waitQueue[host], !queue.isEmpty {
            let continuation = queue.removeFirst()
            if queue.isEmpty {
                waitQueue.removeValue(forKey: host)
            } else {
                waitQueue[host] = queue
            }
            continuation.resume()
        }
    }

    /// Execute an operation with automatic acquire/release.
    public func withConnection<T: Sendable>(
        host: String,
        operation: @Sendable () async throws -> T
    ) async throws -> T {
        try await acquire(host: host)
        do {
            let result = try await operation()
            release(host: host)
            return result
        } catch {
            release(host: host)
            throw error
        }
    }

    // MARK: - Statistics

    /// Number of active connections for a host (or total if nil).
    public func getActiveConnections(host: String? = nil) -> Int {
        if let host { return activeConnections[host] ?? 0 }
        return activeConnections.values.reduce(0, +)
    }

    /// Number of queued requests for a host (or total if nil).
    public func getQueuedRequests(host: String? = nil) -> Int {
        if let host { return waitQueue[host]?.count ?? 0 }
        return waitQueue.values.reduce(0) { $0 + $1.count }
    }

    // MARK: - Dispose

    /// Dispose the pool, rejecting all queued waiters.
    public func dispose() {
        disposed = true
        for (_, queue) in waitQueue {
            for continuation in queue {
                continuation.resume(throwing: TransportError.disposed)
            }
        }
        waitQueue.removeAll()
        activeConnections.removeAll()
    }
}

// MARK: - Host Extraction

extension ConnectionPool {
    /// Extract the host (protocol + hostname + port) from a URL string.
    public static func extractHost(from urlString: String) -> String {
        guard let url = URL(string: urlString),
              let scheme = url.scheme,
              let host = url.host else {
            return urlString
        }
        if let port = url.port {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }
}
