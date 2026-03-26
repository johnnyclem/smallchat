import Foundation

/// A single Server-Sent Event.
public struct SSEEvent: Sendable {
    /// The event type (from `event:` field). Nil for default message events.
    public var event: String?
    /// The data payload (from `data:` field).
    public var data: String
    /// The last event ID (from `id:` field).
    public var id: String?
    /// Reconnection time in milliseconds (from `retry:` field).
    public var retry: Int?

    public init(event: String? = nil, data: String, id: String? = nil, retry: Int? = nil) {
        self.event = event
        self.data = data
        self.id = id
        self.retry = retry
    }
}

/// An `AsyncSequence` that parses Server-Sent Events from an async byte stream.
///
/// Handles the SSE wire format:
/// ```
/// event: message
/// data: {"key": "value"}
///
/// data: [DONE]
/// ```
///
/// Each blank line signals the end of an event. Multi-line `data:` values
/// are concatenated with newlines.
public struct SSEParser<Source: AsyncSequence>: AsyncSequence
    where Source.Element == UInt8
{
    public typealias Element = SSEEvent

    private let source: Source

    public init(source: Source) {
        self.source = source
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(source: source)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var lineIterator: AsyncLineSequence<Source>.AsyncIterator

        // Accumulated fields for the current event
        private var eventType: String?
        private var dataBuffer: String = ""
        private var lastId: String?
        private var retryValue: Int?

        init(source: Source) {
            self.lineIterator = AsyncLineSequence(source: source).makeAsyncIterator()
        }

        public mutating func next() async throws -> SSEEvent? {
            while true {
                guard let line = try await lineIterator.next() else {
                    // Stream ended — flush any remaining data
                    if !dataBuffer.isEmpty {
                        let event = SSEEvent(
                            event: eventType,
                            data: dataBuffer,
                            id: lastId,
                            retry: retryValue
                        )
                        resetFields()
                        return event
                    }
                    return nil
                }

                // Empty line signals end of an event
                if line.isEmpty {
                    if !dataBuffer.isEmpty {
                        let event = SSEEvent(
                            event: eventType,
                            data: dataBuffer,
                            id: lastId,
                            retry: retryValue
                        )
                        resetFields()
                        return event
                    }
                    continue
                }

                // Comment lines start with ':'
                if line.hasPrefix(":") {
                    continue
                }

                // Parse field: value
                if line.hasPrefix("data:") {
                    let value = extractValue(from: line, prefix: "data:")
                    if value == "[DONE]" {
                        return nil
                    }
                    if dataBuffer.isEmpty {
                        dataBuffer = value
                    } else {
                        dataBuffer += "\n" + value
                    }
                } else if line.hasPrefix("event:") {
                    eventType = extractValue(from: line, prefix: "event:")
                } else if line.hasPrefix("id:") {
                    lastId = extractValue(from: line, prefix: "id:")
                } else if line.hasPrefix("retry:") {
                    retryValue = Int(extractValue(from: line, prefix: "retry:"))
                }
            }
        }

        private mutating func resetFields() {
            eventType = nil
            dataBuffer = ""
            // id persists across events per SSE spec
            retryValue = nil
        }

        private func extractValue(from line: String, prefix: String) -> String {
            var value = String(line.dropFirst(prefix.count))
            if value.hasPrefix(" ") {
                value = String(value.dropFirst())
            }
            return value
        }
    }
}

// MARK: - AsyncLineSequence

/// An `AsyncSequence` that yields lines from an async byte stream.
/// Handles both `\n` and `\r\n` line endings.
struct AsyncLineSequence<Source: AsyncSequence>: AsyncSequence where Source.Element == UInt8 {
    typealias Element = String

    let source: Source

    func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(sourceIterator: source.makeAsyncIterator())
    }

    struct AsyncIterator: AsyncIteratorProtocol {
        var sourceIterator: Source.AsyncIterator
        var buffer: [UInt8] = []
        var done = false

        mutating func next() async throws -> String? {
            if done { return nil }

            while true {
                guard let byte = try await sourceIterator.next() else {
                    done = true
                    if buffer.isEmpty { return nil }
                    let line = String(decoding: buffer, as: UTF8.self)
                    buffer.removeAll()
                    return line
                }

                if byte == UInt8(ascii: "\n") {
                    // Strip trailing \r
                    if buffer.last == UInt8(ascii: "\r") {
                        buffer.removeLast()
                    }
                    let line = String(decoding: buffer, as: UTF8.self)
                    buffer.removeAll()
                    return line
                }

                buffer.append(byte)
            }
        }
    }
}

// MARK: - Convenience

extension SSEParser {
    /// Parse SSE events and yield each event's data parsed as JSON `Data`.
    /// Non-JSON data is yielded as UTF-8 encoded bytes.
    public func asTransportOutputs() -> AsyncThrowingStream<TransportOutput, Error> {
        AsyncThrowingStream { continuation in
            Task {
                var chunkIndex = 0
                do {
                    for try await event in self {
                        let data = event.data
                        if data == "[DONE]" {
                            continuation.finish()
                            return
                        }

                        let bodyData = Data(data.utf8)
                        let output = TransportOutput(
                            statusCode: 200,
                            headers: [:],
                            body: bodyData,
                            metadata: [
                                "streaming": "true",
                                "chunkIndex": String(chunkIndex),
                                "sseEvent": event.event ?? "message",
                            ]
                        )
                        chunkIndex += 1
                        continuation.yield(output)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
