// MARK: - SSEBroker — Per-session SSE connection management

import Foundation
import NIOCore
import NIOHTTP1

// MARK: - SSE Connection

/// Represents an active SSE connection that can receive events.
public protocol SSEConnection: Sendable {
    /// Write raw SSE data to the connection.
    func write(_ data: String) async throws
    /// Close the SSE connection.
    func close() async
}

// MARK: - Callback-based SSE Connection

/// An SSE connection backed by a simple callback.
public struct CallbackSSEConnection: SSEConnection, Sendable {
    private let _write: @Sendable (String) async throws -> Void
    private let _close: @Sendable () async -> Void

    public init(
        write: @Sendable @escaping (String) async throws -> Void,
        close: @Sendable @escaping () async -> Void
    ) {
        self._write = write
        self._close = close
    }

    public func write(_ data: String) async throws {
        try await _write(data)
    }

    public func close() async {
        await _close()
    }
}

// MARK: - SSEBroker Actor

/// Manages SSE connections per session, with fan-out notification support.
///
/// Wire format per event:
/// ```
/// event: <kind>
/// data: <JSON envelope>
/// id: <monotonic seq>
///
/// ```
public actor SSEBroker {

    private var streams: [String: [any SSEConnection]] = [:]
    private var seqMap: [String: Int] = [:]
    private var keepAliveTimers: [String: Bool] = [:]

    public init() {}

    // MARK: - Connection Management

    /// Attach an SSE connection to a session.
    /// Returns a cleanup closure that removes the connection.
    public func connect(sessionId: String, connection: any SSEConnection) -> @Sendable () async -> Void {
        if streams[sessionId] == nil {
            streams[sessionId] = []
        }
        let index = streams[sessionId]!.count
        streams[sessionId]!.append(connection)

        let cleanup: @Sendable () async -> Void = { [weak self] in
            guard let self else { return }
            await self.removeConnection(sessionId: sessionId, index: index)
        }

        return cleanup
    }

    /// Remove a connection by index for a session.
    private func removeConnection(sessionId: String, index: Int) {
        guard var conns = streams[sessionId], index < conns.count else { return }
        conns.remove(at: index)
        if conns.isEmpty {
            streams.removeValue(forKey: sessionId)
        } else {
            streams[sessionId] = conns
        }
    }

    // MARK: - Event Emission

    /// Emit a typed event to all SSE connections for the given session.
    public func emit(sessionId: String, kind: SSEEventKind, payload: [String: AnyCodableValue]) async {
        guard let conns = streams[sessionId], !conns.isEmpty else { return }

        let seq = (seqMap[sessionId] ?? 0) + 1
        seqMap[sessionId] = seq

        let envelope = SSEEnvelope(
            sessionId: sessionId,
            ts: ISO8601DateFormatter().string(from: Date()),
            seq: seq,
            kind: kind,
            payload: payload
        )

        let encoder = JSONEncoder()
        guard let jsonData = try? encoder.encode(envelope),
              let json = String(data: jsonData, encoding: .utf8) else { return }

        let line = "event: \(kind.rawValue)\ndata: \(json)\nid: \(seq)\n\n"

        for conn in conns {
            do {
                try await conn.write(line)
            } catch {
                // Client disconnected -- cleanup via close handler
            }
        }
    }

    /// Close and remove all SSE connections for a session.
    public func disconnectSession(_ sessionId: String) async {
        guard let conns = streams[sessionId] else { return }
        for conn in conns {
            await conn.close()
        }
        streams.removeValue(forKey: sessionId)
        seqMap.removeValue(forKey: sessionId)
    }

    /// Number of active connections for a session.
    public func connectionCount(sessionId: String) -> Int {
        streams[sessionId]?.count ?? 0
    }

    /// Total number of active connections across all sessions.
    public func totalConnectionCount() -> Int {
        streams.values.reduce(0) { $0 + $1.count }
    }

    // MARK: - Typed Notification Helpers

    /// Notify that the tools list has changed.
    public func notifyToolsChanged(sessionId: String, snapshot: String) async {
        await emit(sessionId: sessionId, kind: .toolsListChanged, payload: [
            "snapshot": .string(snapshot),
        ])
    }

    /// Notify that a resource has changed.
    public func notifyResourceChanged(sessionId: String, resourceId: String) async {
        await emit(sessionId: sessionId, kind: .resourceChanged, payload: [
            "resourceId": .string(resourceId),
        ])
    }

    /// Notify progress on a tool invocation.
    public func notifyProgress(
        sessionId: String,
        invocationId: String,
        data: [String: AnyCodableValue]
    ) async {
        var payload = data
        payload["invocationId"] = .string(invocationId)
        await emit(sessionId: sessionId, kind: .progress, payload: payload)
    }

    /// Notify a stream event for a tool invocation.
    public func notifyStreamEvent(
        sessionId: String,
        invocationId: String,
        data: [String: AnyCodableValue]
    ) async {
        var payload = data
        payload["invocationId"] = .string(invocationId)
        await emit(sessionId: sessionId, kind: .stream, payload: payload)
    }

    // MARK: - Keepalive

    /// Send a keepalive comment to all connections for a session.
    public func sendKeepAlive(sessionId: String) async {
        guard let conns = streams[sessionId] else { return }
        for conn in conns {
            do {
                try await conn.write(": keepalive\n\n")
            } catch {
                // Connection may have dropped
            }
        }
    }

    /// Send a keepalive to all sessions.
    public func sendKeepAliveAll() async {
        for sessionId in streams.keys {
            await sendKeepAlive(sessionId: sessionId)
        }
    }
}
