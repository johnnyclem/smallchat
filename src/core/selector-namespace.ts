/**
 * SelectorNamespace — guards core system selectors from being shadowed
 * by newly registered ToolClasses.
 *
 * When a selector is registered as "core", no ToolClass may overwrite it
 * unless it has been explicitly marked as swizzlable. This prevents
 * accidental (or malicious) selector shadowing where a plugin overwrites
 * fundamental system behavior.
 *
 * Analogous to Objective-C's `+load` protections and Swift's `@objc dynamic`
 * requirement for method swizzling.
 */

export interface CoreSelectorEntry {
  /** The canonical selector name, e.g. "dispatch:intent" */
  canonical: string;
  /** The provider that owns this core selector */
  ownerClass: string;
  /** Whether this selector may be replaced via swizzle or re-registration */
  swizzlable: boolean;
}

/**
 * SelectorShadowingError — thrown when a ToolClass attempts to register
 * a method that would shadow a protected core selector.
 */
export class SelectorShadowingError extends Error {
  readonly selector: string;
  readonly existingOwner: string;
  readonly offendingClass: string;

  constructor(selector: string, existingOwner: string, offendingClass: string) {
    super(
      `Selector shadowing blocked: "${selector}" is a core selector owned by "${existingOwner}" ` +
      `and cannot be overwritten by "${offendingClass}". ` +
      `Mark the selector as swizzlable to allow replacement.`,
    );
    this.name = 'SelectorShadowingError';
    this.selector = selector;
    this.existingOwner = existingOwner;
    this.offendingClass = offendingClass;
  }
}

export class SelectorNamespace {
  /** Core selectors keyed by canonical name */
  private coreSelectors: Map<string, CoreSelectorEntry> = new Map();

  /**
   * Register a selector as a core system selector.
   *
   * @param canonical - The canonical selector name
   * @param ownerClass - The class that owns this selector
   * @param swizzlable - Whether this selector may be replaced (default: false)
   */
  registerCore(canonical: string, ownerClass: string, swizzlable = false): void {
    this.coreSelectors.set(canonical, { canonical, ownerClass, swizzlable });
  }

  /**
   * Register multiple selectors as core for a given owner class.
   */
  registerCoreSelectors(
    ownerClass: string,
    selectors: Array<{ canonical: string; swizzlable?: boolean }>,
  ): void {
    for (const { canonical, swizzlable } of selectors) {
      this.registerCore(canonical, ownerClass, swizzlable ?? false);
    }
  }

  /**
   * Mark an existing core selector as swizzlable, allowing future replacement.
   * Returns false if the selector is not registered as core.
   */
  markSwizzlable(canonical: string): boolean {
    const entry = this.coreSelectors.get(canonical);
    if (!entry) return false;
    entry.swizzlable = true;
    return true;
  }

  /**
   * Mark an existing core selector as non-swizzlable (protected).
   * Returns false if the selector is not registered as core.
   */
  markProtected(canonical: string): boolean {
    const entry = this.coreSelectors.get(canonical);
    if (!entry) return false;
    entry.swizzlable = false;
    return true;
  }

  /**
   * Check whether a selector canonical name would shadow a protected core selector.
   *
   * Returns the blocking CoreSelectorEntry if shadowing is not allowed,
   * or null if the selector is safe to register (either not core, or swizzlable).
   */
  checkShadowing(canonical: string): CoreSelectorEntry | null {
    const entry = this.coreSelectors.get(canonical);
    if (!entry) return null;       // Not a core selector — safe
    if (entry.swizzlable) return null; // Explicitly allowed — safe
    return entry;                  // Blocked
  }

  /**
   * Assert that a set of selector canonical names can be registered by a
   * given class without shadowing. Throws SelectorShadowingError on the
   * first violation.
   */
  assertNoShadowing(classname: string, selectors: string[]): void {
    for (const canonical of selectors) {
      const blocking = this.checkShadowing(canonical);
      if (blocking && blocking.ownerClass !== classname) {
        throw new SelectorShadowingError(canonical, blocking.ownerClass, classname);
      }
    }
  }

  /** Check if a selector is registered as core */
  isCore(canonical: string): boolean {
    return this.coreSelectors.has(canonical);
  }

  /** Check if a core selector is swizzlable */
  isSwizzlable(canonical: string): boolean {
    const entry = this.coreSelectors.get(canonical);
    return entry?.swizzlable ?? false;
  }

  /** Get the core selector entry, if any */
  getEntry(canonical: string): CoreSelectorEntry | undefined {
    return this.coreSelectors.get(canonical);
  }

  /** Remove a selector from core protection */
  unregisterCore(canonical: string): boolean {
    return this.coreSelectors.delete(canonical);
  }

  /** Number of registered core selectors */
  get size(): number {
    return this.coreSelectors.size;
  }

  /** All registered core selectors */
  allCore(): CoreSelectorEntry[] {
    return Array.from(this.coreSelectors.values());
  }
}
