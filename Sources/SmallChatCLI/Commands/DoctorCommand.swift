import ArgumentParser
import Foundation
import SmallChat

struct DoctorCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "doctor",
        abstract: "Check system health: embedder, index, dependencies"
    )

    @Option(help: "Path to database file")
    var dbPath: String = "smallchat.db"

    func run() async throws {
        var allOk = true

        print("smallchat doctor\n")

        // 1. Swift runtime
        print("Swift Runtime:")
        #if swift(>=6.0)
        print("  Swift 6+: available")
        #else
        print("  Swift: available (pre-6.0)")
        #endif
        print("  Platform: \(platformDescription())")

        // 2. Embedder check
        print("\nEmbedder:")
        let embedder = LocalEmbedder()
        do {
            let vec = try await embedder.embed("hello world")
            print("  LocalEmbedder: OK (\(vec.count)-dim vector)")
        } catch {
            print("  LocalEmbedder: FAILED (\(error))")
            allOk = false
        }

        // 3. Vector index check
        print("\nVector Index:")
        let index = MemoryVectorIndex()
        do {
            let testVec: [Float] = Array(repeating: 0.1, count: 384)
            try await index.insert(id: "test", vector: testVec)
            let results = try await index.search(query: testVec, topK: 1, threshold: 0.5)
            if results.count == 1 && results[0].id == "test" {
                print("  MemoryVectorIndex: OK")
            } else {
                print("  MemoryVectorIndex: FAILED (unexpected results)")
                allOk = false
            }
            try await index.remove(id: "test")
        } catch {
            print("  MemoryVectorIndex: FAILED (\(error))")
            allOk = false
        }

        // 4. Cosine similarity check
        print("\nVectorMath:")
        let a: [Float] = [1, 0, 0, 0]
        let b: [Float] = [1, 0, 0, 0]
        let c: [Float] = [0, 1, 0, 0]
        let simSame = cosineSimilarity(a, b)
        let simOrtho = cosineSimilarity(a, c)
        if abs(simSame - 1.0) < 0.001 && abs(simOrtho) < 0.001 {
            print("  Accelerate vDSP cosine similarity: OK")
        } else {
            print("  Accelerate vDSP cosine similarity: FAILED (same=\(simSame), ortho=\(simOrtho))")
            allOk = false
        }

        // 5. Canonicalize check
        print("\nCanonicalize:")
        let canon = canonicalize("find my recent documents")
        if canon == "find:recent:documents" {
            print("  Stopword filtering: OK")
        } else {
            print("  Stopword filtering: UNEXPECTED (\(canon))")
            allOk = false
        }

        // 6. Database file check
        print("\nDatabase:")
        if FileManager.default.fileExists(atPath: dbPath) {
            print("  \(dbPath): exists")
        } else {
            print("  \(dbPath): not yet created (will be created on first compile)")
        }

        // Summary
        print(allOk ? "\nAll checks passed." : "\nSome checks failed. See above for details.")
        if !allOk {
            throw ExitCode.failure
        }
    }

    private func platformDescription() -> String {
        #if os(macOS)
        return "macOS"
        #elseif os(iOS)
        return "iOS"
        #elseif os(Linux)
        return "Linux"
        #else
        return "Unknown"
        #endif
    }
}
