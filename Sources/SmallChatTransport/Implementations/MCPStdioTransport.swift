import Foundation

/// MCP Stdio Transport — communicates with MCP servers via JSON-RPC over stdin/stdout.
///
/// Spawns a child process using `Foundation.Process`, sends JSON-RPC requests
/// to its stdin, and reads JSON-RPC responses from its stdout.
///
/// Actor-isolated for state management of the process lifecycle and pending requests.
///
/// Mirrors the TypeScript `McpStdioTransport` class.
public actor MCPStdioTransport: Transport {

    public nonisolated let id: String

    private let config: MCPStdioConfig
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var buffer: String = ""
    private var pendingRequests: [Int: CheckedContinuation<JsonRpcResponse, any Error>] = [:]
    private var initialized: Bool = false
    private var requestIdCounter: Int = 0

    private static var counter = 0

    public init(config: MCPStdioConfig) {
        Self.counter += 1
        self.id = "mcp-stdio-\(Self.counter)"
        self.config = config
    }

    // MARK: - Transport Protocol

    public nonisolated var isConnected: Bool {
        get async { await getInitialized() }
    }

    private func getInitialized() -> Bool { initialized }

    public nonisolated func connect() async throws {
        try await ensureInitialized()
    }

    public nonisolated func disconnect() async throws {
        await performDispose()
    }

    public nonisolated func execute(input: TransportInput) async throws -> TransportOutput {
        try await performExecute(input)
    }

    // MARK: - Tool Listing

    /// List available tools from the MCP server.
    public func listTools() async throws -> [[String: Any]] {
        try await ensureInitialized()
        let request = buildRequest(method: "tools/list")
        let response = try await sendRequest(id: request.id, payload: request.encoded)
        guard let result = response.result as? [String: Any],
              let tools = result["tools"] as? [[String: Any]] else {
            throw TransportError.invalidResponse(message: "Invalid tools/list response")
        }
        return tools
    }

    // MARK: - Internal

    private func performExecute(_ input: TransportInput) async throws -> TransportOutput {
        try await ensureInitialized()

        var params: [String: Any] = [
            "name": input.toolName,
        ]
        var arguments: [String: Any] = [:]
        for (key, value) in input.args {
            arguments[key] = value.value
        }
        params["arguments"] = arguments

        let request = buildRequest(method: "tools/call", params: params)
        let timeoutSeconds = input.timeout ?? 30

        let response: JsonRpcResponse
        if timeoutSeconds > 0 {
            let middleware = TimeoutMiddleware(timeout: timeoutSeconds)
            response = try await middleware.execute {
                try await self.sendRequest(id: request.id, payload: request.encoded)
            }
        } else {
            response = try await sendRequest(id: request.id, payload: request.encoded)
        }

        if let error = response.error {
            throw TransportError.fromJsonRpcError(code: error.code, message: error.message)
        }

        let resultData: Data
        if let result = response.result {
            resultData = try JSONSerialization.data(withJSONObject: result)
        } else {
            resultData = Data("null".utf8)
        }

        return TransportOutput(
            statusCode: 200,
            headers: [:],
            body: resultData,
            metadata: [:]
        )
    }

    private func ensureInitialized() async throws {
        if initialized { return }
        try await initialize()
    }

    private func initialize() async throws {
        let proc = Process()
        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()

        if let sandbox = config.containerSandbox, sandbox.enabled {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = buildDockerArgs()
        } else {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            proc.arguments = [config.command] + config.args
        }

        if let cwd = config.cwd {
            proc.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }

        var env = ProcessInfo.processInfo.environment
        for (key, value) in config.env {
            env[key] = value
        }
        proc.environment = env

        proc.standardInput = stdin
        proc.standardOutput = stdout
        proc.standardError = stderr

        self.process = proc
        self.stdinPipe = stdin
        self.stdoutPipe = stdout

        try proc.run()

        // Set up stdout reading
        let readHandle = stdout.fileHandleForReading
        readHandle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(data: data, encoding: .utf8) ?? ""
            Task { [weak self] in
                await self?.processStdoutData(text)
            }
        }

        // Send initialize request
        let initRequest = buildRequest(method: "initialize", params: [
            "protocolVersion": "2024-11-05",
            "capabilities": [String: Any](),
            "clientInfo": [
                "name": "smallchat",
                "version": "0.1.0",
            ] as [String: Any],
        ] as [String: Any])

        let timeoutMiddleware = TimeoutMiddleware(timeout: config.initTimeout)
        let initResponse = try await timeoutMiddleware.execute {
            try await self.sendRequest(id: initRequest.id, payload: initRequest.encoded)
        }

        if let error = initResponse.error {
            throw TransportError.connectionFailed(
                message: "MCP initialize failed: \(error.message)"
            )
        }

        // Send initialized notification
        let notification = JsonRpcNotification(method: "notifications/initialized")
        if let data = try? JSONSerialization.data(withJSONObject: notification.toDictionary()) {
            let line = String(data: data, encoding: .utf8)! + "\n"
            stdinPipe?.fileHandleForWriting.write(Data(line.utf8))
        }

        initialized = true
    }

    private func sendRequest(id: Int, payload: Data) async throws -> JsonRpcResponse {
        guard let stdinPipe, process?.isRunning == true else {
            throw TransportError.connectionFailed(message: "MCP server stdin not writable")
        }

        let line = String(data: payload, encoding: .utf8)! + "\n"
        stdinPipe.fileHandleForWriting.write(Data(line.utf8))

        return try await withCheckedThrowingContinuation { continuation in
            self.pendingRequests[id] = continuation
        }
    }

    private func processStdoutData(_ text: String) {
        buffer += text
        let lines = buffer.split(separator: "\n", omittingEmptySubsequences: false)

        if !buffer.hasSuffix("\n") {
            buffer = String(lines.last ?? "")
            for line in lines.dropLast() {
                processLine(String(line))
            }
        } else {
            buffer = ""
            for line in lines {
                let s = String(line).trimmingCharacters(in: .whitespaces)
                if !s.isEmpty {
                    processLine(s)
                }
            }
        }
    }

    private func processLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["jsonrpc"] as? String == "2.0" else {
            return
        }

        guard let id = json["id"] as? Int else {
            // Notification — ignore for now
            return
        }

        let response = JsonRpcResponse(
            id: id,
            result: json["result"],
            error: (json["error"] as? [String: Any]).flatMap { errDict in
                guard let code = errDict["code"] as? Int,
                      let message = errDict["message"] as? String else { return nil }
                return JsonRpcResponseError(code: code, message: message, data: errDict["data"])
            }
        )

        if let continuation = pendingRequests.removeValue(forKey: id) {
            continuation.resume(returning: response)
        }
    }

    private func performDispose() {
        if let process, process.isRunning {
            stdinPipe?.fileHandleForWriting.closeFile()
            process.terminate()

            // Give it a moment, then force kill
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { [weak process] in
                if let process, process.isRunning {
                    process.terminate()
                }
            }
        }

        stdoutPipe?.fileHandleForReading.readabilityHandler = nil

        // Reject all pending requests
        for (_, continuation) in pendingRequests {
            continuation.resume(throwing: TransportError.disposed)
        }
        pendingRequests.removeAll()
        initialized = false
        process = nil
        stdinPipe = nil
        stdoutPipe = nil
    }

    // MARK: - Request Building

    private struct BuiltRequest {
        let id: Int
        let encoded: Data
    }

    private func buildRequest(method: String, params: [String: Any]? = nil) -> BuiltRequest {
        requestIdCounter += 1
        let id = requestIdCounter

        var dict: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        ]
        if let params {
            dict["params"] = params
        }

        let data = try! JSONSerialization.data(withJSONObject: dict)
        return BuiltRequest(id: id, encoded: data)
    }

    private func buildDockerArgs() -> [String] {
        guard let sandbox = config.containerSandbox else { return [config.command] + config.args }

        var args = ["docker", "run", "--rm", "-i"]
        args.append("--cap-drop=ALL")
        args.append("--security-opt=no-new-privileges")
        args.append("--network=\(sandbox.network ?? "none")")

        if let mem = sandbox.memoryLimit {
            args.append("--memory=\(mem)")
        }
        if let cpu = sandbox.cpuLimit {
            args.append("--cpus=\(cpu)")
        }
        for mount in sandbox.readOnlyMounts ?? [] {
            args.append(contentsOf: ["-v", "\(mount):\(mount):ro"])
        }
        for (key, value) in config.env {
            args.append(contentsOf: ["-e", "\(key)=\(value)"])
        }
        if let extra = sandbox.extraArgs {
            args.append(contentsOf: extra)
        }

        args.append(sandbox.image)
        args.append(config.command)
        args.append(contentsOf: config.args)

        return args
    }
}

// MARK: - JSON-RPC Helper Types

// JSON-RPC response types are @unchecked Sendable because they hold
// JSON-compatible `Any` values that are inherently safe.

struct JsonRpcResponse: @unchecked Sendable {
    let id: Int
    let result: Any?
    let error: JsonRpcResponseError?

    init(id: Int, result: Any?, error: JsonRpcResponseError?) {
        self.id = id
        self.result = result
        self.error = error
    }
}

struct JsonRpcResponseError: @unchecked Sendable {
    let code: Int
    let message: String
    let data: Any?

    init(code: Int, message: String, data: Any? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
}

struct JsonRpcNotification: @unchecked Sendable {
    let method: String
    let params: [String: Any]?

    init(method: String, params: [String: Any]? = nil) {
        self.method = method
        self.params = params
    }

    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [
            "jsonrpc": "2.0",
            "method": method,
        ]
        if let params {
            dict["params"] = params
        }
        return dict
    }
}
