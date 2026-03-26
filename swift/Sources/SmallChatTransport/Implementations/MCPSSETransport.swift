import Foundation

/// MCP SSE Transport — communicates with MCP servers via Server-Sent Events over HTTP.
///
/// Sends JSON-RPC requests as HTTP POST and receives responses either as
/// direct JSON or as SSE event streams.
///
/// Actor-isolated for connection state management.
///
/// Mirrors the TypeScript `McpSseTransport` class.
public actor MCPSSETransport: Transport {

    public nonisolated let id: String

    private let config: MCPSSEConfig
    private let session: URLSession
    private var connected: Bool = false
    private var requestIdCounter: Int = 0

    private static var counter = 0

    public init(config: MCPSSEConfig) {
        Self.counter += 1
        self.id = "mcp-sse-\(Self.counter)"
        self.config = config
        self.session = URLSession(configuration: .default)
    }

    // MARK: - Transport Protocol

    public nonisolated var isConnected: Bool {
        get async { await getConnected() }
    }

    private func getConnected() -> Bool { connected }

    public nonisolated func connect() async throws {
        await setConnected(true)
    }

    private func setConnected(_ value: Bool) {
        connected = value
    }

    public nonisolated func disconnect() async throws {
        await setConnected(false)
    }

    public nonisolated func execute(input: TransportInput) async throws -> TransportOutput {
        try await performExecute(input)
    }

    public nonisolated func executeStream(input: TransportInput) -> AsyncThrowingStream<TransportOutput, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    try await self.performExecuteStream(input, continuation: continuation)
                } catch {
                    continuation.yield(errorToTransportOutput(error))
                    continuation.finish()
                }
            }
        }
    }

    // MARK: - Internal

    private func performExecute(_ input: TransportInput) async throws -> TransportOutput {
        let request = try await buildRequest(input: input)

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw TransportError.invalidResponse(message: "Non-HTTP response")
        }

        if httpResponse.statusCode >= 400 {
            let body = String(data: data, encoding: .utf8)
            return TransportOutput(
                statusCode: httpResponse.statusCode,
                headers: extractHeaders(httpResponse),
                body: data,
                metadata: [
                    "isError": "true",
                    "error": "MCP SSE request failed: \(httpResponse.statusCode) — \(body ?? "")",
                ]
            )
        }

        // Parse JSON-RPC response
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["jsonrpc"] as? String == "2.0" else {
            return TransportOutput(
                statusCode: httpResponse.statusCode,
                headers: extractHeaders(httpResponse),
                body: data,
                metadata: [:]
            )
        }

        if let error = json["error"] as? [String: Any],
           let code = error["code"] as? Int,
           let message = error["message"] as? String {
            throw TransportError.fromJsonRpcError(code: code, message: message)
        }

        let resultData: Data
        if let result = json["result"] {
            resultData = try JSONSerialization.data(withJSONObject: result)
        } else {
            resultData = Data("null".utf8)
        }

        return TransportOutput(
            statusCode: 200,
            headers: extractHeaders(httpResponse),
            body: resultData,
            metadata: [:]
        )
    }

    private func performExecuteStream(
        _ input: TransportInput,
        continuation: AsyncThrowingStream<TransportOutput, Error>.Continuation
    ) async throws {
        var request = try await buildRequest(input: input)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        let (bytes, response) = try await session.bytes(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            continuation.yield(errorToTransportOutput(
                TransportError.invalidResponse(message: "Non-HTTP response")
            ))
            continuation.finish()
            return
        }

        if httpResponse.statusCode >= 400 {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            continuation.yield(TransportOutput(
                statusCode: httpResponse.statusCode,
                headers: extractHeaders(httpResponse),
                body: body,
                metadata: ["isError": "true", "error": "MCP SSE stream failed: \(httpResponse.statusCode)"]
            ))
            continuation.finish()
            return
        }

        let parser = SSEParser(source: bytes)
        for try await event in parser {
            let data = event.data.trimmingCharacters(in: .whitespaces)
            if data.isEmpty || data == "[DONE]" { continue }

            guard let jsonData = data.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
                continue
            }

            if let result = json["result"] {
                let resultData = try JSONSerialization.data(withJSONObject: result)
                continuation.yield(TransportOutput(
                    statusCode: 200,
                    headers: [:],
                    body: resultData,
                    metadata: [:]
                ))
            } else if let params = json["params"] as? [String: Any] {
                let paramsData = try JSONSerialization.data(withJSONObject: params)
                continuation.yield(TransportOutput(
                    statusCode: 200,
                    headers: [:],
                    body: paramsData,
                    metadata: ["streaming": "true"]
                ))
            }
        }

        continuation.finish()
    }

    private func buildRequest(input: TransportInput) async throws -> URLRequest {
        requestIdCounter += 1
        let id = requestIdCounter

        var params: [String: Any] = ["name": input.toolName]
        var arguments: [String: Any] = [:]
        for (key, value) in input.args {
            arguments[key] = value.value
        }
        params["arguments"] = arguments

        let rpcRequest: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": "tools/call",
            "params": params,
        ]

        var request = URLRequest(url: config.url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: rpcRequest)

        // Apply configured headers
        for (key, value) in config.headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        // Apply auth
        if let auth = config.auth {
            var transportInput = input
            try await auth.authenticate(request: &transportInput)
            for (key, value) in transportInput.headers {
                request.setValue(value, forHTTPHeaderField: key)
            }
        }

        return request
    }

    private func extractHeaders(_ response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            if let k = key as? String, let v = value as? String {
                headers[k] = v
            }
        }
        return headers
    }
}
