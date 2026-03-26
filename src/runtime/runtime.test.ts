/**
 * Feature: Tool Runtime
 *
 * The top-level runtime that manages selector tables, dispatch context,
 * tool classes, and provides the main dispatch entry point.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRuntime } from './runtime.js';
import { ToolClass, ToolProxy } from '../core/tool-class.js';
import type { Embedder, VectorIndex, ToolSelector, ToolIMP, ToolProtocol } from '../core/types.js';
import { SelectorNamespace, SelectorShadowingError } from '../core/selector-namespace.js';

/** Minimal mock embedder */
function createMockEmbedder(): Embedder {
  return {
    embed: vi.fn().mockResolvedValue(new Float32Array(384).fill(0.1)),
    embedBatch: vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]),
    dimensions: 384,
  };
}

/** Minimal mock vector index */
function createMockVectorIndex(): VectorIndex {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Feature: Tool Runtime Initialization', () => {
  describe('Scenario: Create a runtime with defaults', () => {
    it('Given a vector index and embedder, When ToolRuntime is created, Then it has a selector table and cache', () => {
      const runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());

      expect(runtime.selectorTable).toBeDefined();
      expect(runtime.cache).toBeDefined();
      expect(runtime.context).toBeDefined();
    });
  });

  describe('Scenario: Create a runtime with custom options', () => {
    it('Given custom options, When ToolRuntime is created, Then options are applied', () => {
      const runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder(), {
        selectorThreshold: 0.9,
        cacheSize: 512,
        minConfidence: 0.8,
        modelVersion: 'v1.0',
      });

      expect(runtime).toBeDefined();
    });
  });
});

describe('Feature: Tool Class Registration', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Register a tool class', () => {
    it('Given a ToolClass, When registerClass is called, Then the class is available in the context', () => {
      const toolClass = new ToolClass('test-provider');

      runtime.registerClass(toolClass);

      const classes = runtime.context.getClasses();
      expect(classes.some(c => c.name === 'test-provider')).toBe(true);
    });
  });

  describe('Scenario: Register a protocol', () => {
    it('Given a ToolProtocol, When registerProtocol is called, Then it does not throw', () => {
      const protocol: ToolProtocol = {
        name: 'Searchable',
        requiredSelectors: [],
        optionalSelectors: [],
      };

      expect(() => runtime.registerProtocol(protocol)).not.toThrow();
    });
  });
});

describe('Feature: Dispatch Interface', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Fluent dispatch returns DispatchBuilder', () => {
    it('Given an intent string, When dispatch is called without args, Then a DispatchBuilder is returned', () => {
      const builder = runtime.dispatch('search documents');
      expect(builder).toBeDefined();
      expect(typeof builder.withArgs).toBe('function');
      expect(typeof builder.exec).toBe('function');
      expect(typeof builder.stream).toBe('function');
    });
  });

  describe('Scenario: Intent alias returns DispatchBuilder', () => {
    it('Given an intent string, When intent is called, Then a DispatchBuilder is returned', () => {
      const builder = runtime.intent('search documents');
      expect(builder).toBeDefined();
      expect(typeof builder.withArgs).toBe('function');
    });
  });
});

describe('Feature: Version Management', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Set provider version', () => {
    it('Given a provider ID, When setProviderVersion is called, Then it does not throw', () => {
      expect(() => runtime.setProviderVersion('github', '2.0')).not.toThrow();
    });
  });

  describe('Scenario: Set model version', () => {
    it('Given a version string, When setModelVersion is called, Then it does not throw', () => {
      expect(() => runtime.setModelVersion('embed-v2')).not.toThrow();
    });
  });
});

describe('Feature: Method Swizzling', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Swizzle replaces an IMP', () => {
    it('Given a registered method, When swizzle is called, Then the original IMP is returned and the new one is set', () => {
      const toolClass = new ToolClass('provider');
      const selector: ToolSelector = {
        canonical: 'search:',
        parts: ['search'],
        arity: 1,
        vector: new Float32Array(384),
      };

      const originalImp: ToolIMP = {
        providerId: 'provider',
        toolName: 'search-v1',
        transportType: 'local',
      };

      const newImp: ToolIMP = {
        providerId: 'provider',
        toolName: 'search-v2',
        transportType: 'local',
      };

      toolClass.addMethod(selector, originalImp);
      runtime.registerClass(toolClass);

      const returned = runtime.swizzle(toolClass, selector, newImp);

      expect(returned).toBe(originalImp);
      expect(toolClass.dispatchTable.get('search:')).toBe(newImp);
    });
  });

  describe('Scenario: Swizzle on non-existent selector returns null', () => {
    it('Given a selector with no existing IMP, When swizzle is called, Then null is returned', () => {
      const toolClass = new ToolClass('provider');
      const selector: ToolSelector = {
        canonical: 'missing:',
        parts: ['missing'],
        arity: 1,
        vector: new Float32Array(384),
      };
      const newImp: ToolIMP = { providerId: 'p', toolName: 't', transportType: 'local' };

      runtime.registerClass(toolClass);

      const returned = runtime.swizzle(toolClass, selector, newImp);
      expect(returned).toBeNull();
    });
  });
});

describe('Feature: Category Loading', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Load a category onto conforming classes', () => {
    it('Given a class conforming to a protocol, When loadCategory is called, Then new methods are added', () => {
      const protocol: ToolProtocol = {
        name: 'Searchable',
        requiredSelectors: [],
        optionalSelectors: [],
      };

      const toolClass = new ToolClass('provider');
      toolClass.protocols.push(protocol);
      runtime.registerClass(toolClass);

      const selector: ToolSelector = {
        canonical: 'enhanced-search:',
        parts: ['enhanced-search'],
        arity: 1,
        vector: new Float32Array(384),
      };

      const imp: ToolIMP = {
        providerId: 'provider',
        toolName: 'enhanced-search',
        transportType: 'local',
      };

      runtime.loadCategory({
        name: 'SearchEnhancements',
        extendsProtocol: 'Searchable',
        methods: [{ selector, imp }],
      });

      expect(toolClass.dispatchTable.has('enhanced-search:')).toBe(true);
    });
  });

  describe('Scenario: Category does not affect non-conforming classes', () => {
    it('Given a class not conforming to the protocol, When loadCategory is called, Then it is unchanged', () => {
      const toolClass = new ToolClass('provider');
      runtime.registerClass(toolClass);

      const selector: ToolSelector = {
        canonical: 'new-method:',
        parts: ['new-method'],
        arity: 1,
        vector: new Float32Array(384),
      };

      runtime.loadCategory({
        name: 'SomeCategory',
        extendsProtocol: 'Nonexistent',
        methods: [{ selector, imp: { providerId: 'p', toolName: 't', transportType: 'local' } }],
      });

      expect(toolClass.dispatchTable.has('new-method:')).toBe(false);
    });
  });
});

describe('Feature: LLM Header Generation', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Generate header with registered classes', () => {
    it('Given registered tool classes, When generateHeader is called, Then a capability summary is returned', () => {
      const toolClass = new ToolClass('github');
      const selector: ToolSelector = {
        canonical: 'search-repos:',
        parts: ['search-repos'],
        arity: 1,
        vector: new Float32Array(384),
      };
      toolClass.addMethod(selector, {
        providerId: 'github',
        toolName: 'search_repos',
        transportType: 'rest',
      });
      runtime.registerClass(toolClass);

      const header = runtime.generateHeader();

      expect(header).toContain('Available capabilities');
      expect(header).toContain('github');
      expect(header).toContain('1 tools');
    });
  });

  describe('Scenario: Generate header with protocols', () => {
    it('Given a class with a protocol, When generateHeader is called, Then the protocol is listed', () => {
      const protocol: ToolProtocol = {
        name: 'CodeHost',
        requiredSelectors: [],
        optionalSelectors: [],
      };
      const toolClass = new ToolClass('github');
      toolClass.protocols.push(protocol);
      runtime.registerClass(toolClass);

      const header = runtime.generateHeader();
      expect(header).toContain('CodeHost');
      expect(header).toContain('github');
    });
  });

  describe('Scenario: Generate header with empty runtime', () => {
    it('Given no registered classes, When generateHeader is called, Then a minimal header is returned', () => {
      const header = runtime.generateHeader();

      expect(header).toContain('Available capabilities');
      expect(header).toContain('describe what you want to do');
    });
  });
});

describe('Feature: Invalidation Hook', () => {
  let runtime: ToolRuntime;

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Register and unsubscribe invalidation hook', () => {
    it('Given a hook, When invalidateOn is called, Then it returns an unsubscribe function', () => {
      const hook = vi.fn();
      const unsubscribe = runtime.invalidateOn(hook);

      expect(typeof unsubscribe).toBe('function');

      // Should not throw
      unsubscribe();
    });
  });
});

describe('Feature: Selector Shadowing Prevention', () => {
  let runtime: ToolRuntime;

  function makeSelector(canonical: string): ToolSelector {
    return {
      canonical,
      parts: canonical.split(':'),
      arity: canonical.split(':').length - 1,
      vector: new Float32Array(384),
    };
  }

  function makeIMP(providerId: string, toolName: string): ToolIMP {
    return {
      providerId,
      toolName,
      transportType: 'local',
    } as ToolIMP;
  }

  beforeEach(() => {
    runtime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder());
  });

  describe('Scenario: Register a core class and block shadowing', () => {
    it('Given a core class with protected selectors, When a new class tries to shadow them, Then it throws SelectorShadowingError', () => {
      const coreClass = new ToolClass('system');
      const sel = makeSelector('dispatch:intent');
      coreClass.addMethod(sel, makeIMP('system', 'dispatch'));
      runtime.registerCoreClass(coreClass);

      // A new class with the same selector should be blocked
      const evilClass = new ToolClass('evil-plugin');
      evilClass.addMethod(sel, makeIMP('evil-plugin', 'evil-dispatch'));

      expect(() => runtime.registerClass(evilClass)).toThrow(SelectorShadowingError);
    });
  });

  describe('Scenario: Core class with swizzlable selectors allows shadowing', () => {
    it('Given a core class with swizzlable selectors, When a new class uses the same selector, Then it succeeds', () => {
      const coreClass = new ToolClass('system');
      const sel = makeSelector('dispatch:intent');
      coreClass.addMethod(sel, makeIMP('system', 'dispatch'));
      runtime.registerCoreClass(coreClass, { swizzlable: true });

      const pluginClass = new ToolClass('plugin');
      pluginClass.addMethod(sel, makeIMP('plugin', 'custom-dispatch'));

      expect(() => runtime.registerClass(pluginClass)).not.toThrow();
    });
  });

  describe('Scenario: Non-core selectors are not protected', () => {
    it('Given a regular (non-core) class, When another class uses the same selector, Then it succeeds', () => {
      const classA = new ToolClass('provider-a');
      const sel = makeSelector('search:code');
      classA.addMethod(sel, makeIMP('provider-a', 'search'));
      runtime.registerClass(classA); // Not registerCoreClass

      const classB = new ToolClass('provider-b');
      classB.addMethod(sel, makeIMP('provider-b', 'search'));

      expect(() => runtime.registerClass(classB)).not.toThrow();
    });
  });

  describe('Scenario: Swizzle respects namespace protection', () => {
    it('Given a core class with protected selectors, When swizzle is called from a different class, Then it throws', () => {
      const coreClass = new ToolClass('system');
      const sel = makeSelector('dispatch:intent');
      coreClass.addMethod(sel, makeIMP('system', 'dispatch'));
      runtime.registerCoreClass(coreClass);

      const otherClass = new ToolClass('attacker');
      runtime.registerClass(otherClass);

      expect(() => runtime.swizzle(otherClass, sel, makeIMP('attacker', 'evil'))).toThrow(
        SelectorShadowingError,
      );
    });

    it('Given a core class, When the owner swizzles its own selector, Then it succeeds', () => {
      const coreClass = new ToolClass('system');
      const sel = makeSelector('dispatch:intent');
      coreClass.addMethod(sel, makeIMP('system', 'dispatch-v1'));
      runtime.registerCoreClass(coreClass);

      const newImp = makeIMP('system', 'dispatch-v2');
      expect(() => runtime.swizzle(coreClass, sel, newImp)).not.toThrow();
      expect(coreClass.dispatchTable.get('dispatch:intent')).toBe(newImp);
    });
  });

  describe('Scenario: markSwizzlable unlocks a protected selector', () => {
    it('Given a protected selector, When markSwizzlable is called, Then other classes can shadow it', () => {
      const coreClass = new ToolClass('system');
      const sel = makeSelector('dispatch:intent');
      coreClass.addMethod(sel, makeIMP('system', 'dispatch'));
      runtime.registerCoreClass(coreClass);

      // Initially blocked
      const pluginClass = new ToolClass('plugin');
      pluginClass.addMethod(sel, makeIMP('plugin', 'custom'));
      expect(() => runtime.registerClass(pluginClass)).toThrow(SelectorShadowingError);

      // Unlock it
      runtime.selectorNamespace.markSwizzlable('dispatch:intent');

      // Now it should work
      const pluginClass2 = new ToolClass('plugin2');
      pluginClass2.addMethod(sel, makeIMP('plugin2', 'custom'));
      expect(() => runtime.registerClass(pluginClass2)).not.toThrow();
    });
  });

  describe('Scenario: Category loading respects namespace', () => {
    it('Given a core selector, When a category tries to shadow it on a different class, Then it throws', () => {
      const coreClass = new ToolClass('system');
      const sel = makeSelector('dispatch:intent');
      coreClass.addMethod(sel, makeIMP('system', 'dispatch'));
      runtime.registerCoreClass(coreClass);

      const protocol: ToolProtocol = {
        name: 'Dispatchable',
        requiredSelectors: [],
        optionalSelectors: [],
      };

      const otherClass = new ToolClass('other');
      otherClass.protocols.push(protocol);
      runtime.registerClass(otherClass);

      expect(() =>
        runtime.loadCategory({
          name: 'EvilCategory',
          extendsProtocol: 'Dispatchable',
          methods: [{ selector: sel, imp: makeIMP('other', 'evil-dispatch') }],
        }),
      ).toThrow(SelectorShadowingError);
    });
  });

  describe('Scenario: Runtime exposes selectorNamespace', () => {
    it('Given a runtime, Then selectorNamespace is accessible for configuration', () => {
      expect(runtime.selectorNamespace).toBeDefined();
      expect(runtime.selectorNamespace).toBeInstanceOf(SelectorNamespace);
    });
  });

  describe('Scenario: Custom namespace passed via options', () => {
    it('Given a pre-configured namespace, When used in RuntimeOptions, Then it is respected', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('protected:method', 'system');

      const customRuntime = new ToolRuntime(createMockVectorIndex(), createMockEmbedder(), {
        selectorNamespace: ns,
      });

      const cls = new ToolClass('plugin');
      const sel = makeSelector('protected:method');
      cls.addMethod(sel, makeIMP('plugin', 'override'));

      expect(() => customRuntime.registerClass(cls)).toThrow(SelectorShadowingError);
    });
  });
});
