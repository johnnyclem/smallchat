import Foundation

/// Configuration for an HTTP transport.
///
/// Mirrors the TypeScript `HttpTransportConfig` interface.
public struct TransportConfig: Sendable {

    /// Base URL for the API.
    public var baseURL: URL

    /// Default request timeout in seconds.
    public var timeout: TimeInterval

    /// Retry configuration.
    public var retryConfig: RetryConfig?

    /// Circuit breaker configuration.
    public var circuitBreakerConfig: CircuitBreakerConfig?

    /// Default headers applied to every request.
    public var headers: [String: String]

    /// Authentication strategy.
    public var auth: (any AuthStrategy)?

    /// Default HTTP method when no route specifies one.
    public var defaultMethod: HTTPMethod

    /// Connection pool size (max concurrent connections per host).
    public var poolSize: Int

    public init(
        baseURL: URL,
        timeout: TimeInterval = 30,
        retryConfig: RetryConfig? = nil,
        circuitBreakerConfig: CircuitBreakerConfig? = nil,
        headers: [String: String] = [:],
        auth: (any AuthStrategy)? = nil,
        defaultMethod: HTTPMethod = .POST,
        poolSize: Int = 10
    ) {
        self.baseURL = baseURL
        self.timeout = timeout
        self.retryConfig = retryConfig
        self.circuitBreakerConfig = circuitBreakerConfig
        self.headers = headers
        self.auth = auth
        self.defaultMethod = defaultMethod
        self.poolSize = poolSize
    }
}

// MARK: - RetryConfig

/// Configuration for retry behavior with exponential backoff.
public struct RetryConfig: Sendable {

    /// Maximum number of retry attempts (default: 3).
    public var maxRetries: Int

    /// Base delay between retries in seconds (default: 1.0).
    public var baseDelay: TimeInterval

    /// Maximum delay between retries in seconds (default: 30.0).
    public var maxDelay: TimeInterval

    /// Jitter factor 0-1 (default: 0.1).
    public var jitter: Double

    /// HTTP status codes that trigger a retry.
    public var retryableStatusCodes: Set<Int>

    public init(
        maxRetries: Int = 3,
        baseDelay: TimeInterval = 1.0,
        maxDelay: TimeInterval = 30.0,
        jitter: Double = 0.1,
        retryableStatusCodes: Set<Int> = [408, 429, 500, 502, 503, 504]
    ) {
        self.maxRetries = maxRetries
        self.baseDelay = baseDelay
        self.maxDelay = maxDelay
        self.jitter = jitter
        self.retryableStatusCodes = retryableStatusCodes
    }
}

// MARK: - CircuitBreakerConfig

/// Configuration for the circuit breaker pattern.
public struct CircuitBreakerConfig: Sendable {

    /// Number of failures before opening the circuit (default: 5).
    public var failureThreshold: Int

    /// Time in seconds before attempting to half-open (default: 60).
    public var resetTimeout: TimeInterval

    /// Number of successful calls in half-open to close the circuit (default: 1).
    public var successThreshold: Int

    public init(
        failureThreshold: Int = 5,
        resetTimeout: TimeInterval = 60,
        successThreshold: Int = 1
    ) {
        self.failureThreshold = failureThreshold
        self.resetTimeout = resetTimeout
        self.successThreshold = successThreshold
    }
}

// MARK: - MCP Stdio Config

/// Configuration for MCP stdio transport.
public struct MCPStdioConfig: Sendable {

    /// Command to spawn the MCP server.
    public var command: String

    /// Arguments for the command.
    public var args: [String]

    /// Environment variables.
    public var env: [String: String]

    /// Working directory.
    public var cwd: String?

    /// Timeout for initialization in seconds (default: 10).
    public var initTimeout: TimeInterval

    /// Optional container sandbox configuration.
    public var containerSandbox: ContainerSandboxConfig?

    public init(
        command: String,
        args: [String] = [],
        env: [String: String] = [:],
        cwd: String? = nil,
        initTimeout: TimeInterval = 10,
        containerSandbox: ContainerSandboxConfig? = nil
    ) {
        self.command = command
        self.args = args
        self.env = env
        self.cwd = cwd
        self.initTimeout = initTimeout
        self.containerSandbox = containerSandbox
    }
}

// MARK: - MCP SSE Config

/// Configuration for MCP SSE transport.
public struct MCPSSEConfig: Sendable {

    /// SSE endpoint URL.
    public var url: URL

    /// Authentication strategy.
    public var auth: (any AuthStrategy)?

    /// Additional headers.
    public var headers: [String: String]

    /// Reconnect delay in seconds (default: 1.0).
    public var reconnectDelay: TimeInterval

    public init(
        url: URL,
        auth: (any AuthStrategy)? = nil,
        headers: [String: String] = [:],
        reconnectDelay: TimeInterval = 1.0
    ) {
        self.url = url
        self.auth = auth
        self.headers = headers
        self.reconnectDelay = reconnectDelay
    }
}
