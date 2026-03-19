# Parameter Passing & Overloads — Implementation Plan

## Overview

Introduce an NSObject-inspired object system (`SCObject`) that enables typed, position-based parameter passing into smallchat functions, along with function overloading that supports both developer-designed multi-signature interfaces and compiler-generated semantic overloads for similar tools.

## Architecture

### 1. SCObject — The Root Object (`src/core/sc-object.ts`)

The base class for all non-primitive values in smallchat. Every non-primitive passed to a function is-a SCObject.

```
SCObject (id pointer, isa class reference, retain/release stubs)
├── SCSelector       — wraps a ToolSelector so it can be passed as an argument
├── SCData           — wraps arbitrary JSON / structured data
├── SCToolReference  — wraps a ToolIMP so tools can be passed to other tools
├── SCArray          — ordered collection of SCObjects
└── SCDictionary     — key-value collection of SCObjects
```

**Key design decisions:**
- Every SCObject has a unique `id` (opaque pointer equivalent) and an `isa` string (class name)
- `isKindOfClass(className)` and `isMemberOfClass(className)` for type checking at dispatch time
- `description()` for LLM-readable string representation
- Subclasses are registered in a class registry for runtime introspection

### 2. SCType System (`src/core/sc-types.ts`)

A type descriptor system that bridges JSON Schema types with SCObject classes:

```typescript
type SCTypeDescriptor =
  | { kind: 'primitive'; type: 'string' | 'number' | 'boolean' | 'null' }
  | { kind: 'object'; className: string }  // References an SCObject subclass
  | { kind: 'union'; types: SCTypeDescriptor[] }  // For overload matching
  | { kind: 'any' }  // id — accepts any SCObject
```

**`SCParameterSlot`** — defines a single positional parameter:
- `name: string` — parameter name
- `position: number` — positional index (0-based)
- `type: SCTypeDescriptor` — what types are accepted
- `required: boolean`
- `defaultValue?: unknown`

### 3. Overload System (`src/core/overload-table.ts`)

**`SCMethodSignature`** — a specific function signature (parameter list + types):
- `parameters: SCParameterSlot[]` — ordered parameter slots
- `arity: number` — number of parameters
- `signatureKey: string` — e.g. `"string:SCData:number"` for fast lookup

**`OverloadTable`** — maps a selector to multiple signatures:
- `register(selector, signature, imp)` — add an overload
- `resolve(selector, args)` — find the best-matching overload for given arguments
- Resolution priority: exact type match > SCObject superclass match > union type match > any (id)

**`OverloadResolutionResult`** — returned from resolve:
- `imp: ToolIMP` — the matched implementation
- `signature: SCMethodSignature` — the matched signature
- `matchQuality: 'exact' | 'superclass' | 'union' | 'any'`

### 4. Compiler Integration (`src/compiler/compiler.ts` modifications)

**Phase 2.5: OVERLOAD GENERATION** (new phase between EMBED and LINK):

When the compiler option `generateSemanticOverloads` is enabled:
1. After embedding, group tools by semantic similarity (threshold configurable, default 0.82)
2. For each group of semantically similar tools, generate overloaded signatures under a single canonical selector
3. Each original tool becomes one overload, distinguished by its parameter types and arity
4. Emit compiler diagnostics about which tools were grouped

**New compiler option:**
```typescript
interface CompilerOptions {
  // ... existing
  generateSemanticOverloads?: boolean;
  semanticOverloadThreshold?: number; // default 0.82
}
```

**New compilation result fields:**
```typescript
interface CompilationResult {
  // ... existing
  overloadTables: Map<string, OverloadTable>;
  semanticOverloads: SemanticOverloadGroup[]; // diagnostic info
}
```

### 5. Runtime Integration

**`toolkit_dispatch` modifications (`src/runtime/dispatch.ts`):**
- After finding the selector match, check if an overload table exists for it
- If yes, use the overload table to resolve the specific IMP based on argument types
- SCObject arguments have their `isa` checked for type matching
- Primitive arguments matched against primitive type descriptors

**`ToolClass` modifications (`src/core/tool-class.ts`):**
- `addOverload(selector, signature, imp)` — register an overloaded method
- `resolveSelector` updated to check overload tables when args are provided

**`DispatchContext` modifications:**
- Carries overload tables from compilation
- New method: `resolveWithArgs(selector, args)` that factors in overload resolution

### 6. Argument Wrapping & Unwrapping

When `toolkit_dispatch` receives arguments:
1. Primitive values (`string`, `number`, `boolean`, `null`) stay as-is
2. Objects that are already SCObject instances pass through directly
3. Plain objects get auto-wrapped as `SCData` (JSON data)
4. Arrays get auto-wrapped as `SCArray`

Before calling `IMP.execute()`, SCObject arguments are unwrapped back to their underlying values unless the IMP's signature explicitly accepts SCObject types.

## Files to Create

| File | Purpose |
|---|---|
| `src/core/sc-object.ts` | SCObject base class + subclasses (SCSelector, SCData, SCToolReference, SCArray, SCDictionary) |
| `src/core/sc-types.ts` | SCTypeDescriptor, SCParameterSlot, SCMethodSignature |
| `src/core/overload-table.ts` | OverloadTable — multi-signature dispatch resolution |
| `src/core/sc-object.test.ts` | Tests for SCObject hierarchy |
| `src/core/overload-table.test.ts` | Tests for overload resolution |
| `src/compiler/compiler.test.ts` | Extended tests for semantic overload generation |
| `src/runtime/dispatch.test.ts` | Extended tests for overloaded dispatch |

## Files to Modify

| File | Changes |
|---|---|
| `src/core/types.ts` | Add SCTypeDescriptor, SCParameterSlot, SCMethodSignature, SemanticOverloadGroup, extend CompilationResult |
| `src/core/tool-class.ts` | Add overload support to ToolClass |
| `src/runtime/dispatch.ts` | Integrate overload resolution into toolkit_dispatch |
| `src/compiler/compiler.ts` | Add Phase 2.5 semantic overload generation, new compiler options |
| `src/runtime/runtime.ts` | Wire overload tables through, extend generateHeader |
| `src/index.ts` | Export new modules |

## Implementation Order

1. **SCObject + subclasses** — foundation, no dependencies on existing code
2. **SCTypes + SCMethodSignature** — type system, depends on SCObject
3. **OverloadTable** — overload resolution, depends on types
4. **Modify types.ts** — extend core types
5. **Modify ToolClass** — add overload-aware resolution
6. **Modify dispatch.ts** — integrate overloads into hot path
7. **Modify compiler.ts** — semantic overload generation phase
8. **Modify runtime.ts** — wire everything together
9. **Update index.ts** — exports
10. **Tests** — comprehensive tests for all new functionality
