import Foundation

private let stopwords: Set<String> = [
    "a", "an", "the", "my", "your", "our", "their", "its",
    "is", "are", "was", "were", "be", "been", "being",
    "in", "on", "at", "to", "for", "of", "with", "by",
    "and", "or", "but", "not", "no", "do", "does", "did",
    "have", "has", "had", "will", "would", "could", "should",
    "can", "may", "might", "shall", "that", "this", "these",
    "those", "it", "i", "me", "we", "us", "you", "he", "she",
    "him", "her", "they", "them", "some", "all", "any", "each",
    "about", "from", "into", "please",
]

/// Convert a natural language intent into a canonical selector form.
/// "find my recent documents" -> "find:recent:documents"
public func canonicalize(_ intent: String) -> String {
    let lowered = intent.lowercased()

    // Remove non-alphanumeric characters (keep spaces and digits)
    let cleaned = lowered.unicodeScalars.map { scalar -> Character in
        if CharacterSet.alphanumerics.contains(scalar) || scalar == " " {
            return Character(scalar)
        }
        return " "
    }

    let words = String(cleaned)
        .split(separator: " ")
        .map { String($0) }
        .filter { !$0.isEmpty && !stopwords.contains($0) }

    let result = words.joined(separator: ":")
    return result.isEmpty ? "unknown" : result
}
