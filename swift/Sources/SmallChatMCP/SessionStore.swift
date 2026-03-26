// MARK: - SessionStore — Actor + SQLite session persistence

import Foundation
import SQLite

// MARK: - MCPSession

/// Represents a single MCP client session.
public struct MCPSession: Sendable, Codable {
    public let id: String
    public let createdAt: String
    public var lastActivityAt: String
    public let protocolVersion: String
    public let clientInfo: [String: String]
    public var metadata: [String: String]
    public var status: SessionStatus

    public init(
        id: String,
        createdAt: String,
        lastActivityAt: String,
        protocolVersion: String,
        clientInfo: [String: String] = [:],
        metadata: [String: String] = [:],
        status: SessionStatus = .active
    ) {
        self.id = id
        self.createdAt = createdAt
        self.lastActivityAt = lastActivityAt
        self.protocolVersion = protocolVersion
        self.clientInfo = clientInfo
        self.metadata = metadata
        self.status = status
    }
}

// MARK: - SessionStore Actor

/// SQLite-backed session persistence for MCP.
/// Sessions survive server restarts and can be resumed by ID.
public actor SessionStore {

    private let db: Connection
    private let sessions = Table("mcp_sessions")

    // Column definitions
    private let colId = SQLite.Expression<String>("id")
    private let colCreatedAt = SQLite.Expression<String>("created_at")
    private let colLastActivityAt = SQLite.Expression<String>("last_activity_at")
    private let colProtocolVersion = SQLite.Expression<String>("protocol_version")
    private let colClientInfo = SQLite.Expression<String>("client_info")
    private let colMetadata = SQLite.Expression<String>("metadata")
    private let colStatus = SQLite.Expression<String>("status")

    /// Initialize with a path to the SQLite database file.
    /// Pass `:memory:` for an in-memory database (useful for tests).
    public init(dbPath: String = "smallchat.db") throws {
        self.db = try Connection(dbPath)
        try db.execute("PRAGMA journal_mode = WAL")
        try initSchema()
    }

    private func initSchema() throws {
        try db.run(sessions.create(ifNotExists: true) { t in
            t.column(colId, primaryKey: true)
            t.column(colCreatedAt)
            t.column(colLastActivityAt)
            t.column(colProtocolVersion, defaultValue: "2024-11-05")
            t.column(colClientInfo, defaultValue: "{}")
            t.column(colMetadata, defaultValue: "{}")
            t.column(colStatus, defaultValue: "active")
        })
    }

    // MARK: - CRUD Operations

    /// Create a new session, returning it.
    public func create(
        protocolVersion: String = "2024-11-05",
        clientInfo: [String: String] = [:],
        metadata: [String: String] = [:]
    ) throws -> MCPSession {
        let now = ISO8601DateFormatter().string(from: Date())
        let sessionId = UUID().uuidString.lowercased()

        let clientInfoJSON = try encodeJSON(clientInfo)
        let metadataJSON = try encodeJSON(metadata)

        try db.run(sessions.insert(
            colId <- sessionId,
            colCreatedAt <- now,
            colLastActivityAt <- now,
            colProtocolVersion <- protocolVersion,
            colClientInfo <- clientInfoJSON,
            colMetadata <- metadataJSON,
            colStatus <- SessionStatus.active.rawValue
        ))

        return MCPSession(
            id: sessionId,
            createdAt: now,
            lastActivityAt: now,
            protocolVersion: protocolVersion,
            clientInfo: clientInfo,
            metadata: metadata,
            status: .active
        )
    }

    /// Get a session by ID, or nil if not found.
    public func get(_ id: String) throws -> MCPSession? {
        let query = sessions.filter(colId == id)
        guard let row = try db.pluck(query) else { return nil }
        return try rowToSession(row)
    }

    /// Touch a session's last-activity timestamp.
    public func touch(_ id: String) throws {
        let now = ISO8601DateFormatter().string(from: Date())
        let query = sessions.filter(colId == id)
        try db.run(query.update(colLastActivityAt <- now))
    }

    /// Update session metadata by merging new values.
    public func updateMetadata(_ id: String, metadata: [String: String]) throws {
        guard var session = try get(id) else { return }
        for (k, v) in metadata {
            session.metadata[k] = v
        }
        let now = ISO8601DateFormatter().string(from: Date())
        let metadataJSON = try encodeJSON(session.metadata)
        let query = sessions.filter(colId == id)
        try db.run(query.update(
            colMetadata <- metadataJSON,
            colLastActivityAt <- now
        ))
    }

    /// Close a session (set status to closed).
    public func close(_ id: String) throws {
        let query = sessions.filter(colId == id)
        try db.run(query.update(colStatus <- SessionStatus.closed.rawValue))
    }

    /// Delete a session. Returns true if a row was deleted.
    @discardableResult
    public func delete(_ id: String) throws -> Bool {
        let query = sessions.filter(colId == id)
        let changes = try db.run(query.delete())
        return changes > 0
    }

    /// List all sessions, optionally filtering by maximum age.
    public func list(maxAgeMs: Int? = nil) throws -> [MCPSession] {
        var query = sessions.order(colLastActivityAt.desc)
        if let maxAgeMs {
            let cutoff = ISO8601DateFormatter().string(
                from: Date(timeIntervalSinceNow: -Double(maxAgeMs) / 1000.0)
            )
            query = query.filter(colLastActivityAt >= cutoff)
        }
        return try db.prepare(query).map { try rowToSession($0) }
    }

    /// Prune sessions older than maxAgeMs. Returns the number pruned.
    @discardableResult
    public func prune(maxAgeMs: Int) throws -> Int {
        let cutoff = ISO8601DateFormatter().string(
            from: Date(timeIntervalSinceNow: -Double(maxAgeMs) / 1000.0)
        )
        let old = sessions.filter(colLastActivityAt < cutoff)
        return try db.run(old.delete())
    }

    /// Count active sessions.
    public func count() throws -> Int {
        try db.scalar(sessions.filter(colStatus == SessionStatus.active.rawValue).count)
    }

    // MARK: - Session Resume

    /// Attempt to resume a session. Returns the session, or a status string.
    public func resume(_ id: String) throws -> SessionResumeResult {
        guard let session = try get(id) else {
            return .notFound
        }
        if session.status == .closed {
            return .closed
        }
        // Check if expired (24h default)
        let formatter = ISO8601DateFormatter()
        if let lastSeen = formatter.date(from: session.lastActivityAt) {
            let elapsed = Date().timeIntervalSince(lastSeen)
            if elapsed > 86400 { // 24 hours
                try close(id)
                return .expired
            }
        }
        try touch(id)
        return .resumed(session)
    }

    // MARK: - Helpers

    private func rowToSession(_ row: Row) throws -> MCPSession {
        let clientInfoStr = row[colClientInfo]
        let metadataStr = row[colMetadata]
        let statusStr = row[colStatus]

        let clientInfo = try decodeJSON(clientInfoStr)
        let metadata = try decodeJSON(metadataStr)

        return MCPSession(
            id: row[colId],
            createdAt: row[colCreatedAt],
            lastActivityAt: row[colLastActivityAt],
            protocolVersion: row[colProtocolVersion],
            clientInfo: clientInfo,
            metadata: metadata,
            status: SessionStatus(rawValue: statusStr) ?? .active
        )
    }

    private func encodeJSON(_ dict: [String: String]) throws -> String {
        let data = try JSONEncoder().encode(dict)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func decodeJSON(_ str: String) throws -> [String: String] {
        guard let data = str.data(using: .utf8) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }
}

// MARK: - Session Resume Result

/// The result of attempting to resume a session.
public enum SessionResumeResult: Sendable {
    case resumed(MCPSession)
    case notFound
    case expired
    case closed
}
