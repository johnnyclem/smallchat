import Foundation

/// An `AsyncSequence` that parses newline-delimited JSON from an async byte stream.
///
/// Each line is treated as an independent JSON object. Empty lines are skipped.
/// Lines that fail JSON parsing are yielded as raw UTF-8 string data.
public struct NDJSONParser<Source: AsyncSequence>: AsyncSequence
    where Source.Element == UInt8
{
    public typealias Element = Data

    private let source: Source

    public init(source: Source) {
        self.source = source
    }

    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(source: source)
    }

    public struct AsyncIterator: AsyncIteratorProtocol {
        private var lineIterator: AsyncLineSequence<Source>.AsyncIterator

        init(source: Source) {
            self.lineIterator = AsyncLineSequence(source: source).makeAsyncIterator()
        }

        public mutating func next() async throws -> Data? {
            while true {
                guard let line = try await lineIterator.next() else {
                    return nil
                }

                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }

                return Data(trimmed.utf8)
            }
        }
    }
}

// MARK: - Convenience

extension NDJSONParser {
    /// Convert NDJSON lines into a stream of `TransportOutput`.
    public func asTransportOutputs() -> AsyncThrowingStream<TransportOutput, Error> {
        AsyncThrowingStream { continuation in
            Task {
                var chunkIndex = 0
                do {
                    for try await data in self {
                        let output = TransportOutput(
                            statusCode: 200,
                            headers: [:],
                            body: data,
                            metadata: [
                                "streaming": "true",
                                "chunkIndex": String(chunkIndex),
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
