import ArgumentParser
import Foundation
import SmallChat

struct DocsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "docs",
        abstract: "Generate Markdown documentation from a compiled artifact"
    )

    @Argument(help: "Path to the compiled toolkit file")
    var file: String

    @Option(name: .shortAndLong, help: "Output Markdown file path")
    var output: String = "TOOLS.md"

    func run() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        guard let artifact = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let stats = artifact["stats"] as? [String: Any] else {
            print("Failed to parse artifact")
            throw ExitCode.failure
        }

        var lines: [String] = []
        lines.append("# Tool Reference")
        lines.append("")
        lines.append("> Auto-generated from `\(URL(fileURLWithPath: file).lastPathComponent)` on \(ISO8601DateFormatter().string(from: Date()).prefix(10))")
        lines.append("")

        // Overview
        lines.append("## Overview")
        lines.append("")
        lines.append("| Metric | Value |")
        lines.append("|--------|-------|")
        lines.append("| Total tools | \(stats["toolCount"] ?? 0) |")
        lines.append("| Unique selectors | \(stats["uniqueSelectorCount"] ?? 0) |")
        lines.append("| Providers | \(stats["providerCount"] ?? 0) |")
        lines.append("| Collisions | \(stats["collisionCount"] ?? 0) |")

        if let emb = artifact["embedding"] as? [String: Any] {
            lines.append("| Embedding model | \(emb["model"] as? String ?? "unknown") |")
            lines.append("| Dimensions | \(emb["dimensions"] ?? "unknown") |")
        }
        lines.append("")

        // Tools by provider
        if let tables = artifact["dispatchTables"] as? [String: Any] {
            lines.append("## Tools by Provider")
            lines.append("")
            for (providerId, tableValue) in tables {
                if let methods = tableValue as? [String: Any] {
                    lines.append("### \(providerId) (\(methods.count) tools)")
                    lines.append("")
                    for (selector, methodValue) in methods {
                        if let method = methodValue as? [String: Any],
                           let toolName = method["toolName"] as? String {
                            lines.append("#### `\(toolName)`")
                            lines.append("")
                            lines.append("- **Selector**: `\(selector)`")
                            lines.append("- **Transport**: `\(method["transportType"] as? String ?? "unknown")`")
                            lines.append("")
                        }
                    }
                }
            }
        }

        // Collisions
        if let cols = artifact["collisions"] as? [[String: Any]], !cols.isEmpty {
            lines.append("## Selector Collisions")
            lines.append("")
            for c in cols {
                let sA = c["selectorA"] as? String ?? ""
                let sB = c["selectorB"] as? String ?? ""
                let sim = c["similarity"] as? Double ?? 0
                let hint = c["hint"] as? String ?? ""
                lines.append("- **\(sA)** vs **\(sB)** — similarity: \(String(format: "%.1f", sim * 100))%")
                lines.append("  - \(hint)")
            }
            lines.append("")
        }

        let markdown = lines.joined(separator: "\n")
        try markdown.write(toFile: output, atomically: true, encoding: .utf8)
        print("Documentation generated: \(output)")
        print("  \(stats["toolCount"] ?? 0) tools across \(stats["providerCount"] ?? 0) providers")
    }
}
