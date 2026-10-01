---
title: SCObject System
sidebar_label: SCObject System
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

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

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { wrapValue, unwrapValue, SCData } from '@smallchat/core';

// Wrapping: primitives stay as they are; objects and arrays are wrapped
wrapValue('hello')                 // → 'hello'
wrapValue(42)                      // → 42
wrapValue({ a: 1 })                // → SCData { value: { a: 1 } }
wrapValue([1, 2])                  // → SCArray [SCData { value: { value: 1 } }, SCData { value: { value: 2 } }]

// Unwrapping
unwrapValue(new SCData({ a: 1 }))  // → { a: 1 }
unwrapValue(wrapValue([1, 2]))     // → [{ value: 1 }, { value: 2 }]
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

// Wrapping
SCValue.wrap("hello")            // → SCData { value: "hello" }
SCValue.wrap(42)                 // → SCData { value: 42 }
SCValue.wrap([1, 2, 3])          // → SCArray { items: [SCData(1), SCData(2), SCData(3)] }
SCValue.wrap(["a": 1])           // → SCDictionary { entries: ["a": SCData(1)] }

// Unwrapping
SCValue.unwrap(SCData("hello"))  // → "hello"
SCValue.unwrap(SCArray([...]))   // → [...]
```

</TabItem>
</Tabs>

You can bypass auto-wrapping by constructing SCObject instances directly and passing them as arguments:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
const args = new SCDictionary({
  query: new SCData('typescript generics'),
  language: new SCData('typescript'),
  limit: new SCData(10),
});

await runtime.dispatch('search for code', args);
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
let args = SCDictionary([
    "query": SCData("typescript generics"),
    "language": SCData("typescript"),
    "limit": SCData(10),
])

try await runtime.dispatch("search for code", args)
```

</TabItem>
</Tabs>

## Runtime type checking

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { SCArray, SCData, isSubclass } from '@smallchat/core';

const val = new SCArray([new SCData({ n: 1 })]);

console.log(val.isKindOfClass('SCArray'));    // true
console.log(val.isKindOfClass('SCObject'));   // true (superclass)
console.log(val.isMemberOfClass('SCArray'));  // true
console.log(val.isMemberOfClass('SCObject')); // false (not exact)

// isSubclass helper
console.log(isSubclass('SCArray', 'SCObject'));  // true
console.log(isSubclass('SCData', 'SCArray'));    // false
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let val = SCValue.wrap([1, 2, 3])

print(val.isKind(of: "SCArray"))     // true
print(val.isKind(of: "SCObject"))    // true (superclass)
print(val.isMember(of: "SCArray"))   // true
print(val.isMember(of: "SCObject"))  // false (not exact)

// isSubclass helper
print(isSubclass("SCArray", of: "SCObject"))  // true
print(isSubclass("SCData", of: "SCArray"))    // false
```

</TabItem>
</Tabs>

## `SCSelector`

`SCSelector` wraps a compiled `ToolSelector` so it can travel as a typed value, for example as an argument an overload declares as `SCType.object('SCSelector')`. Resolution does not return selectors (it returns tool ids); a tool receives the unwrapped `ToolSelector`:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { SCSelector } from '@smallchat/core';

const sel = runtime.selectorTable.get('github.search_code')!;
// sel is a compiled ToolSelector (intents are never interned)

const scSel = new SCSelector(sel);
// Can be passed as an argument to tools that accept selectors
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let sel = runtime.intern("search for code")
// sel is a ToolSelector (string identifier)

let scSel = SCSelector(sel)
// Can be passed as an argument to tools that accept selectors
```

</TabItem>
</Tabs>

## `SCToolReference`

`SCToolReference` holds a reference to another tool's implementation (its `ToolIMP`). Useful for tool chaining — passing one tool as part of the input specification for another:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { SCToolReference } from '@smallchat/core';

// A reference wraps a registered tool's implementation (its ToolIMP)
const search = runtime.getTool('github/search_code');
const send = runtime.getTool('slack/send_message');
if (search && send) {
  const ref = new SCToolReference(search.imp);
  console.log(ref.description()); // <SCToolReference id=… tool="search_code" provider="github">
  // e.g. as a typed parameter of a "compose" tool's overload: SCType.object('SCToolReference')
  const chain = [ref, new SCToolReference(send.imp)];
  void chain;
}
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

let ref = SCToolReference(provider: "github", tool: "search_code")

// A hypothetical "compose" tool that chains two tools
try await runtime.dispatch("compose tools", [
    "first": ref,
    "then": SCToolReference(provider: "slack", tool: "send_message"),
])
```

</TabItem>
</Tabs>

## `registerClass` and `getClassHierarchy`

Register custom SCObject subclasses for domain-specific typed parameters:

<Tabs groupId="language">
<TabItem value="typescript" label="TypeScript">

```typescript
import { SCObject, registerClass, getClassHierarchy } from '@smallchat/core';

registerClass('SCFileReference', 'SCObject');

class SCFileReference extends SCObject {
  override readonly isa = 'SCFileReference';
  constructor(readonly path: string) {
    super();
  }
  override unwrap(): string {
    return this.path; // what a tool receives
  }
}

new SCFileReference('/tmp/report.csv').isKindOfClass('SCObject'); // true

// Inspect hierarchy
console.log(getClassHierarchy('SCFileReference'));
// ['SCFileReference', 'SCObject']
```

</TabItem>
<TabItem value="swift" label="Swift">

```swift
import SmallChat

class SCFileReference: SCData {
    override var className: String { "SCFileReference" }
    let path: String
    init(path: String) {
        self.path = path
        super.init(path)
    }
}

registerClass("SCFileReference", superclass: "SCData")

// Inspect hierarchy
print(getClassHierarchy("SCFileReference"))
// ["SCFileReference", "SCData", "SCObject"]
```

</TabItem>
</Tabs>

Custom classes participate in `isKindOfClass` and the OverloadTable's type matching.
