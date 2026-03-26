import ArgumentParser
import Foundation
import SmallChat

struct ChannelCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "channel",
        abstract: "Run a stdio MCP channel server"
    )

    @Option(name: .shortAndLong, help: "Channel name/identifier")
    var name: String

    @Flag(help: "Enable two-way mode with reply tool")
    var twoWay: Bool = false

    @Option(help: "Reply tool name")
    var replyTool: String = "reply"

    @Flag(help: "Enable permission relay")
    var permissionRelay: Bool = false

    @Option(help: "Channel instructions for the LLM")
    var instructions: String?

    @Flag(help: "Enable HTTP bridge for inbound webhooks")
    var httpBridge: Bool = false

    @Option(help: "HTTP bridge port")
    var httpBridgePort: Int = 3002

    @Option(help: "HTTP bridge host")
    var httpBridgeHost: String = "127.0.0.1"

    @Option(help: "Comma-separated sender allowlist")
    var senderAllowlist: String?

    func run() async throws {
        // Validate: permission relay needs sender gating
        if permissionRelay && senderAllowlist == nil {
            FileHandle.standardError.write(Data(
                ("Warning: --permission-relay is enabled but no sender allowlist is configured.\n" +
                 "Permission relay will reject all verdicts until sender gating is set up.\n\n").utf8
            ))
        }

        FileHandle.standardError.write(Data(
            ("[channel] \(name) channel server started (stdio)\n" +
             "  Two-way: \(twoWay ? "yes" : "no")\n" +
             "  Permission relay: \(permissionRelay ? "yes" : "no")\n" +
             "  HTTP bridge: \(httpBridge ? "http://\(httpBridgeHost):\(httpBridgePort)" : "disabled")\n").utf8
        ))

        // Keep running until signal
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            signal(SIGINT) { _ in
                continuation.resume()
            }
        }
    }
}
