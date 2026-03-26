// MARK: - Sender Gate
// Allowlist-based sender identity gating for channel events.
// Primary defense against prompt injection via channel events.

import Foundation
#if canImport(Security)
import Security
#endif

/// Allowlist-based sender identity gating for channel events.
///
/// Ensures that only authorized senders can inject messages into the channel.
/// Supports:
///   - In-memory allowlist (programmatic)
///   - File-based allowlist (one sender per line, reloadable)
///   - Optional pairing code flow for bootstrap
public actor SenderGate {
    private var allowlist: Set<String> = []
    private let allowlistFilePath: String?
    private var pendingPairings: [String: PendingPairing] = [:]

    /// Pairing code expiry duration in seconds (5 minutes).
    private let pairingExpirySeconds: TimeInterval = 5 * 60

    private struct PendingPairing {
        let code: String
        let expiresAt: Date
    }

    public init(allowlist: [String]? = nil, allowlistFile: String? = nil) {
        self.allowlistFilePath = allowlistFile

        if let senders = allowlist {
            for sender in senders {
                let normalized = sender.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
                if !normalized.isEmpty {
                    self.allowlist.insert(normalized)
                }
            }
        }

        if allowlistFile != nil {
            loadAllowlistFile()
        }
    }

    // MARK: - Checking

    /// Check if a sender is allowed to send messages.
    /// Returns true if the allowlist is empty (open mode) or sender is listed.
    public func check(_ sender: String?) -> Bool {
        // If no allowlist configured, gate is open
        if allowlist.isEmpty {
            return true
        }

        guard let sender, !sender.isEmpty else { return false }
        return allowlist.contains(sender.lowercased().trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Whether gating is enabled (allowlist has entries).
    public var isEnabled: Bool {
        !allowlist.isEmpty
    }

    // MARK: - Management

    /// Add a sender to the allowlist.
    public func allow(_ sender: String) {
        let normalized = sender.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return }
        allowlist.insert(normalized)
    }

    /// Remove a sender from the allowlist.
    public func revoke(_ sender: String) {
        let normalized = sender.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        allowlist.remove(normalized)
    }

    /// Get all allowed senders.
    public func getAllowed() -> [String] {
        Array(allowlist)
    }

    // MARK: - Pairing

    /// Generate a pairing code for a new sender.
    /// The sender must reply with this code to be added to the allowlist.
    /// Returns the pairing code (6 hex characters). Expires after 5 minutes.
    public func generatePairingCode(for senderId: String) -> String {
        let normalized = senderId.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let code = generateHexCode(length: 6)
        let pairing = PendingPairing(
            code: code,
            expiresAt: Date().addingTimeInterval(pairingExpirySeconds)
        )
        pendingPairings[normalized] = pairing
        return code
    }

    /// Attempt to complete a pairing by verifying the code.
    /// If successful, adds the sender to the allowlist.
    public func completePairing(senderId: String, code: String) -> Bool {
        let normalized = senderId.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard let pending = pendingPairings[normalized] else { return false }

        if Date() > pending.expiresAt {
            pendingPairings.removeValue(forKey: normalized)
            return false
        }

        if pending.code != code.lowercased().trimmingCharacters(in: .whitespacesAndNewlines) {
            return false
        }

        pendingPairings.removeValue(forKey: normalized)
        allowlist.insert(normalized)
        return true
    }

    // MARK: - File Loading

    /// Reload the allowlist from the configured file.
    public func reloadAllowlistFile() {
        loadAllowlistFile()
    }

    // MARK: - Private

    private func loadAllowlistFile() {
        guard let path = allowlistFilePath else { return }
        guard FileManager.default.fileExists(atPath: path) else { return }

        do {
            let content = try String(contentsOfFile: path, encoding: .utf8)
            let lines = content.components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && !$0.hasPrefix("#") }

            for line in lines {
                allowlist.insert(line.lowercased())
            }
        } catch {
            // File read error -- non-critical, silently ignore
        }
    }

    /// Generate a random hex string of the given length.
    private func generateHexCode(length: Int) -> String {
        let byteCount = (length + 1) / 2
        var bytes = [UInt8](repeating: 0, count: byteCount)
        #if canImport(Security)
        _ = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        #else
        // Linux: read from /dev/urandom
        if let fh = FileHandle(forReadingAtPath: "/dev/urandom") {
            let data = fh.readData(ofLength: byteCount)
            fh.closeFile()
            for (i, byte) in data.enumerated() where i < byteCount {
                bytes[i] = byte
            }
        } else {
            // Fallback: use system random
            for i in 0..<byteCount {
                bytes[i] = UInt8.random(in: 0...255)
            }
        }
        #endif
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(length))
    }
}
