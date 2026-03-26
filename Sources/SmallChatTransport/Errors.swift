import Foundation

// MARK: - TransportError

/// Unified error type for all transport-level failures.
/// Maps to the TypeScript `ToolExecutionError` hierarchy.
public enum TransportError: Error, Sendable, CustomStringConvertible {

    /// The transport failed to establish a connection.
    case connectionFailed(message: String, cause: (any Error)? = nil)

    /// The operation exceeded its deadline.
    case timeout(durationMs: Int)

    /// An HTTP response indicated an error.
    case httpError(statusCode: Int, code: String, body: String?, retryable: Bool)

    /// An SSE stream encountered a parse or connection error.
    case sseError(message: String)

    /// A JSON-RPC response contained an error.
    case jsonRpcError(code: Int, message: String, retryable: Bool)

    /// The circuit breaker is open and refusing calls.
    case circuitOpen(transportId: String)

    /// No handler was registered for the requested tool.
    case handlerNotFound(toolName: String)

    /// A sandbox constraint was violated.
    case sandboxViolation(message: String)

    /// A container sandbox operation failed.
    case containerSandboxError(message: String)

    /// An invalid or malformed response was received.
    case invalidResponse(message: String)

    /// The transport or connection pool has been disposed.
    case disposed

    /// Catch-all for unexpected errors.
    case unknown(message: String)

    // MARK: - CustomStringConvertible

    public var description: String {
        switch self {
        case .connectionFailed(let message, _):
            return "Connection failed: \(message)"
        case .timeout(let ms):
            return "Transport timed out after \(ms)ms"
        case .httpError(let statusCode, let code, let body, _):
            var msg = "HTTP \(statusCode): \(code)"
            if let body { msg += " — \(body)" }
            return msg
        case .sseError(let message):
            return "SSE error: \(message)"
        case .jsonRpcError(let code, let message, _):
            return "JSON-RPC \(code): \(message)"
        case .circuitOpen(let id):
            return "Circuit breaker open for transport \(id)"
        case .handlerNotFound(let name):
            return "No local handler registered for \"\(name)\""
        case .sandboxViolation(let message):
            return "Sandbox violation: \(message)"
        case .containerSandboxError(let message):
            return "Container sandbox error: \(message)"
        case .invalidResponse(let message):
            return "Invalid response: \(message)"
        case .disposed:
            return "Transport has been disposed"
        case .unknown(let message):
            return "Unknown transport error: \(message)"
        }
    }

    // MARK: - Retryability

    /// Whether this error is safe to retry.
    public var isRetryable: Bool {
        switch self {
        case .timeout:
            return true
        case .httpError(_, _, _, let retryable):
            return retryable
        case .jsonRpcError(_, _, let retryable):
            return retryable
        case .connectionFailed:
            return true
        case .circuitOpen, .handlerNotFound, .sandboxViolation,
             .containerSandboxError, .invalidResponse, .disposed, .sseError, .unknown:
            return false
        }
    }

    // MARK: - HTTP Status Mapping

    private static let httpErrorMap: [Int: (code: String, retryable: Bool)] = [
        400: ("BAD_REQUEST", false),
        401: ("UNAUTHORIZED", false),
        403: ("FORBIDDEN", false),
        404: ("NOT_FOUND", false),
        405: ("METHOD_NOT_ALLOWED", false),
        408: ("REQUEST_TIMEOUT", true),
        409: ("CONFLICT", false),
        422: ("UNPROCESSABLE_ENTITY", false),
        429: ("RATE_LIMITED", true),
        500: ("INTERNAL_SERVER_ERROR", true),
        502: ("BAD_GATEWAY", true),
        503: ("SERVICE_UNAVAILABLE", true),
        504: ("GATEWAY_TIMEOUT", true),
    ]

    /// Create a `TransportError` from an HTTP status code.
    public static func fromHTTPStatus(_ status: Int, body: String? = nil) -> TransportError {
        let mapping = httpErrorMap[status] ?? (code: "HTTP_\(status)", retryable: status >= 500)
        return .httpError(statusCode: status, code: mapping.code, body: body, retryable: mapping.retryable)
    }

    // MARK: - JSON-RPC Error Mapping

    private static let jsonRpcErrorMap: [Int: (code: String, retryable: Bool)] = [
        -32700: ("PARSE_ERROR", false),
        -32600: ("INVALID_REQUEST", false),
        -32601: ("METHOD_NOT_FOUND", false),
        -32602: ("INVALID_PARAMS", false),
        -32603: ("INTERNAL_ERROR", true),
    ]

    /// Create a `TransportError` from a JSON-RPC error code.
    public static func fromJsonRpcError(code: Int, message: String) -> TransportError {
        let mapping = jsonRpcErrorMap[code] ?? (code: "JSONRPC_\(code)", retryable: code <= -32000)
        return .jsonRpcError(code: code, message: message, retryable: mapping.retryable)
    }
}

// MARK: - Error → TransportOutput Conversion

extension TransportError {

    /// Convert this error into a `TransportOutput` with error metadata.
    public func toOutput() -> TransportOutput {
        TransportOutput(
            statusCode: statusCodeValue ?? 0,
            headers: [:],
            body: nil,
            metadata: [
                "error": description,
                "isError": "true",
                "retryable": String(isRetryable),
            ]
        )
    }

    private var statusCodeValue: Int? {
        switch self {
        case .httpError(let code, _, _, _): return code
        case .timeout: return 408
        case .jsonRpcError(let code, _, _): return code
        default: return nil
        }
    }
}

/// Convert any error to a `TransportOutput`.
public func errorToTransportOutput(_ error: any Error) -> TransportOutput {
    if let te = error as? TransportError {
        return te.toOutput()
    }
    return TransportOutput(
        statusCode: 0,
        headers: [:],
        body: nil,
        metadata: [
            "error": error.localizedDescription,
            "isError": "true",
            "code": "UNKNOWN_ERROR",
        ]
    )
}
