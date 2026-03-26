import SmallChatCore
import Foundation

/// Hash-based embedding for development/testing.
/// Uses FNV-1a + character trigram hashing to produce fixed-dimension vectors.
/// Not semantically meaningful, but deterministic and fast.
public struct LocalEmbedder: Embedder, Sendable {
    public let dimensions: Int

    public init(dimensions: Int = 384) {
        self.dimensions = dimensions
    }

    public func embed(_ text: String) async throws -> [Float] {
        hashEmbed(text, dimensions: dimensions)
    }

    public func embedBatch(_ texts: [String]) async throws -> [[Float]] {
        texts.map { hashEmbed($0, dimensions: dimensions) }
    }
}

private func hashEmbed(_ text: String, dimensions: Int) -> [Float] {
    var vector = [Float](repeating: 0, count: dimensions)
    let normalized = text.lowercased().filter { $0.isLetter || $0.isNumber || $0.isWhitespace }
    let words = normalized.split(separator: " ").map(String.init).filter { !$0.isEmpty }

    for word in words {
        let h = fnv1a(word)
        let idx = abs(h) % dimensions
        vector[idx] += 1.0

        // Character trigrams for sub-word similarity
        if word.count >= 3 {
            let chars = Array(word)
            for i in 0...(chars.count - 3) {
                let trigram = String(chars[i..<(i + 3)])
                let tIdx = abs(fnv1a(trigram)) % dimensions
                vector[tIdx] += 0.5
            }
        }
    }

    // L2 normalize
    l2Normalize(&vector)
    return vector
}

/// FNV-1a hash for strings
private func fnv1a(_ str: String) -> Int {
    var hash: UInt32 = 0x811c9dc5
    for byte in str.utf8 {
        hash ^= UInt32(byte)
        hash = hash &* 0x01000193
    }
    return Int(Int32(bitPattern: hash))
}
