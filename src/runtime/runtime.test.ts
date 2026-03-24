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
