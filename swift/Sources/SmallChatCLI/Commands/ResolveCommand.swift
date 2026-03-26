import ArgumentParser
import Foundation
import SmallChat

struct ResolveCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "resolve",
        abstract: "Test dispatch resolution against a compiled artifact"
    )

    @Argument(help: "Path to the compiled toolkit file")
    var file: String

    @Argument(help: "Natural language intent to resolve")
    var intent: String

    @Option(name: .shortAndLong, help: "Number of results")
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

        // Load selectors from artifact
        for (_, selValue) in selectorsDict {
            guard let sel = selValue as? [String: Any],
                  let canonical = sel["canonical"] as? String,
                  let vectorArr = sel["vector"] as? [NSNumber] else { continue }
            let vector = vectorArr.map { Float(truncating: $0) }
            _ = try await selectorTable.intern(embedding: vector, canonical: canonical)
        }

        // Resolve
        let selector = try await selectorTable.resolve(intent)
        let matches = try await vectorIndex.search(query: selector.vector, topK: topK, threshold: threshold)

        print("Intent: \"\(intent)\"")
        print("Resolved selector: \(selector.canonical)")
        print("")

        if matches.isEmpty {
            print("No matches found.")
            return
        }

        print("Matches:")
        for match in matches {
            let confidence = String(format: "%.1f", (1 - match.distance) * 100)
            var provider = "unknown"
            for (providerId, table) in dispatchTablesDict {
                if let methods = table as? [String: Any], methods[match.id] != nil {
                    provider = providerId
                    break
                }
            }
            print("  -> \(match.id) (confidence: \(confidence)%, provider: \(provider))")
        }

        let best = matches[0]
        let bestConfidence = (1 - best.distance) * 100
        if bestConfidence > 90 {
            print("\nUnambiguous: \(best.id) (\(String(format: "%.1f", bestConfidence))%)")
        } else if matches.count > 1 {
            print("\nAmbiguous: top match is \(best.id) (\(String(format: "%.1f", bestConfidence))%). Disambiguation may be needed.")
        }
    }
}
