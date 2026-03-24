import { describe, it, expect } from 'vitest';
import { IntentPinRegistry } from './intent-pin.js';
import type { IntentPin } from './intent-pin.js';

describe('IntentPinRegistry', () => {
  it('pins and unpins selectors', () => {
    const registry = new IntentPinRegistry();
    registry.pin({ canonical: 'db.delete_record', policy: 'exact' });
    expect(registry.isPinned('db.delete_record')).toBe(true);
    expect(registry.size).toBe(1);

    registry.unpin('db.delete_record');
    expect(registry.isPinned('db.delete_record')).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('returns pinned canonicals', () => {
    const registry = new IntentPinRegistry();
    registry.pin({ canonical: 'db.delete_record', policy: 'exact' });
    registry.pin({ canonical: 'bank.transfer_funds', policy: 'elevated' });
    expect(registry.pinnedCanonicals()).toEqual(
      expect.arrayContaining(['db.delete_record', 'bank.transfer_funds']),
    );
  });

  describe('checkExact', () => {
    it('accepts when intent canonical matches pinned canonical', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'db.delete_record', policy: 'exact' });

      const match = registry.checkExact('db.delete_record');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('accept');
      expect(match!.policy).toBe('exact');
    });

    it('returns null when intent does not match any pin', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'db.delete_record', policy: 'exact' });

      const match = registry.checkExact('db.archive_record');
      expect(match).toBeNull();
    });

    it('accepts via alias', () => {
      const registry = new IntentPinRegistry();
      registry.pin({
        canonical: 'db.delete_record',
        policy: 'exact',
        aliases: ['remove record permanently'],
      });

      // canonicalize("remove record permanently") => "remove:record:permanently"
      const match = registry.checkExact('remove:record:permanently');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('accept');
      expect(match!.canonical).toBe('db.delete_record');
    });

    it('cleans up aliases on unpin', () => {
      const registry = new IntentPinRegistry();
      registry.pin({
        canonical: 'db.delete_record',
        policy: 'exact',
        aliases: ['remove record permanently'],
      });
      registry.unpin('db.delete_record');

      const match = registry.checkExact('remove:record:permanently');
      expect(match).toBeNull();
    });
  });

  describe('checkSimilarity', () => {
    it('returns null for non-pinned candidates', () => {
      const registry = new IntentPinRegistry();
      const match = registry.checkSimilarity('db.archive_record', 0.85, 'archive:record');
      expect(match).toBeNull();
    });

    it('rejects exact-pinned candidate when canonicals differ', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'db.delete_record', policy: 'exact' });

      const match = registry.checkSimilarity('db.delete_record', 0.90, 'archive:record');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('reject');
      expect(match!.policy).toBe('exact');
    });

    it('accepts exact-pinned candidate when canonicals match', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'db.delete_record', policy: 'exact' });

      const match = registry.checkSimilarity('db.delete_record', 0.90, 'db.delete_record');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('accept');
    });

    it('accepts exact-pinned candidate via alias', () => {
      const registry = new IntentPinRegistry();
      registry.pin({
        canonical: 'db.delete_record',
        policy: 'exact',
        aliases: ['remove record permanently'],
      });

      const match = registry.checkSimilarity('db.delete_record', 0.90, 'remove:record:permanently');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('accept');
    });

    it('rejects elevated-pinned candidate below threshold', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'bank.transfer_funds', policy: 'elevated' });

      const match = registry.checkSimilarity('bank.transfer_funds', 0.90, 'move:money');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('reject');
      expect(match!.similarity).toBe(0.90);
      expect(match!.requiredThreshold).toBe(0.98);
    });

    it('accepts elevated-pinned candidate above threshold', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'bank.transfer_funds', policy: 'elevated' });

      const match = registry.checkSimilarity('bank.transfer_funds', 0.99, 'transfer:funds');
      expect(match).not.toBeNull();
      expect(match!.verdict).toBe('accept');
      expect(match!.similarity).toBe(0.99);
    });

    it('uses custom threshold for elevated policy', () => {
      const registry = new IntentPinRegistry();
      registry.pin({ canonical: 'admin.reset_password', policy: 'elevated', threshold: 0.95 });

      // Below custom threshold
      const reject = registry.checkSimilarity('admin.reset_password', 0.94, 'reset:password');
      expect(reject!.verdict).toBe('reject');
      expect(reject!.requiredThreshold).toBe(0.95);

      // Above custom threshold
      const accept = registry.checkSimilarity('admin.reset_password', 0.96, 'reset:password');
      expect(accept!.verdict).toBe('accept');
    });
  });

  describe('getPin', () => {
    it('returns the pin entry', () => {
      const registry = new IntentPinRegistry();
      const pin: IntentPin = { canonical: 'db.delete_record', policy: 'exact', aliases: ['remove'] };
      registry.pin(pin);

      const retrieved = registry.getPin('db.delete_record');
      expect(retrieved).toEqual(pin);
    });

    it('returns undefined for non-pinned selectors', () => {
      const registry = new IntentPinRegistry();
      expect(registry.getPin('db.delete_record')).toBeUndefined();
    });
  });
});
