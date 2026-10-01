/**
 * IntentPinPolicy — how a pinned selector must be matched.
 *
 * - 'exact': Only a pinned phrase dispatches to this tool: the pin's
 *   canonical or one of its aliases, compared as whole phrases after
 *   normalizePinPhrase (so "do not transfer funds" never matches the alias
 *   "transfer funds"). Cosine similarity is never enough. This is the
 *   strongest guard against semantic collision attacks.
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
  /** Optional list of exact phrases that also resolve to this selector */
  aliases?: string[];
}

/**
 * The form pinned phrases are compared in: Unicode NFKC, lower case,
 * trimmed, internal whitespace collapsed to one space. Nothing else is
 * removed — no stopwords, no punctuation — so negations and qualifiers
 * keep two phrases apart.
 */
export function normalizePinPhrase(text: string): string {
  return text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
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
  /** Normalized pinned phrase (canonical or alias) → pin canonical */
  private phraseIndex: Map<string, string> = new Map();

  /** Pin a selector with a given policy */
  pin(entry: IntentPin): void {
    if (this.pins.has(entry.canonical)) this.unpin(entry.canonical);
    this.pins.set(entry.canonical, entry);
    for (const phrase of [entry.canonical, ...(entry.aliases ?? [])]) {
      this.phraseIndex.set(normalizePinPhrase(phrase), entry.canonical);
    }
  }

  /** Remove a pin */
  unpin(canonical: string): void {
    for (const [phrase, target] of this.phraseIndex) {
      if (target === canonical) this.phraseIndex.delete(phrase);
    }
    this.pins.delete(canonical);
  }

  /** Whether `intent` is one of the pinned phrases of the pin on `canonical`. */
  matchesPinnedPhrase(canonical: string, intent: string): boolean {
    return this.phraseIndex.get(normalizePinPhrase(intent)) === canonical;
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
   * Is the intent, as a whole phrase, one of the pinned phrases (a pin's
   * canonical or alias, compared with normalizePinPhrase)? Returns the
   * accepted pin, or null when the intent is not a pinned phrase.
   *
   * Pass the raw intent text. The 0.x behaviour of comparing
   * canonicalize()d forms is gone: canonicalize drops words such as "not",
   * which let "do not transfer funds" match the alias "transfer funds".
   */
  checkExact(intent: string): IntentPinMatch | null {
    const target = this.phraseIndex.get(normalizePinPhrase(intent));
    const pin = target === undefined ? undefined : this.pins.get(target);
    if (!pin) return null;
    return { canonical: pin.canonical, verdict: 'accept', policy: pin.policy };
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
   * @param similarity - The cosine similarity score (1 - distance), from
   *   the intent's own embedding
   * @param intent - The incoming intent text (raw; normalized here)
   * @returns IntentPinMatch if the candidate is pinned, null otherwise
   */
  checkSimilarity(
    candidateCanonical: string,
    similarity: number,
    intent: string,
  ): IntentPinMatch | null {
    const pin = this.pins.get(candidateCanonical);
    if (!pin) return null;

    if (pin.policy === 'exact') {
      // Exact policy: only a pinned phrase is accepted, whatever the score.
      const isExactMatch = this.matchesPinnedPhrase(candidateCanonical, intent);

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
