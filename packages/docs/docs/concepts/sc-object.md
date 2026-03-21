---
title: SCObject System
sidebar_label: SCObject System
---

# SCObject System

The `SCObject` hierarchy is an NSObject-inspired base class for typed parameter passing. It enables runtime type checking, auto-wrapping of plain JavaScript values, and a consistent object model across dispatch boundaries.

## Type hierarchy

```
SCObject
├── SCSelector    — intent fingerprints (canonical selectors)
├── SCData        — raw binary / string / buffer data
├── SCToolReference — reference to another tool (for chaining)
├── SCArray       — ordered collection (wraps Array)
└── SCDictionary  — key-value collection (wraps object / Map)
```

All types inherit from `SCObject`, which provides:

- `className` — string class identifier
- `isKindOfClass(cls)` — true if this instance is `cls` or a subclass
- `isMemberOfClass(cls)` — true if this instance is exactly `cls`
- `description()` — human-readable string representation

## `wrapValue` / `unwrapValue`

Plain JavaScript values are automatically wrapped into SCObject instances before dispatch and unwrapped after:

```typescript
import { wrapValue, unwrapValue, SCArray, SCDictionary, SCData } from '@smallchat/core';

// Wrapping
wrapValue('hello')               // → SCData { value: 'hello' }
wrapValue(42)                    // → SCData { value: 42 }
wrapValue([1, 2, 3])             // → SCArray { items: [SCData(1), SCData(2), SCData(3)] }
wrapValue({ a: 1 })              // → SCDictionary { entries: { a: SCData(1) } }

// Unwrapping
unwrapValue(new SCData('hello')) // → 'hello'
unwrapValue(new SCArray([...]))  // → [...]
```

You can bypass auto-wrapping by constructing SCObject instances directly and passing them as arguments:

```typescript
const args = new SCDictionary({
  query: new SCData('typescript generics'),
  language: new SCData('typescript'),
  limit: new SCData(10),
});

await runtime.dispatch('search for code', args);
```

## Runtime type checking

```typescript
import { SCObject, SCArray, SCData, isSubclass } from '@smallchat/core';

const val = wrapValue([1, 2, 3]);

console.log(val.isKindOfClass('SCArray'));    // true
console.log(val.isKindOfClass('SCObject'));   // true (superclass)
console.log(val.isMemberOfClass('SCArray'));  // true
console.log(val.isMemberOfClass('SCObject')); // false (not exact)

// isSubclass helper
console.log(isSubclass('SCArray', 'SCObject'));  // true
console.log(isSubclass('SCData', 'SCArray'));    // false
```

## `SCSelector`

`SCSelector` wraps a canonical selector string. Dispatch returns `SCSelector` instances when resolving intents, and you can pass them directly to avoid re-resolution:

```typescript
import { SCSelector } from '@smallchat/core';

const sel = runtime.intern('search for code');
// sel is a ToolSelector (string identifier)

const scSel = new SCSelector(sel);
// Can be passed as an argument to tools that accept selectors
```

## `SCToolReference`

`SCToolReference` holds a reference to another tool by class and selector. Useful for tool chaining — passing the output of one tool as the input specification for another:

```typescript
import { SCToolReference } from '@smallchat/core';

const ref = new SCToolReference('github', 'search_code');

// A hypothetical "compose" tool that chains two tools
await runtime.dispatch('compose tools', {
  first: ref,
  then: new SCToolReference('slack', 'send_message'),
});
```

## `registerClass` and `getClassHierarchy`

Register custom SCObject subclasses for domain-specific typed parameters:

```typescript
import { registerClass, getClassHierarchy } from '@smallchat/core';

class SCFileReference extends SCData {
  className = 'SCFileReference';
  constructor(public path: string) {
    super(path);
  }
}

registerClass('SCFileReference', 'SCData');

// Inspect hierarchy
console.log(getClassHierarchy('SCFileReference'));
// ['SCFileReference', 'SCData', 'SCObject']
```

Custom classes participate in `isKindOfClass` and the OverloadTable's type matching.
