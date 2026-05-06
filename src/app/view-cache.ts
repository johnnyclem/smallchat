import type { AppIMP, ComponentSelector } from '../core/types.js';

export interface ResolvedComponent {
  selector: ComponentSelector;
  imp: AppIMP;
  confidence: number;
  resolvedAt: number;
  hitCount: number;
  /** ui:// resource version tag at resolution time */
  uriVersion?: string;
  /** Host/bridge version tag at resolution time */
  hostVersion?: string;
}

export interface ViewCacheVersionContext {
  uriVersions: Map<string, string>;   // componentUri → version
  hostVersion: string;
}

/**
 * ViewCache — the objc_msgSend inline cache for UI component dispatch.
 *
 * Mirrors ResolutionCache in src/core/resolution-cache.ts, but tracks
 * resolved AppIMPs rather than ToolIMPs.
 *
 * Entries are version-tagged against ui:// resource versions and the host
 * version. Stale entries are evicted on lookup so callers see a clean miss.
 *
 * Unlike ResolutionCache, ViewCache does NOT track mounted iframe instances —
 * that lifecycle lives in AppBridgePool. This cache only maps
 * ComponentSelector → AppIMP (the "which view handles this intent" mapping).
 */
export class ViewCache {
  private cache: Map<string, ResolvedComponent> = new Map();
  private readonly maxSize: number;
  private readonly minConfidence: number;
  private versionContext: ViewCacheVersionContext;

  constructor(
    maxSize = 512,
    minConfidence = 0.75,
    versionContext?: ViewCacheVersionContext,
  ) {
    this.maxSize = maxSize;
    this.minConfidence = minConfidence;
    this.versionContext = versionContext ?? {
      uriVersions: new Map(),
      hostVersion: '',
    };
  }

  /** Hot path — returns null on cache miss or stale entry */
  lookup(selector: ComponentSelector): ResolvedComponent | null {
    const key = selector.canonical;
    const cached = this.cache.get(key);
    if (!cached) return null;

    // Stale check: uri version changed
    if (cached.uriVersion) {
      const current = this.versionContext.uriVersions.get(cached.imp.componentUri);
      if (current && current !== cached.uriVersion) {
        this.cache.delete(key);
        return null;
      }
    }

    // Stale check: host version changed
    if (cached.hostVersion && this.versionContext.hostVersion &&
        cached.hostVersion !== this.versionContext.hostVersion) {
      this.cache.delete(key);
      return null;
    }

    cached.hitCount++;
    return cached;
  }

  /** Store a resolved component in the cache */
  store(selector: ComponentSelector, imp: AppIMP, confidence: number): void {
    if (confidence < this.minConfidence) return;

    // Evict LRU entry when at capacity
    if (this.cache.size >= this.maxSize) {
      const lruKey = this.cache.keys().next().value;
      if (lruKey !== undefined) this.cache.delete(lruKey);
    }

    const uriVersion = this.versionContext.uriVersions.get(imp.componentUri);

    this.cache.set(selector.canonical, {
      selector,
      imp,
      confidence,
      resolvedAt: Date.now(),
      hitCount: 0,
      uriVersion,
      hostVersion: this.versionContext.hostVersion || undefined,
    });
  }

  /** Invalidate all entries for a given ui:// URI */
  invalidateUri(uri: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.imp.componentUri === uri) {
        this.cache.delete(key);
      }
    }
  }

  /** Flush the entire cache */
  flush(): void {
    this.cache.clear();
  }

  /** Update the version context (triggers stale-on-next-lookup) */
  updateVersionContext(ctx: Partial<ViewCacheVersionContext>): void {
    if (ctx.uriVersions) this.versionContext.uriVersions = ctx.uriVersions;
    if (ctx.hostVersion !== undefined) this.versionContext.hostVersion = ctx.hostVersion;
  }

  get size(): number {
    return this.cache.size;
  }
}
