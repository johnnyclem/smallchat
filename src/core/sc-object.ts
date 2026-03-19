import type { ToolIMP, ToolSelector } from './types.js';

/**
 * SCObject — the root of the smallchat object hierarchy.
 *
 * Inspired by NSObject: every non-primitive value that flows through
 * smallchat's parameter passing system is-a SCObject. This gives us:
 *   - A universal `id` pointer for runtime identity
 *   - `isa` class membership for type-safe overload resolution
 *   - `isKindOfClass` / `isMemberOfClass` for dispatch-time type checking
 *   - `description()` for LLM-readable introspection
 *
 * Subclass SCObject to create new parameter types that can be passed
 * into tool functions via positional argument slots.
 */

let nextId = 1;

/** Registry of all SCObject subclasses by class name */
const classRegistry: Map<string, { superclass: string | null }> = new Map();
classRegistry.set('SCObject', { superclass: null });

export function registerClass(name: string, superclass: string): void {
  classRegistry.set(name, { superclass });
}

export function getClassHierarchy(className: string): string[] {
  const chain: string[] = [];
  let current: string | null = className;
  while (current) {
    chain.push(current);
    current = classRegistry.get(current)?.superclass ?? null;
  }
  return chain;
}

export function isSubclass(className: string, parentName: string): boolean {
  return getClassHierarchy(className).includes(parentName);
}

export class SCObject {
  /** Opaque identity pointer — unique per instance */
  readonly id: number;

  /** Class name — equivalent to isa pointer */
  readonly isa: string;

  constructor() {
    this.id = nextId++;
    this.isa = 'SCObject';
  }

  /** NSObject -isKindOfClass: — true if this is an instance of className or any subclass */
  isKindOfClass(className: string): boolean {
    return isSubclass(this.isa, className);
  }

  /** NSObject -isMemberOfClass: — true only if this is exactly the given class */
  isMemberOfClass(className: string): boolean {
    return this.isa === className;
  }

  /** NSObject -respondsToSelector: equivalent — override in subclasses */
  respondsToSelector(_selectorCanonical: string): boolean {
    return false;
  }

  /** LLM-readable string representation */
  description(): string {
    return `<${this.isa} id=${this.id}>`;
  }

  /** Unwrap to the underlying value for IMP execution */
  unwrap(): unknown {
    return this;
  }
}

// ---------------------------------------------------------------------------
// SCSelector — wraps a ToolSelector so it can be passed as a parameter
// ---------------------------------------------------------------------------

registerClass('SCSelector', 'SCObject');

export class SCSelector extends SCObject {
  override readonly isa = 'SCSelector';
  readonly selector: ToolSelector;

  constructor(selector: ToolSelector) {
    super();
    this.selector = selector;
  }

  override description(): string {
    return `<SCSelector id=${this.id} canonical="${this.selector.canonical}">`;
  }

  override unwrap(): ToolSelector {
    return this.selector;
  }
}

// ---------------------------------------------------------------------------
// SCData — wraps arbitrary JSON / structured data
// ---------------------------------------------------------------------------

registerClass('SCData', 'SCObject');

export class SCData extends SCObject {
  override readonly isa = 'SCData';
  readonly value: Record<string, unknown>;

  constructor(value: Record<string, unknown>) {
    super();
    this.value = value;
  }

  get(key: string): unknown {
    return this.value[key];
  }

  has(key: string): boolean {
    return key in this.value;
  }

  keys(): string[] {
    return Object.keys(this.value);
  }

  override description(): string {
    const keys = this.keys().slice(0, 5).join(', ');
    const suffix = this.keys().length > 5 ? '...' : '';
    return `<SCData id=${this.id} keys=[${keys}${suffix}]>`;
  }

  override unwrap(): Record<string, unknown> {
    return this.value;
  }
}

// ---------------------------------------------------------------------------
// SCToolReference — wraps a ToolIMP so tools can be passed to other tools
// ---------------------------------------------------------------------------

registerClass('SCToolReference', 'SCObject');

export class SCToolReference extends SCObject {
  override readonly isa = 'SCToolReference';
  readonly imp: ToolIMP;

  constructor(imp: ToolIMP) {
    super();
    this.imp = imp;
  }

  override description(): string {
    return `<SCToolReference id=${this.id} tool="${this.imp.toolName}" provider="${this.imp.providerId}">`;
  }

  override unwrap(): ToolIMP {
    return this.imp;
  }
}

// ---------------------------------------------------------------------------
// SCArray — ordered collection of SCObjects
// ---------------------------------------------------------------------------

registerClass('SCArray', 'SCObject');

export class SCArray extends SCObject {
  override readonly isa = 'SCArray';
  private items: SCObject[];

  constructor(items: SCObject[] = []) {
    super();
    this.items = [...items];
  }

  get count(): number {
    return this.items.length;
  }

  objectAtIndex(index: number): SCObject | undefined {
    return this.items[index];
  }

  addObject(obj: SCObject): void {
    this.items.push(obj);
  }

  allObjects(): SCObject[] {
    return [...this.items];
  }

  override description(): string {
    return `<SCArray id=${this.id} count=${this.count}>`;
  }

  override unwrap(): unknown[] {
    return this.items.map(item => item.unwrap());
  }
}

// ---------------------------------------------------------------------------
// SCDictionary — key-value collection of SCObjects
// ---------------------------------------------------------------------------

registerClass('SCDictionary', 'SCObject');

export class SCDictionary extends SCObject {
  override readonly isa = 'SCDictionary';
  private entries: Map<string, SCObject>;

  constructor(entries?: Map<string, SCObject>) {
    super();
    this.entries = new Map(entries ?? []);
  }

  get count(): number {
    return this.entries.size;
  }

  objectForKey(key: string): SCObject | undefined {
    return this.entries.get(key);
  }

  setObject(key: string, obj: SCObject): void {
    this.entries.set(key, obj);
  }

  allKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  allValues(): SCObject[] {
    return Array.from(this.entries.values());
  }

  override description(): string {
    const keys = this.allKeys().slice(0, 5).join(', ');
    const suffix = this.allKeys().length > 5 ? '...' : '';
    return `<SCDictionary id=${this.id} keys=[${keys}${suffix}]>`;
  }

  override unwrap(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of this.entries) {
      result[key] = value.unwrap();
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Auto-wrapping: convert plain JS values to SCObjects
// ---------------------------------------------------------------------------

/** Wrap a plain value into an SCObject. Already-SCObject values pass through. */
export function wrapValue(value: unknown): SCObject | unknown {
  if (value instanceof SCObject) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value; // Primitives stay as-is
  }
  if (Array.isArray(value)) {
    const items = value.map(v => {
      const wrapped = wrapValue(v);
      return wrapped instanceof SCObject ? wrapped : new SCData({ value: wrapped });
    });
    return new SCArray(items);
  }
  if (typeof value === 'object') {
    return new SCData(value as Record<string, unknown>);
  }
  return value;
}

/** Unwrap an SCObject (or return primitives as-is) */
export function unwrapValue(value: unknown): unknown {
  if (value instanceof SCObject) return value.unwrap();
  return value;
}
