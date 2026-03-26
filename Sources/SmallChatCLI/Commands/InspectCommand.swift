import ArgumentParser
import Foundation
import SmallChat

struct InspectCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "inspect",
        abstract: "Inspect a compiled .toolkit artifact"
    )

    @Argument(help: "Path to the compiled toolkit file")
    var file: String

    @Flag(help: "Show all selectors")
    var selectors: Bool = false

    @Flag(help: "Show providers and their tools")
    var providers: Bool = false

    @Flag(help: "Show selector collisions")
    var collisions: Bool = false

    @Flag(help: "Show embedding model info")
    var embeddings: Bool = false

    func run() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        guard let artifact = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let stats = artifact["stats"] as? [String: Any] else {
            print("Failed to parse artifact")
            throw ExitCode.failure
        }

        print("ToolKit artifact: \(file)")
        print("Version: \(artifact["version"] as? String ?? "unknown")")
        print("Compiled: \(artifact["timestamp"] as? String ?? "unknown")")
        print("Stats:")
        print("  Tools: \(stats["toolCount"] ?? 0)")
        print("  Unique selectors: \(stats["uniqueSelectorCount"] ?? 0)")
        print("  Merged: \(stats["mergedCount"] ?? 0)")
        print("  Providers: \(stats["providerCount"] ?? 0)")
        print("  Collisions: \(stats["collisionCount"] ?? 0)")

        if embeddings, let emb = artifact["embedding"] as? [String: Any] {
            print("\nEmbedding model:")
            print("  Model: \(emb["model"] as? String ?? "unknown")")
            print("  Dimensions: \(emb["dimensions"] ?? "unknown")")
            print("  Embedder type: \(emb["embedderType"] as? String ?? "unknown")")
        }

        if selectors, let sels = artifact["selectors"] as? [String: Any] {
            print("\nSelectors:")
            for (_, selValue) in sels {
                if let s = selValue as? [String: Any],
                   let canonical = s["canonical"] as? String,
                   let arity = s["arity"] as? Int {
                    print("  \(canonical) (arity: \(arity))")
                }
            }
        }

        if providers, let tables = artifact["dispatchTables"] as? [String: Any] {
            print("\nProviders:")
            for (providerId, tableValue) in tables {
                if let methods = tableValue as? [String: Any] {
                    print("  \(providerId): \(methods.count) tools")
                    for (_, methodValue) in methods {
                        if let method = methodValue as? [String: Any],
                           let toolName = method["toolName"] as? String {
                            print("    - \(toolName)")
                        }
                    }
                }
            }
        }

        if collisions, let cols = artifact["collisions"] as? [[String: Any]] {
            print("\nCollisions:")
            if cols.isEmpty {
                print("  None")
            } else {
                for c in cols {
                    let sA = c["selectorA"] as? String ?? ""
                    let sB = c["selectorB"] as? String ?? ""
                    let sim = c["similarity"] as? Double ?? 0
                    let hint = c["hint"] as? String ?? ""
                    print("  WARNING: \(sA) <-> \(sB) (\(String(format: "%.1f", sim * 100))%)")
                    print("    \(hint)")
                }
            }
        }
    }
}
