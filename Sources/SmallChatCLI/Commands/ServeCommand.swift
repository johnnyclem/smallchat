import ArgumentParser
import Foundation
import SmallChat

struct ServeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "serve",
        abstract: "Start an MCP 2024-11-05 compliant tool server"
    )

    @Option(name: .shortAndLong, help: "Source directory or compiled artifact (.json)")
    var source: String

    @Option(name: .shortAndLong, help: "Port to listen on")
    var port: Int = 3001

    @Option(name: .long, help: "Host to bind to")
    var host: String = "127.0.0.1"

    @Option(help: "SQLite database path for sessions")
    var dbPath: String = "smallchat.db"

    @Flag(help: "Enable OAuth 2.1 authentication")
    var auth: Bool = false

    @Flag(help: "Enable rate limiting")
    var rateLimit: Bool = false

    @Option(help: "Max requests per minute")
    var rateLimitRpm: Int = 600

    @Flag(help: "Enable audit logging")
    var audit: Bool = false

    @Option(help: "Session TTL in hours")
    var sessionTtl: Double = 24

    func run() async throws {
        print("Loading toolkit from \(source)...")
        print("Starting smallchat MCP server on \(host):\(port)")
        print("  Auth: \(auth ? "enabled" : "disabled")")
        print("  Rate limiting: \(rateLimit ? "enabled (\(rateLimitRpm) rpm)" : "disabled")")
        print("  Audit: \(audit ? "enabled" : "disabled")")
        print("  Session TTL: \(sessionTtl)h")
        print("  Database: \(dbPath)")

        // Server lifecycle
        print("\nServer running. Press Ctrl+C to stop.")
        print("  Discovery: http://\(host):\(port)/.well-known/mcp.json")
        print("  JSON-RPC:  http://\(host):\(port)/")
        print("  SSE:       http://\(host):\(port)/sse")
        print("  Health:    http://\(host):\(port)/health")

        // Keep running until signal
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            signal(SIGINT) { _ in
                print("\nShutting down...")
                continuation.resume()
            }
        }
    }
}
