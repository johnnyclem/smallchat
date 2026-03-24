/**
 * Feature: Local Function Transport
 *
 * Executes JavaScript/TypeScript functions in-process with optional
 * sandboxing, timeouts, and handler registration.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LocalTransport } from './local-transport.js';

describe('Feature: Local Function Transport', () => {
  let transport: LocalTransport;

  beforeEach(() => {
    transport = new LocalTransport();
  });

  describe('Scenario: Register and execute a handler', () => {
    it('Given a registered handler, When execute is called with the tool name, Then the handler runs and returns the result', async () => {
      transport.registerHandler('greet', async (args) => ({
        content: `Hello, ${args.name}!`,
      }));

      const output = await transport.execute({
        toolName: 'greet',
        args: { name: 'Alice' },
      });

      expect(output.content).toBe('Hello, Alice!');
      expect(output.isError).toBe(false);
      expect(output.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scenario: Execute with unregistered handler', () => {
    it('Given no handler for a tool, When execute is called, Then an error output is returned', async () => {
      const output = await transport.execute({
        toolName: 'unknown-tool',
        args: {},
      });

      expect(output.isError).toBe(true);
      expect(output.metadata?.code).toBe('HANDLER_NOT_FOUND');
      expect(output.metadata?.error).toContain('unknown-tool');
    });
  });

  describe('Scenario: Handler throws an error', () => {
    it('Given a handler that throws, When execute is called, Then the error is caught and returned as output', async () => {
      transport.registerHandler('fail', async () => {
        throw new Error('handler exploded');
      });

      const output = await transport.execute({
        toolName: 'fail',
        args: {},
      });

      expect(output.isError).toBe(true);
      expect(output.metadata?.error).toContain('handler exploded');
      expect(output.metadata?.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scenario: Unregister a handler', () => {
    it('Given a registered handler, When unregisterHandler is called, Then hasHandler returns false', () => {
      transport.registerHandler('tool', async () => ({ content: 'x' }));
      expect(transport.hasHandler('tool')).toBe(true);

      const removed = transport.unregisterHandler('tool');
      expect(removed).toBe(true);
      expect(transport.hasHandler('tool')).toBe(false);
    });

    it('Given an unregistered tool name, When unregisterHandler is called, Then it returns false', () => {
      expect(transport.unregisterHandler('nonexistent')).toBe(false);
    });
  });

  describe('Scenario: Check handler registration', () => {
    it('Given a registered handler, When hasHandler is called, Then it returns true', () => {
      transport.registerHandler('exists', async () => ({ content: null }));
      expect(transport.hasHandler('exists')).toBe(true);
    });

    it('Given no handler, When hasHandler is called, Then it returns false', () => {
      expect(transport.hasHandler('missing')).toBe(false);
    });
  });

  describe('Scenario: Transport type and ID', () => {
    it('Given a LocalTransport, When checking type and id, Then type is local and id is auto-generated', () => {
      expect(transport.type).toBe('local');
      expect(transport.id).toMatch(/^local-\d+$/);
    });
  });

  describe('Scenario: Dispose clears all handlers', () => {
    it('Given registered handlers, When dispose is called, Then all handlers are removed', async () => {
      transport.registerHandler('tool1', async () => ({ content: 'a' }));
      transport.registerHandler('tool2', async () => ({ content: 'b' }));

      await transport.dispose();

      expect(transport.hasHandler('tool1')).toBe(false);
      expect(transport.hasHandler('tool2')).toBe(false);
    });
  });

  describe('Scenario: Handler with isError flag', () => {
    it('Given a handler that returns isError true, When execute is called, Then the output reflects isError', async () => {
      transport.registerHandler('soft-error', async () => ({
        content: 'partial failure',
        isError: true,
      }));

      const output = await transport.execute({
        toolName: 'soft-error',
        args: {},
      });

      expect(output.content).toBe('partial failure');
      expect(output.isError).toBe(true);
    });
  });

  describe('Scenario: Initialize with pre-configured handlers', () => {
    it('Given handlers in constructor config, When the transport is created, Then handlers are available', async () => {
      const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: unknown }>>([
        ['add', async (args) => ({ content: (args.a as number) + (args.b as number) })],
      ]);

      const t = new LocalTransport({ handlers });

      const output = await t.execute({
        toolName: 'add',
        args: { a: 2, b: 3 },
      });

      expect(output.content).toBe(5);
    });
  });

  describe('Scenario: Duration tracking', () => {
    it('Given a slow handler, When execute is called, Then durationMs reflects actual execution time', async () => {
      transport.registerHandler('slow', async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: 'done' };
      });

      const output = await transport.execute({
        toolName: 'slow',
        args: {},
      });

      expect(output.metadata?.durationMs).toBeGreaterThanOrEqual(40);
    });
  });
});
