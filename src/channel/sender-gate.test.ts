/**
 * Feature: Sender Gate
 *
 * Allowlist-based sender identity gating for channel events.
 * Ensures only authorized senders can inject messages into the channel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SenderGate } from './sender-gate.js';

describe('Feature: Sender Allowlist Gating', () => {
  describe('Scenario: Open mode when no allowlist is configured', () => {
    it('Given no allowlist, When check is called, Then all senders are allowed', () => {
      const gate = new SenderGate();

      expect(gate.check('anyone')).toBe(true);
      expect(gate.check('stranger')).toBe(true);
    });

    it('Given no allowlist, When enabled is checked, Then it returns false', () => {
      const gate = new SenderGate();
      expect(gate.enabled).toBe(false);
    });
  });

  describe('Scenario: Allowlist restricts senders', () => {
    it('Given an allowlist of approved senders, When an unapproved sender checks, Then it is rejected', () => {
      const gate = new SenderGate({ allowlist: ['alice', 'bob'] });

      expect(gate.check('alice')).toBe(true);
      expect(gate.check('bob')).toBe(true);
      expect(gate.check('eve')).toBe(false);
    });

    it('Given an allowlist, When enabled is checked, Then it returns true', () => {
      const gate = new SenderGate({ allowlist: ['alice'] });
      expect(gate.enabled).toBe(true);
    });
  });

  describe('Scenario: Case-insensitive matching', () => {
    it('Given a lowercase allowlist entry, When checking with uppercase, Then it matches', () => {
      const gate = new SenderGate({ allowlist: ['alice'] });

      expect(gate.check('ALICE')).toBe(true);
      expect(gate.check('Alice')).toBe(true);
      expect(gate.check('alice')).toBe(true);
    });
  });

  describe('Scenario: Whitespace trimming', () => {
    it('Given an allowlist with spaces, When checking with trimmed values, Then it matches', () => {
      const gate = new SenderGate({ allowlist: ['  alice  '] });

      expect(gate.check('alice')).toBe(true);
      expect(gate.check('  alice  ')).toBe(true);
    });
  });

  describe('Scenario: Undefined sender is rejected', () => {
    it('Given an active allowlist, When check is called with undefined, Then it returns false', () => {
      const gate = new SenderGate({ allowlist: ['alice'] });
      expect(gate.check(undefined)).toBe(false);
    });
  });
});

describe('Feature: Dynamic Allowlist Management', () => {
  let gate: SenderGate;

  beforeEach(() => {
    gate = new SenderGate({ allowlist: ['alice'] });
  });

  describe('Scenario: Add a sender dynamically', () => {
    it('Given a gate, When allow is called with a new sender, Then the sender is allowed', () => {
      expect(gate.check('bob')).toBe(false);

      gate.allow('bob');

      expect(gate.check('bob')).toBe(true);
    });
  });

  describe('Scenario: Revoke a sender dynamically', () => {
    it('Given a gate with multiple senders, When revoke is called on one, Then that sender is rejected', () => {
      gate.allow('bob');
      expect(gate.check('alice')).toBe(true);

      gate.revoke('alice');

      // Allowlist still has 'bob', so gating is active and alice is rejected
      expect(gate.check('alice')).toBe(false);
      expect(gate.check('bob')).toBe(true);
    });
  });

  describe('Scenario: Get all allowed senders', () => {
    it('Given multiple allowed senders, When getAllowed is called, Then all are returned', () => {
      gate.allow('bob');
      gate.allow('charlie');

      const allowed = gate.getAllowed();
      expect(allowed).toContain('alice');
      expect(allowed).toContain('bob');
      expect(allowed).toContain('charlie');
    });
  });
});

describe('Feature: Pairing Code Flow', () => {
  let gate: SenderGate;

  beforeEach(() => {
    gate = new SenderGate({ allowlist: ['admin'] });
  });

  describe('Scenario: Generate a pairing code', () => {
    it('Given a sender ID, When generatePairingCode is called, Then a 6-character hex code is returned', () => {
      const code = gate.generatePairingCode('new-user');

      expect(code).toMatch(/^[0-9a-f]{6}$/);
    });
  });

  describe('Scenario: Complete pairing with correct code', () => {
    it('Given a valid pairing code, When completePairing is called, Then the sender is added to the allowlist', () => {
      const code = gate.generatePairingCode('new-user');

      const result = gate.completePairing('new-user', code);

      expect(result).toBe(true);
      expect(gate.check('new-user')).toBe(true);
    });
  });

  describe('Scenario: Reject pairing with wrong code', () => {
    it('Given an incorrect code, When completePairing is called, Then it returns false', () => {
      gate.generatePairingCode('new-user');

      const result = gate.completePairing('new-user', 'wrong!');

      expect(result).toBe(false);
      expect(gate.check('new-user')).toBe(false);
    });
  });

  describe('Scenario: Reject pairing for unknown sender', () => {
    it('Given no pending pairing, When completePairing is called, Then it returns false', () => {
      expect(gate.completePairing('unknown', 'abc123')).toBe(false);
    });
  });

  describe('Scenario: Expired pairing code is rejected', () => {
    it('Given a pairing code that has expired, When completePairing is called, Then it returns false', () => {
      const code = gate.generatePairingCode('new-user');

      // Manually expire the pairing
      const pendingPairings = (gate as unknown as { pendingPairings: Map<string, { code: string; expiresAt: number }> }).pendingPairings;
      const pending = pendingPairings.get('new-user');
      if (pending) {
        pending.expiresAt = Date.now() - 1000;
      }

      const result = gate.completePairing('new-user', code);
      expect(result).toBe(false);
    });
  });

  describe('Scenario: Pairing is case-insensitive on sender ID', () => {
    it('Given a pairing for lowercase sender, When completing with uppercase, Then it matches', () => {
      const code = gate.generatePairingCode('NewUser');

      const result = gate.completePairing('NEWUSER', code);

      expect(result).toBe(true);
      expect(gate.check('newuser')).toBe(true);
    });
  });
});

describe('Feature: Gate Cleanup', () => {
  describe('Scenario: Destroy cleans up resources', () => {
    it('Given a gate without file watchers, When destroy is called, Then it does not throw', () => {
      const gate = new SenderGate({ allowlist: ['alice'] });
      expect(() => gate.destroy()).not.toThrow();
    });
  });
});
