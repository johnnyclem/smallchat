import type { ToolSelector } from './types.js';
import { canonicalize } from './selector-table.js';

/**
 * IntentPinPolicy — how a pinned selector must be matched.
 *
 * - 'exact': Only an exact canonical string match dispatches to this tool.
 *   Cosine similarity is bypassed entirely. This is the strongest guard
 *   against semantic collision attacks.
 *
 * - 'elevated': Requires a significantly higher cosine similarity score
 *   (default 0.98) than the standard dispatch threshold (0.75).
 *   Still uses embeddings but with a much tighter tolerance.
 */
export type IntentPinPolicy = 'exact' | 'elevated';

/**
 * IntentPin — a single pinned selector entry.
 */
export interface IntentPin {
  /** The canonical selector string that is pinned */
  canonical: string;
  /** Match policy for this pin */
  policy: IntentPinPolicy;
  /** Custom threshold override for 'elevated' policy (default 0.98) */
  threshold?: number;
  /** Optional list of exact alias strings that also resolve to this selector */
  aliases?: string[];
}

/**
 * IntentPinMatch — result of checking an intent against the pin registry.
 */
export interface IntentPinMatch {
  /** The pinned selector canonical name that matched */
  canonical: string;
  /** Whether the match was accepted or rejected */
  verdict: 'accept' | 'reject';
  /** The policy that was applied */
  policy: IntentPinPolicy;
  /** For elevated policy: the actual similarity score */
  similarity?: number;
  /** For elevated policy: the required threshold */
  requiredThreshold?: number;
}

/** Default elevated-policy threshold */
const DEFAULT_ELEVATED_THRESHOLD = 0.98;

/**
 * IntentPinRegistry — guards sensitive selectors against semantic collision.
 *
 * High-risk ToolClasses (e.g., delete_record, transfer_funds) can be pinned
 * so that they require either an exact canonical string match or a
 * significantly higher similarity score than the standard dispatch threshold.
 *
 * This prevents an attacker from crafting an input intent that is
 * semantically close enough to "bridge" to a privileged tool via the
 * standard cosine similarity dispatch.
 */
export class IntentPinRegistry {
  /** Pinned selectors keyed by canonical name */
  private pins: Map<string, IntentPin> = new Map();
  /** Reverse map: alias canonical → pin canonical */
  private aliasIndex: Map<string, string> = new Map();

  /** Pin a selector with a given policy */
  pin(entry: IntentPin): void {
    this.pins.set(entry.canonical, entry);

    // Index aliases
    if (entry.aliases) {
      for (const alias of entry.aliases) {
        const aliasCanonical = canonicalize(alias);
        this.aliasIndex.set(aliasCanonical, entry.canonical);
      }
    }
  }

  /** Remove a pin */
  unpin(canonical: string): void {
    const existing = this.pins.get(canonical);
    if (existing?.aliases) {
      for (const alias of existing.aliases) {
        this.aliasIndex.delete(canonicalize(alias));
      }
    }
    this.pins.delete(canonical);
  }

  /** Check if a selector canonical name is pinned */
  isPinned(canonical: string): boolean {
    return this.pins.has(canonical);
  }

  /** Get the pin entry for a canonical name */
  getPin(canonical: string): IntentPin | undefined {
    return this.pins.get(canonical);
  }

  /** Number of pinned selectors */
  get size(): number {
    return this.pins.size;
  }

  /** All pinned canonicals */
  pinnedCanonicals(): string[] {
    return Array.from(this.pins.keys());
  }

  /**
   * Check an intent against all pinned selectors.
   *
   * For 'exact' policy: the intent's canonical form must exactly match
   * the pinned canonical (or one of its aliases).
   *
   * For 'elevated' policy: the cosine similarity between the intent
   * embedding and the pinned selector's embedding must exceed the
   * elevated threshold.
   *
   * Returns null if the intent doesn't interact with any pinned selector
   * (i.e., it's free to proceed through normal dispatch).
   *
   * Returns an IntentPinMatch if the intent matched (or was blocked by)
   * a pinned selector.
   */
  checkExact(
    intentCanonical: string,
  ): IntentPinMatch | null {
    // Direct canonical match against a pinned selector
    const directPin = this.pins.get(intentCanonical);
    if (directPin) {
      return {
        canonical: directPin.canonical,
        verdict: 'accept',
        policy: directPin.policy,
      };
    }

    // Check alias index
    const aliasTarget = this.aliasIndex.get(intentCanonical);
    if (aliasTarget) {
      const pin = this.pins.get(aliasTarget);
      if (pin) {
        return {
          canonical: pin.canonical,
          verdict: 'accept',
          policy: pin.policy,
        };
      }
    }

    return null;
  }

  /**
   * Check whether a vector similarity match to a pinned selector should
   * be accepted or rejected based on the pin's policy.
   *
   * Called during dispatch when a vector search returns a candidate that
   * is pinned. The candidate's similarity score is checked against the
   * pin's policy.
   *
   * @param candidateCanonical - The canonical name of the matched candidate
   * @param similarity - The cosine similarity score (1 - distance)
   * @param intentCanonical - The canonical form of the incoming intent
   * @returns IntentPinMatch if the candidate is pinned, null otherwise
   */
  checkSimilarity(
    candidateCanonical: string,
    similarity: number,
    intentCanonical: string,
  ): IntentPinMatch | null {
    const pin = this.pins.get(candidateCanonical);
    if (!pin) return null;

    if (pin.policy === 'exact') {
      // Exact policy: only accept if canonical strings match exactly
      // (or via alias)
      const isExactMatch =
        intentCanonical === candidateCanonical ||
        this.aliasIndex.get(intentCanonical) === candidateCanonical;

      return {
        canonical: pin.canonical,
        verdict: isExactMatch ? 'accept' : 'reject',
        policy: 'exact',
      };
    }

    if (pin.policy === 'elevated') {
      const threshold = pin.threshold ?? DEFAULT_ELEVATED_THRESHOLD;
      return {
        canonical: pin.canonical,
        verdict: similarity >= threshold ? 'accept' : 'reject',
        policy: 'elevated',
        similarity,
        requiredThreshold: threshold,
      };
    }

    return null;
  }
}
