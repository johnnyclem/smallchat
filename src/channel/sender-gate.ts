/**
 * SenderGate — allowlist-based sender identity gating for channel events.
 *
 * Ensures that only authorized senders can inject messages into the channel.
 * This is the primary defense against prompt injection via channel events.
 *
 * Supports:
 *   - In-memory allowlist (programmatic)
 *   - File-based allowlist (one sender per line, reloadable)
 *   - Optional pairing code flow for bootstrap
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import { randomBytes } from 'node:crypto';

export class SenderGate {
  private allowlist: Set<string> = new Set();
  private allowlistFile: string | null = null;
  private pendingPairings: Map<string, { code: string; expiresAt: number }> = new Map();

  constructor(options?: {
    allowlist?: string[];
    allowlistFile?: string;
  }) {
    if (options?.allowlist) {
      for (const sender of options.allowlist) {
        this.allowlist.add(sender.toLowerCase().trim());
      }
    }

    if (options?.allowlistFile) {
      this.allowlistFile = options.allowlistFile;
      this.loadAllowlistFile();
      this.watchAllowlistFile();
    }
  }

  /**
   * Check if a sender is allowed to send messages.
   * Returns true if the allowlist is empty (open mode) or sender is listed.
   */
  check(sender: string | undefined): boolean {
    // If no allowlist configured, gate is open (but warn in logs)
    if (this.allowlist.size === 0) {
      return true;
    }

    if (!sender) return false;
    return this.allowlist.has(sender.toLowerCase().trim());
  }

  /**
   * Whether gating is enabled (allowlist has entries).
   */
  get enabled(): boolean {
    return this.allowlist.size > 0;
  }

  /**
   * Add a sender to the allowlist.
   */
  allow(sender: string): void {
    this.allowlist.add(sender.toLowerCase().trim());
  }

  /**
   * Remove a sender from the allowlist.
   */
  revoke(sender: string): void {
    this.allowlist.delete(sender.toLowerCase().trim());
  }

  /**
   * Get all allowed senders.
   */
  getAllowed(): string[] {
    return Array.from(this.allowlist);
  }

  /**
   * Generate a pairing code for a new sender.
   * The sender must reply with this code to be added to the allowlist.
   *
   * Returns the pairing code (6 hex characters).
   * Expires after 5 minutes.
   */
  generatePairingCode(senderId: string): string {
    const code = randomBytes(3).toString('hex'); // 6 hex chars
    this.pendingPairings.set(senderId.toLowerCase().trim(), {
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    return code;
  }

  /**
   * Attempt to complete a pairing by verifying the code.
   * If successful, adds the sender to the allowlist.
   */
  completePairing(senderId: string, code: string): boolean {
    const normalized = senderId.toLowerCase().trim();
    const pending = this.pendingPairings.get(normalized);

    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
      this.pendingPairings.delete(normalized);
      return false;
    }
    if (pending.code !== code.toLowerCase().trim()) return false;

    this.pendingPairings.delete(normalized);
    this.allowlist.add(normalized);
    return true;
  }

  /**
   * Clean up file watchers.
   */
  destroy(): void {
    if (this.allowlistFile) {
      unwatchFile(this.allowlistFile);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private loadAllowlistFile(): void {
    if (!this.allowlistFile || !existsSync(this.allowlistFile)) return;

    try {
      const content = readFileSync(this.allowlistFile, 'utf-8');
      const lines = content.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));

      for (const line of lines) {
        this.allowlist.add(line.toLowerCase());
      }
    } catch {
      // File read error — non-critical
    }
  }

  private watchAllowlistFile(): void {
    if (!this.allowlistFile) return;

    watchFile(this.allowlistFile, { interval: 5000 }, () => {
      this.loadAllowlistFile();
    });
  }
}
