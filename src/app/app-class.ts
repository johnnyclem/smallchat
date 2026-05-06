import type { AppIMP, AppMethod, AppProtocol, AppExtension, ComponentSelector } from '../core/types.js';

/**
 * AppClass — a group of related UI components from one provider.
 *
 * Mirrors ToolClass in src/core/tool-class.ts, but operates on the component
 * dispatch space (ComponentSelector → AppIMP) rather than the tool dispatch
 * space (ToolSelector → ToolIMP).
 *
 * Obj-C analogy:
 *   componentDispatchTable = dispatch table
 *   resolveComponent()     = method_getImplementation()
 *   superclass             = isa chain
 *   loadExtension()        = objc_registerCategoryMethods()
 */
export class AppClass {
  readonly name: string;
  readonly providerId: string;
  readonly protocols: AppProtocol[] = [];
  readonly componentDispatchTable: Map<string, AppIMP> = new Map();
  superclass: AppClass | null = null;

  constructor(name: string, providerId: string) {
    this.name = name;
    this.providerId = providerId;
  }

  /** Register a component (ComponentSelector → AppIMP mapping) */
  addComponent(selector: ComponentSelector, imp: AppIMP): void {
    this.componentDispatchTable.set(selector.canonical, imp);
  }

  /** Declare conformance to an AppProtocol (UI capability interface) */
  addProtocol(protocol: AppProtocol): void {
    this.protocols.push(protocol);
  }

  /**
   * Resolve a ComponentSelector to an AppIMP.
   * Equivalent to method_getImplementation() — walks the componentDispatchTable
   * then the superclass ISA chain.
   */
  resolveComponent(selector: ComponentSelector): AppIMP | null {
    const direct = this.componentDispatchTable.get(selector.canonical);
    if (direct) return direct;

    // Walk ISA chain (superclass traversal)
    if (this.superclass) {
      return this.superclass.resolveComponent(selector);
    }

    return null;
  }

  /**
   * Load an AppExtension — the Category analogy.
   * Adds new component types to this AppClass without modifying its definition.
   * Runtime-only; extensions are not persisted to the compiled artifact.
   */
  loadExtension(ext: AppExtension): void {
    for (const method of ext.methods) {
      // Extensions may override existing components (like category method swizzling)
      this.componentDispatchTable.set(method.selector.canonical, method.imp);
    }
  }

  /**
   * respondsToComponent: — check whether this class (or any superclass)
   * handles a given ComponentSelector. Equivalent to respondsToSelector:.
   */
  respondsToComponent(selector: ComponentSelector): boolean {
    return this.resolveComponent(selector) !== null;
  }

  /**
   * Check AppProtocol conformance — does this class declare conformance
   * to a protocol and implement all its required components?
   */
  conformsToProtocol(protocolName: string): boolean {
    return this.protocols.some(p => p.name === protocolName);
  }

  /** All AppMethods registered on this class (not including superclass) */
  ownMethods(): AppMethod[] {
    const methods: AppMethod[] = [];
    for (const [canonical, imp] of this.componentDispatchTable) {
      // Reconstruct a minimal ComponentSelector for the return value
      const parts = canonical.split(':').filter(Boolean);
      methods.push({
        selector: {
          canonical,
          parts,
          arity: Math.max(0, parts.length - 1),
          vector: new Float32Array(0),
        },
        imp,
      });
    }
    return methods;
  }
}
