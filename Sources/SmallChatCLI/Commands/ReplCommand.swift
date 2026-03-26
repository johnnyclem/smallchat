import ArgumentParser
import Foundation
import SmallChat

struct ReplCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "repl",
        abstract: "Start an interactive shell for querying tool resolution"
    )

    @Argument(help: "Path to the compiled toolkit file")
    var file: String

    @Option(help: "Number of results to show")
    var topK: Int = 5

    @Option(help: "Minimum similarity threshold")
    var threshold: Float = 0.5

    func run() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: file))
        guard let artifact = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let selectorsDict = artifact["selectors"] as? [String: Any],
              let dispatchTablesDict = artifact["dispatchTables"] as? [String: Any] else {
            print("Failed to parse artifact")
            throw ExitCode.failure
        }

        // Set up embedder and index
        let embedder = LocalEmbedder()
        let vectorIndex = MemoryVectorIndex()
        let selectorTable = SelectorTable(index: vectorIndex, embedder: embedder)

        // Load selectors
        for (_, selValue) in selectorsDict {
            guard let sel = selValue as? [String: Any],
                  let canonical = sel["canonical"] as? String,
                  let vectorArr = sel["vector"] as? [NSNumber] else { continue }
            let vector = vectorArr.map { Float(truncating: $0) }
            _ = try await selectorTable.intern(embedding: vector, canonical: canonical)
        }

        let selectorCount = selectorsDict.count
        let providerCount = dispatchTablesDict.count

        print("smallchat repl v0.2.0")
        print("Loaded \(selectorCount) selectors from \(providerCount) providers")
        print("Type an intent to resolve, or :help for commands.\n")

        // REPL loop
        while true {
            print("smallchat> ", terminator: "")
            guard let line = readLine()?.trimmingCharacters(in: .whitespaces) else {
                print("\nGoodbye.")
                break
            }

            if line.isEmpty { continue }

            if line.hasPrefix(":") {
                let parts = line.dropFirst().split(separator: " ", maxSplits: 1)
                let cmd = String(parts[0])

                switch cmd {
                case "help", "h":
                    print("\nCommands:")
                    print("  :help, :h         Show this help")
                    print("  :providers, :p    List all providers")
                    print("  :selectors, :s    List all selectors")
                    print("  :stats            Show artifact stats")
                    print("  :quit, :q         Exit the REPL")
                    print("\nType any natural language intent to resolve.\n")

                case "providers", "p":
                    print("\nProviders:")
                    for (providerId, table) in dispatchTablesDict {
                        let count = (table as? [String: Any])?.count ?? 0
                        print("  \(providerId): \(count) tools")
                    }
                    print("")

                case "selectors", "s":
                    print("\nSelectors:")
                    for (_, selValue) in selectorsDict {
                        if let s = selValue as? [String: Any],
                           let canonical = s["canonical"] as? String,
                           let arity = s["arity"] as? Int {
                            print("  \(canonical) (arity: \(arity))")
                        }
                    }
                    print("")

                case "stats":
                    if let stats = artifact["stats"] as? [String: Any] {
                        print("\nArtifact stats:")
                        print("  Version:    \(artifact["version"] as? String ?? "unknown")")
                        print("  Compiled:   \(artifact["timestamp"] as? String ?? "unknown")")
                        print("  Tools:      \(stats["toolCount"] ?? 0)")
                        print("  Selectors:  \(stats["uniqueSelectorCount"] ?? 0)")
                        print("  Providers:  \(stats["providerCount"] ?? 0)")
                        print("  Collisions: \(stats["collisionCount"] ?? 0)")
                    }
                    print("")

                case "quit", "q":
                    print("Goodbye.")
                    return

                default:
                    print("Unknown command: :\(cmd). Type :help for available commands.\n")
                }
                continue
            }

            // Resolve intent
            do {
                let selector = try await selectorTable.resolve(line)
                let matches = try await vectorIndex.search(query: selector.vector, topK: topK, threshold: threshold)

                print("\n  Intent:    \"\(line)\"")
                print("  Selector:  \(selector.canonical)")

                if matches.isEmpty {
                    print("  Matches:   none\n")
                } else {
                    print("  Matches:")
                    for match in matches {
                        let confidence = String(format: "%5.1f", (1 - match.distance) * 100)
                        var provider = "unknown"
                        for (pid, table) in dispatchTablesDict {
                            if let methods = table as? [String: Any], methods[match.id] != nil {
                                provider = pid
                                break
                            }
                        }
                        print("    \(confidence)%  \(match.id)  (\(provider))")
                    }
                    print("")
                }
            } catch {
                print("  Error: \(error)\n")
            }
        }
    }
}
