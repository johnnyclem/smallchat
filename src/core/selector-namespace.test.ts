import { describe, it, expect } from 'vitest';
import { SelectorNamespace, SelectorShadowingError } from './selector-namespace.js';

describe('SelectorNamespace', () => {
  describe('core selector registration', () => {
    it('registers a selector as core and reports it', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      expect(ns.isCore('dispatch:intent')).toBe(true);
      expect(ns.size).toBe(1);
    });

    it('registers multiple core selectors at once', () => {
      const ns = new SelectorNamespace();
      ns.registerCoreSelectors('system', [
        { canonical: 'dispatch:intent' },
        { canonical: 'resolve:selector', swizzlable: true },
      ]);

      expect(ns.isCore('dispatch:intent')).toBe(true);
      expect(ns.isCore('resolve:selector')).toBe(true);
      expect(ns.isSwizzlable('dispatch:intent')).toBe(false);
      expect(ns.isSwizzlable('resolve:selector')).toBe(true);
      expect(ns.size).toBe(2);
    });

    it('defaults swizzlable to false', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      expect(ns.isSwizzlable('dispatch:intent')).toBe(false);
    });
  });

  describe('shadowing checks', () => {
    it('returns null for non-core selectors', () => {
      const ns = new SelectorNamespace();
      expect(ns.checkShadowing('user:method')).toBeNull();
    });

    it('returns null for swizzlable core selectors', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system', true);

      expect(ns.checkShadowing('dispatch:intent')).toBeNull();
    });

    it('returns the blocking entry for protected core selectors', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system', false);

      const blocking = ns.checkShadowing('dispatch:intent');
      expect(blocking).not.toBeNull();
      expect(blocking!.canonical).toBe('dispatch:intent');
      expect(blocking!.ownerClass).toBe('system');
    });
  });

  describe('assertNoShadowing', () => {
    it('does not throw for non-core selectors', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      expect(() => ns.assertNoShadowing('plugin', ['search:code'])).not.toThrow();
    });

    it('does not throw when the owning class registers its own selectors', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      // The owning class ("system") can always re-register its own selectors
      expect(() => ns.assertNoShadowing('system', ['dispatch:intent'])).not.toThrow();
    });

    it('throws SelectorShadowingError when a different class shadows a protected selector', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      expect(() => ns.assertNoShadowing('evil-plugin', ['dispatch:intent'])).toThrow(
        SelectorShadowingError,
      );
    });

    it('includes useful context in the error', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      try {
        ns.assertNoShadowing('evil-plugin', ['dispatch:intent']);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SelectorShadowingError);
        const e = err as SelectorShadowingError;
        expect(e.selector).toBe('dispatch:intent');
        expect(e.existingOwner).toBe('system');
        expect(e.offendingClass).toBe('evil-plugin');
        expect(e.message).toContain('swizzlable');
      }
    });

    it('does not throw when the selector is swizzlable', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system', true);

      expect(() => ns.assertNoShadowing('plugin', ['dispatch:intent'])).not.toThrow();
    });

    it('throws on first violation in a list', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('core:a', 'system');
      ns.registerCore('core:b', 'system');

      expect(() =>
        ns.assertNoShadowing('plugin', ['safe:method', 'core:a', 'core:b']),
      ).toThrow(SelectorShadowingError);
    });
  });

  describe('markSwizzlable / markProtected', () => {
    it('marks a protected selector as swizzlable', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system', false);

      expect(ns.isSwizzlable('dispatch:intent')).toBe(false);

      const result = ns.markSwizzlable('dispatch:intent');
      expect(result).toBe(true);
      expect(ns.isSwizzlable('dispatch:intent')).toBe(true);
      expect(ns.checkShadowing('dispatch:intent')).toBeNull();
    });

    it('marks a swizzlable selector back to protected', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system', true);

      ns.markProtected('dispatch:intent');
      expect(ns.isSwizzlable('dispatch:intent')).toBe(false);
    });

    it('returns false for non-core selectors', () => {
      const ns = new SelectorNamespace();
      expect(ns.markSwizzlable('nonexistent')).toBe(false);
      expect(ns.markProtected('nonexistent')).toBe(false);
    });
  });

  describe('unregisterCore', () => {
    it('removes a selector from core protection', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('dispatch:intent', 'system');

      expect(ns.unregisterCore('dispatch:intent')).toBe(true);
      expect(ns.isCore('dispatch:intent')).toBe(false);
      expect(ns.size).toBe(0);
    });

    it('returns false for non-core selectors', () => {
      const ns = new SelectorNamespace();
      expect(ns.unregisterCore('nonexistent')).toBe(false);
    });
  });

  describe('allCore', () => {
    it('returns all registered core entries', () => {
      const ns = new SelectorNamespace();
      ns.registerCore('a', 'system');
      ns.registerCore('b', 'system', true);

      const all = ns.allCore();
      expect(all).toHaveLength(2);
      expect(all.map(e => e.canonical).sort()).toEqual(['a', 'b']);
    });
  });
});
