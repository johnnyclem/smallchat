// MARK: - Channel Utilities
// Meta key filtering, permission reply parsing, payload validation,
// and content serialization for the channel protocol.

import Foundation

// MARK: - Meta Key Filtering

/// Valid meta key pattern: only letters, digits, and underscores.
/// Matches Claude Code behavior -- invalid keys are silently dropped.
private let metaKeyPattern = try! NSRegularExpression(pattern: "^[a-zA-Z0-9_]+$")

/// Keys blocked to prevent prototype-pollution-style attacks.
private let blockedKeys: Set<String> = ["__proto__", "constructor", "prototype"]

/// Filter meta keys to only those containing letters, digits, and underscores.
/// Invalid keys are silently dropped (matching Claude Code behavior).
/// Also prevents prototype pollution by rejecting __proto__, constructor, prototype.
public func filterMetaKeys(_ meta: [String: String]?) -> [String: String]? {
    guard let meta, !meta.isEmpty else { return nil }

    var filtered: [String: String] = [:]
    for (key, value) in meta {
        if blockedKeys.contains(key) { continue }
        if !isValidMetaKey(key) { continue }
        filtered[key] = value
    }

    return filtered.isEmpty ? nil : filtered
}

/// Check if a single meta key is valid.
public func isValidMetaKey(_ key: String) -> Bool {
    guard !key.isEmpty else { return false }
    if blockedKeys.contains(key) { return false }
    let range = NSRange(key.startIndex..., in: key)
    return metaKeyPattern.firstMatch(in: key, range: range) != nil
}

// MARK: - Permission Reply Parsing

/// Permission request ID pattern: 5 lowercase letters excluding 'l'.
/// Matches: [a-km-z]{5}
private let permissionIdPattern = try! NSRegularExpression(pattern: "^[a-km-z]{5}$")

/// Result of parsing a permission reply message.
public struct ParsedPermissionReply: Sendable, Equatable {
    public let requestId: String
    public let behavior: PermissionBehavior
}

/// Parse a permission reply message from a remote user.
/// Accepts: "yes <id>", "no <id>" (case-insensitive).
/// Returns nil if the message does not match the expected format.
public func parsePermissionReply(_ message: String) -> ParsedPermissionReply? {
    let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }

    let replyPattern = try! NSRegularExpression(pattern: "^(yes|no)\\s+([a-km-z]{5})$", options: .caseInsensitive)
    let range = NSRange(trimmed.startIndex..., in: trimmed)
    guard let match = replyPattern.firstMatch(in: trimmed, range: range) else { return nil }

    guard let verdictRange = Range(match.range(at: 1), in: trimmed),
          let idRange = Range(match.range(at: 2), in: trimmed) else { return nil }

    let verdict = String(trimmed[verdictRange]).lowercased()
    let requestId = String(trimmed[idRange]).lowercased()

    guard isValidPermissionId(requestId) else { return nil }

    return ParsedPermissionReply(
        requestId: requestId,
        behavior: verdict == "yes" ? .allow : .deny
    )
}

/// Validate a permission request ID format.
public func isValidPermissionId(_ id: String) -> Bool {
    guard !id.isEmpty else { return false }
    let range = NSRange(id.startIndex..., in: id)
    return permissionIdPattern.firstMatch(in: id, range: range) != nil
}

// MARK: - Payload Size Validation

/// Default maximum payload size in bytes (64KB).
public let defaultMaxPayloadBytes: Int = 64 * 1024

/// Result of a payload size validation check.
public struct PayloadSizeCheck: Sendable, Equatable {
    public let valid: Bool
    public let size: Int
    public let limit: Int
}

/// Check if a payload exceeds the size limit.
public func validatePayloadSize(
    _ content: String,
    maxBytes: Int = defaultMaxPayloadBytes
) -> PayloadSizeCheck {
    let size = content.utf8.count
    return PayloadSizeCheck(valid: size <= maxBytes, size: size, limit: maxBytes)
}

// MARK: - Channel Tag Serialization

/// Serialize a channel event into a `<channel>` XML tag for LLM prompt injection.
/// This is the format Claude Code uses to present channel events in context.
public func serializeChannelTag(
    channel: String,
    content: String,
    meta: [String: String]? = nil
) -> String {
    var attrs = ["source=\"\(escapeXmlAttr(channel))\""]

    if let meta {
        // Sort keys for deterministic output
        for key in meta.keys.sorted() {
            if isValidMetaKey(key) {
                attrs.append("\(key)=\"\(escapeXmlAttr(meta[key]!))\"")
            }
        }
    }

    return "<channel \(attrs.joined(separator: " "))>\n\(content)\n</channel>"
}

/// Escape a string for use in an XML attribute value.
private func escapeXmlAttr(_ str: String) -> String {
    str.replacingOccurrences(of: "&", with: "&amp;")
       .replacingOccurrences(of: "\"", with: "&quot;")
       .replacingOccurrences(of: "<", with: "&lt;")
       .replacingOccurrences(of: ">", with: "&gt;")
}
