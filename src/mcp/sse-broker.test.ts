/**
 * Feature: SSE Broker
 *
 * Per-session SSE connection registry with fan-out notifications.
 * Manages connecting, emitting events, and disconnecting SSE streams.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SseBroker } from './sse-broker.js';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

/** Create a mock ServerResponse for testing */
function mockResponse(): ServerResponse {
  const emitter = new EventEmitter();
  const res = emitter as unknown as ServerResponse;
  (res as unknown as Record<string, unknown>).write = vi.fn().mockReturnValue(true);
  (res as unknown as Record<string, unknown>).end = vi.fn();
  return res;
}

describe('Feature: SSE Broker Connection Management', () => {
  let broker: SseBroker;

  beforeEach(() => {
    broker = new SseBroker();
  });

  describe('Scenario: Connect an SSE response to a session', () => {
    it('Given a session, When connect is called, Then the connection count increases', () => {
      const res = mockResponse();
      broker.connect('session-1', res);

      expect(broker.connectionCount('session-1')).toBe(1);
    });
  });

  describe('Scenario: Multiple connections per session', () => {
    it('Given a session, When two responses are connected, Then the connection count is 2', () => {
      broker.connect('session-1', mockResponse());
      broker.connect('session-1', mockResponse());

      expect(broker.connectionCount('session-1')).toBe(2);
    });
  });

  describe('Scenario: Cleanup function removes a connection', () => {
    it('Given a connected response, When the cleanup function is called, Then the connection is removed', () => {
      const res = mockResponse();
      const cleanup = broker.connect('session-1', res);

      expect(broker.connectionCount('session-1')).toBe(1);

      cleanup();

      expect(broker.connectionCount('session-1')).toBe(0);
    });
  });

  describe('Scenario: Response close event triggers cleanup', () => {
    it('Given a connected response, When the response emits close, Then the connection is removed', () => {
      const res = mockResponse();
      broker.connect('session-1', res);

      expect(broker.connectionCount('session-1')).toBe(1);

      (res as unknown as EventEmitter).emit('close');

      expect(broker.connectionCount('session-1')).toBe(0);
    });
  });

  describe('Scenario: No connections for unknown session', () => {
    it('Given no connections, When connectionCount is called for an unknown session, Then it returns 0', () => {
      expect(broker.connectionCount('nonexistent')).toBe(0);
    });
  });
});

describe('Feature: SSE Event Emission', () => {
  let broker: SseBroker;

  beforeEach(() => {
    broker = new SseBroker();
  });

  describe('Scenario: Emit event to all session connections', () => {
    it('Given two connected responses, When emit is called, Then both receive the event', () => {
      const res1 = mockResponse();
      const res2 = mockResponse();
      broker.connect('session-1', res1);
      broker.connect('session-1', res2);

      broker.emit('session-1', 'progress', { step: 1 });

      expect(res1.write).toHaveBeenCalledTimes(1);
      expect(res2.write).toHaveBeenCalledTimes(1);

      const written = (res1.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('event: progress');
      expect(written).toContain('"step":1');
      expect(written).toContain('id: 1');
    });
  });

  describe('Scenario: Sequence numbers increment per session', () => {
    it('Given a session, When multiple events are emitted, Then seq numbers increment', () => {
      const res = mockResponse();
      broker.connect('session-1', res);

      broker.emit('session-1', 'progress', { n: 1 });
      broker.emit('session-1', 'progress', { n: 2 });
      broker.emit('session-1', 'progress', { n: 3 });

      const calls = (res.write as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0]).toContain('id: 1');
      expect(calls[1][0]).toContain('id: 2');
      expect(calls[2][0]).toContain('id: 3');
    });
  });

  describe('Scenario: Emit to session with no connections does nothing', () => {
    it('Given no connections, When emit is called, Then no error is thrown', () => {
      expect(() => {
        broker.emit('no-session', 'progress', {});
      }).not.toThrow();
    });
  });

  describe('Scenario: Write errors are silently ignored', () => {
    it('Given a response that throws on write, When emit is called, Then no error propagates', () => {
      const res = mockResponse();
      (res.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('write failed');
      });
      broker.connect('session-1', res);

      expect(() => {
        broker.emit('session-1', 'progress', {});
      }).not.toThrow();
    });
  });

  describe('Scenario: SSE envelope format', () => {
    it('Given an emission, When the event is written, Then it follows SSE wire format', () => {
      const res = mockResponse();
      broker.connect('sess-1', res);

      broker.emit('sess-1', 'tools/list_changed', { snapshot: 'v1' });

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toMatch(/^event: tools\/list_changed\n/);
      expect(written).toMatch(/\ndata: \{.*\}\n/);
      expect(written).toMatch(/\nid: 1\n\n$/);

      const dataMatch = written.match(/data: (.+)\n/);
      const envelope = JSON.parse(dataMatch![1]);
      expect(envelope.sessionId).toBe('sess-1');
      expect(envelope.kind).toBe('tools/list_changed');
      expect(envelope.seq).toBe(1);
      expect(envelope.payload.snapshot).toBe('v1');
      expect(envelope.ts).toBeDefined();
    });
  });
});

describe('Feature: SSE Session Disconnect', () => {
  let broker: SseBroker;

  beforeEach(() => {
    broker = new SseBroker();
  });

  describe('Scenario: Disconnect all session connections', () => {
    it('Given multiple connections, When disconnectSession is called, Then all are ended and removed', () => {
      const res1 = mockResponse();
      const res2 = mockResponse();
      broker.connect('session-1', res1);
      broker.connect('session-1', res2);

      broker.disconnectSession('session-1');

      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).toHaveBeenCalled();
      expect(broker.connectionCount('session-1')).toBe(0);
    });
  });

  describe('Scenario: Disconnect unknown session does nothing', () => {
    it('Given no session, When disconnectSession is called, Then no error is thrown', () => {
      expect(() => broker.disconnectSession('unknown')).not.toThrow();
    });
  });
});

describe('Feature: Typed SSE Notification Helpers', () => {
  let broker: SseBroker;

  beforeEach(() => {
    broker = new SseBroker();
  });

  describe('Scenario: notifyToolsChanged', () => {
    it('Given a session, When notifyToolsChanged is called, Then a tools/list_changed event is emitted', () => {
      const res = mockResponse();
      broker.connect('s1', res);

      broker.notifyToolsChanged('s1', 'snapshot-v2');

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('event: tools/list_changed');
      expect(written).toContain('"snapshot":"snapshot-v2"');
    });
  });

  describe('Scenario: notifyResourceChanged', () => {
    it('Given a session, When notifyResourceChanged is called, Then a resourceChanged event is emitted', () => {
      const res = mockResponse();
      broker.connect('s1', res);

      broker.notifyResourceChanged('s1', 'res-42');

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('event: resourceChanged');
      expect(written).toContain('"resourceId":"res-42"');
    });
  });

  describe('Scenario: notifyProgress', () => {
    it('Given a session, When notifyProgress is called, Then a progress event is emitted', () => {
      const res = mockResponse();
      broker.connect('s1', res);

      broker.notifyProgress('s1', 'inv-1', { percent: 50 });

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('event: progress');
      expect(written).toContain('"invocationId":"inv-1"');
      expect(written).toContain('"percent":50');
    });
  });

  describe('Scenario: notifyStreamEvent', () => {
    it('Given a session, When notifyStreamEvent is called, Then a stream event is emitted', () => {
      const res = mockResponse();
      broker.connect('s1', res);

      broker.notifyStreamEvent('s1', 'inv-2', { token: 'hello' });

      const written = (res.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(written).toContain('event: stream');
      expect(written).toContain('"token":"hello"');
    });
  });
});
