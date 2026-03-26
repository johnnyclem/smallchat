import SmallChatCore

/// DispatchBuilder -- fluent interface for constructing and executing a dispatch.
///
/// Usage:
///   let result = try await runtime.dispatch("search documents").withArgs(["query": "foo"]).exec()
///   let stream = runtime.dispatch("summarise").withArgs(["url": url]).stream()
///   for try await token in runtime.dispatch("explain").withArgs(["code": code]).inferStream() { ... }
public struct DispatchBuilder<TArgs: Sendable>: Sendable {
    private let context: DispatchContext
    private let intent: String
    private let args: TArgs?
    private let timeoutNs: UInt64?
    private let metadata: [String: AnyCodableValue]?

    public init(context: DispatchContext, intent: String, args: TArgs? = nil) {
        self.context = context
        self.intent = intent
        self.args = args
        self.timeoutNs = nil
        self.metadata = nil
    }

    private init(
        context: DispatchContext,
        intent: String,
        args: TArgs?,
        timeoutNs: UInt64?,
        metadata: [String: AnyCodableValue]?
    ) {
        self.context = context
        self.intent = intent
        self.args = args
        self.timeoutNs = timeoutNs
        self.metadata = metadata
    }

    /// Attach typed arguments to the dispatch.
    /// Returns a new builder with the args shape narrowed to T.
    public func withArgs<T: Sendable>(_ args: T) -> DispatchBuilder<T> {
        DispatchBuilder<T>(
            context: context,
            intent: intent,
            args: args,
            timeoutNs: timeoutNs,
            metadata: metadata
        )
    }

    /// Set a timeout for the dispatch execution.
    public func withTimeout(_ duration: Duration) -> DispatchBuilder<TArgs> {
        let components = duration.components
        let ns = UInt64(components.seconds) * 1_000_000_000 + UInt64(components.attoseconds / 1_000_000_000)
        return DispatchBuilder<TArgs>(
            context: context,
            intent: intent,
            args: args,
            timeoutNs: ns,
            metadata: metadata
        )
    }

    /// Attach metadata to the dispatch (passed through to the result).
    public func withMetadata(_ meta: [String: AnyCodableValue]) -> DispatchBuilder<TArgs> {
        DispatchBuilder<TArgs>(
            context: context,
            intent: intent,
            args: args,
            timeoutNs: timeoutNs,
            metadata: meta
        )
    }

    /// Execute the dispatch and return a single ToolResult.
    public func exec() async throws -> ToolResult {
        let dispatchArgs = argsAsDictionary()

        var result: ToolResult
        if let timeoutNs {
            result = try await withThrowingTaskGroup(of: ToolResult.self) { group in
                group.addTask {
                    try await toolkitDispatch(context: self.context, intent: self.intent, args: dispatchArgs)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: timeoutNs)
                    throw DispatchTimeoutError(intent: self.intent, timeoutNs: timeoutNs)
                }

                guard let first = try await group.next() else {
                    throw DispatchTimeoutError(intent: intent, timeoutNs: timeoutNs)
                }
                group.cancelAll()
                return first
            }
        } else {
            result = try await toolkitDispatch(context: context, intent: intent, args: dispatchArgs)
        }

        if let metadata {
            var meta = result.metadata ?? [:]
            for (key, value) in metadata {
                meta[key] = value as any Sendable
            }
            result.metadata = meta
        }

        return result
    }

    /// Execute and return only the content field of the result.
    public func execContent<T>() async throws -> T {
        let result = try await exec()
        guard let content = result.content as? T else {
            throw DispatchContentCastError(
                intent: intent,
                expectedType: String(describing: T.self)
            )
        }
        return content
    }

    /// Execute as a streaming dispatch, yielding DispatchEvent objects.
    ///
    /// Event flow: resolving -> tool-start -> chunk* / inference-delta* -> done | error
    public func stream() -> AsyncThrowingStream<DispatchEvent, Error> {
        let dispatchArgs = argsAsDictionary()
        return smallchatDispatchStream(context: context, intent: intent, args: dispatchArgs)
    }

    /// Convenience stream that yields only token text from inference deltas.
    ///
    /// Falls back to yielding full chunk content if the resolved IMP does not
    /// support progressive inference.
    public func inferStream() -> AsyncThrowingStream<String, Error> {
        let eventStream = stream()

        return AsyncThrowingStream { continuation in
            let task = Task {
                var sawDelta = false
                do {
                    for try await event in eventStream {
                        switch event {
                        case .inferenceDelta(let delta, _):
                            sawDelta = true
                            continuation.yield(delta.text)

                        case .chunk(let content, _) where !sawDelta:
                            switch content {
                            case .string(let text):
                                continuation.yield(text)
                            default:
                                // Best-effort: encode non-string content
                                if let data = try? JSONEncoder().encode(content),
                                   let text = String(data: data, encoding: .utf8) {
                                    continuation.yield(text)
                                }
                            }

                        case .error(let message, _):
                            continuation.finish(throwing: DispatchStreamError(message: message))
                            return

                        default:
                            break
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Stream only inference tokens (text deltas).
    /// Alias for inferStream() for API compatibility.
    public func tokens() -> AsyncThrowingStream<String, Error> {
        inferStream()
    }

    /// Execute the dispatch and collect all streamed chunks into an array.
    public func collect() async throws -> [AnyCodableValue] {
        var chunks: [AnyCodableValue] = []
        for try await event in stream() {
            if case .chunk(let content, _) = event {
                chunks.append(content)
            }
        }
        return chunks
    }

    // MARK: - Private

    private func argsAsDictionary() -> [String: any Sendable]? {
        guard let args else { return nil }
        if let dict = args as? [String: any Sendable] {
            return dict
        }
        // If TArgs is not a dictionary, wrap it under "value"
        return ["value": args]
    }
}

// MARK: - Errors

public struct DispatchTimeoutError: Error, Sendable, CustomStringConvertible {
    public let intent: String
    public let timeoutNs: UInt64

    public init(intent: String, timeoutNs: UInt64) {
        self.intent = intent
        self.timeoutNs = timeoutNs
    }

    public var description: String {
        let ms = timeoutNs / 1_000_000
        return "Dispatch timed out after \(ms)ms for intent \"\(intent)\""
    }
}

public struct DispatchContentCastError: Error, Sendable, CustomStringConvertible {
    public let intent: String
    public let expectedType: String

    public init(intent: String, expectedType: String) {
        self.intent = intent
        self.expectedType = expectedType
    }

    public var description: String {
        "Cannot cast dispatch result content to \(expectedType) for intent \"\(intent)\""
    }
}

public struct DispatchStreamError: Error, Sendable, CustomStringConvertible {
    public let message: String

    public init(message: String) {
        self.message = message
    }

    public var description: String { message }
}
