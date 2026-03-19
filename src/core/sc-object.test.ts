import { describe, it, expect } from 'vitest';
import {
  SCObject,
  SCSelector,
  SCData,
  SCToolReference,
  SCArray,
  SCDictionary,
  wrapValue,
  unwrapValue,
  isSubclass,
  getClassHierarchy,
} from './sc-object.js';
import type { ToolIMP, ToolSelector as ToolSelectorType } from './types.js';

// Helper: create a mock ToolSelector
function mockSelector(canonical: string): ToolSelectorType {
  return {
    vector: new Float32Array([1, 0, 0]),
    canonical,
    parts: canonical.split(':'),
    arity: canonical.split(':').length - 1,
  };
}

// Helper: create a mock ToolIMP
function mockIMP(name: string): ToolIMP {
  return {
    providerId: 'test',
    toolName: name,
    transportType: 'local',
    schema: null,
    schemaLoader: async () => ({ name, description: name, inputSchema: { type: 'object' }, arguments: [] }),
    execute: async (args) => ({ content: args }),
    constraints: { required: [], optional: [], validate: () => ({ valid: true, errors: [] }) },
  };
}

describe('SCObject', () => {
  it('assigns unique ids', () => {
    const a = new SCObject();
    const b = new SCObject();
    expect(a.id).not.toBe(b.id);
  });

  it('has isa = SCObject', () => {
    const obj = new SCObject();
    expect(obj.isa).toBe('SCObject');
  });

  it('isKindOfClass returns true for SCObject', () => {
    const obj = new SCObject();
    expect(obj.isKindOfClass('SCObject')).toBe(true);
  });

  it('isMemberOfClass returns true only for exact class', () => {
    const obj = new SCObject();
    expect(obj.isMemberOfClass('SCObject')).toBe(true);
    expect(obj.isMemberOfClass('SCData')).toBe(false);
  });

  it('description includes class and id', () => {
    const obj = new SCObject();
    expect(obj.description()).toContain('SCObject');
    expect(obj.description()).toContain(`id=${obj.id}`);
  });

  it('unwrap returns self by default', () => {
    const obj = new SCObject();
    expect(obj.unwrap()).toBe(obj);
  });
});

describe('SCSelector', () => {
  it('wraps a ToolSelector', () => {
    const sel = mockSelector('search:code');
    const scSel = new SCSelector(sel);
    expect(scSel.isa).toBe('SCSelector');
    expect(scSel.selector).toBe(sel);
  });

  it('isKindOfClass works for SCObject', () => {
    const scSel = new SCSelector(mockSelector('test'));
    expect(scSel.isKindOfClass('SCObject')).toBe(true);
    expect(scSel.isKindOfClass('SCSelector')).toBe(true);
  });

  it('unwrap returns the ToolSelector', () => {
    const sel = mockSelector('search:code');
    const scSel = new SCSelector(sel);
    expect(scSel.unwrap()).toBe(sel);
  });
});

describe('SCData', () => {
  it('wraps JSON data', () => {
    const data = new SCData({ name: 'test', count: 42 });
    expect(data.isa).toBe('SCData');
    expect(data.get('name')).toBe('test');
    expect(data.get('count')).toBe(42);
    expect(data.has('name')).toBe(true);
    expect(data.has('missing')).toBe(false);
    expect(data.keys()).toEqual(['name', 'count']);
  });

  it('unwrap returns the original object', () => {
    const original = { foo: 'bar' };
    const data = new SCData(original);
    expect(data.unwrap()).toBe(original);
  });

  it('isKindOfClass includes SCObject', () => {
    const data = new SCData({});
    expect(data.isKindOfClass('SCObject')).toBe(true);
    expect(data.isKindOfClass('SCData')).toBe(true);
  });
});

describe('SCToolReference', () => {
  it('wraps a ToolIMP', () => {
    const imp = mockIMP('search_code');
    const ref = new SCToolReference(imp);
    expect(ref.isa).toBe('SCToolReference');
    expect(ref.imp).toBe(imp);
    expect(ref.unwrap()).toBe(imp);
  });

  it('description includes tool info', () => {
    const ref = new SCToolReference(mockIMP('search_code'));
    expect(ref.description()).toContain('search_code');
    expect(ref.description()).toContain('test');
  });
});

describe('SCArray', () => {
  it('stores and retrieves objects', () => {
    const arr = new SCArray();
    const data = new SCData({ value: 1 });
    arr.addObject(data);
    expect(arr.count).toBe(1);
    expect(arr.objectAtIndex(0)).toBe(data);
  });

  it('unwrap recursively unwraps items', () => {
    const arr = new SCArray([
      new SCData({ a: 1 }),
      new SCData({ b: 2 }),
    ]);
    const unwrapped = arr.unwrap() as Record<string, unknown>[];
    expect(unwrapped).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('allObjects returns a copy', () => {
    const data = new SCData({ x: 1 });
    const arr = new SCArray([data]);
    const all = arr.allObjects();
    all.push(new SCData({ y: 2 }));
    expect(arr.count).toBe(1);  // Original unchanged
  });
});

describe('SCDictionary', () => {
  it('stores and retrieves by key', () => {
    const dict = new SCDictionary();
    const val = new SCData({ test: true });
    dict.setObject('key', val);
    expect(dict.count).toBe(1);
    expect(dict.objectForKey('key')).toBe(val);
    expect(dict.allKeys()).toEqual(['key']);
  });

  it('unwrap recursively unwraps values', () => {
    const dict = new SCDictionary();
    dict.setObject('a', new SCData({ x: 1 }));
    dict.setObject('b', new SCData({ y: 2 }));
    expect(dict.unwrap()).toEqual({ a: { x: 1 }, b: { y: 2 } });
  });
});

describe('wrapValue / unwrapValue', () => {
  it('passes SCObjects through', () => {
    const obj = new SCData({ test: true });
    expect(wrapValue(obj)).toBe(obj);
  });

  it('passes primitives through', () => {
    expect(wrapValue('hello')).toBe('hello');
    expect(wrapValue(42)).toBe(42);
    expect(wrapValue(true)).toBe(true);
    expect(wrapValue(null)).toBe(null);
  });

  it('wraps plain objects as SCData', () => {
    const result = wrapValue({ foo: 'bar' });
    expect(result).toBeInstanceOf(SCData);
    expect((result as SCData).get('foo')).toBe('bar');
  });

  it('wraps arrays as SCArray', () => {
    const result = wrapValue([{ a: 1 }]);
    expect(result).toBeInstanceOf(SCArray);
  });

  it('unwrapValue extracts from SCObjects', () => {
    const data = new SCData({ key: 'val' });
    expect(unwrapValue(data)).toEqual({ key: 'val' });
  });

  it('unwrapValue passes primitives through', () => {
    expect(unwrapValue('hello')).toBe('hello');
    expect(unwrapValue(42)).toBe(42);
  });
});

describe('class hierarchy', () => {
  it('isSubclass works for registered classes', () => {
    expect(isSubclass('SCData', 'SCObject')).toBe(true);
    expect(isSubclass('SCSelector', 'SCObject')).toBe(true);
    expect(isSubclass('SCObject', 'SCData')).toBe(false);
  });

  it('getClassHierarchy returns full chain', () => {
    const chain = getClassHierarchy('SCData');
    expect(chain).toEqual(['SCData', 'SCObject']);
  });
});
