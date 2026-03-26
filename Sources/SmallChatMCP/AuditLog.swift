// MARK: - AuditLog — In-memory ring buffer of MCP request audit entries

import Foundation

// MARK: - Audit Entry

/// A structured log entry for an MCP operation.
public struct AuditEntry: Sendable, Codable {
    public let timestamp: String
    public let method: String
    public let sessionId: String?
    public let clientId: String?
    public let success: Bool
    public let durationMs: Int
    public let error: String?

    public init(
        timestamp: String? = nil,
        method: String,
        sessionId: String? = nil,
        clientId: String? = nil,
        success: Bool,
        durationMs: Int,
        error: String? = nil
    ) {
        self.timestamp = timestamp ?? ISO8601DateFormatter().string(from: Date())
        self.method = method
        self.sessionId = sessionId
        self.clientId = clientId
        self.success = success
        self.durationMs = durationMs
        self.error = error
    }
}

// MARK: - AuditLog Actor

/// In-memory ring buffer of recent MCP request audit entries.
///
/// Capped at maxEntries (default 10,000) to bound memory usage.
/// Supports querying by method, session, success status, and time range.
public actor AuditLog {

    private var entries: [AuditEntry] = []
    private let maxEntries: Int

    /// Initialize with a maximum number of entries to retain.
    public init(maxEntries: Int = 10_000) {
        self.maxEntries = maxEntries
    }

    /// Log a new audit entry.
    public func log(_ entry: AuditEntry) {
        entries.append(entry)
        if entries.count > maxEntries {
            entries = Array(entries.suffix(maxEntries))
        }
    }

    /// Get the most recent entries.
    public func recent(count: Int = 100) -> [AuditEntry] {
        Array(entries.suffix(count))
    }

    /// Get all entries (up to maxEntries).
    public func all() -> [AuditEntry] {
        entries
    }

    /// Get entries filtered by method.
    public func filter(method: String) -> [AuditEntry] {
        entries.filter { $0.method == method }
    }

    /// Get entries filtered by session ID.
    public func filter(sessionId: String) -> [AuditEntry] {
        entries.filter { $0.sessionId == sessionId }
    }

    /// Get entries filtered by success status.
    public func filter(success: Bool) -> [AuditEntry] {
        entries.filter { $0.success == success }
    }

    /// Get entries after a given ISO 8601 timestamp.
    public func filter(after timestamp: String) -> [AuditEntry] {
        entries.filter { $0.timestamp >= timestamp }
    }

    /// Get the total number of logged entries.
    public var count: Int { entries.count }

    /// Clear all entries.
    public func clear() {
        entries.removeAll()
    }
}
