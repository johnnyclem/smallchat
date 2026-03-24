import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChannelServer } from './channel-server.js';
import type { ChannelServerConfig, ChannelEvent } from './types.js';

// ---------------------------------------------------------------------------
// Integration-ish test: in-process channel server with HTTP bridge
// ---------------------------------------------------------------------------

describe('ChannelServer', () => {
  let server: ChannelServer;
  let config: ChannelServerConfig;

  beforeEach(() => {
    config = {
      channelName: 'test-channel',
      twoWay: true,
      replyToolName: 'reply',
      permissionRelay: false,
      httpBridge: false, // We test HTTP separately
      maxPayloadSize: 1024,
    };
  });

  afterEach(() => {
    if (server) {
      server.shutdown();
    }
  });

  it('injects events and emits them', async () => {
    server = new ChannelServer(config);

    const events: ChannelEvent[] = [];
    server.on('event-injected', (e: ChannelEvent) => events.push(e));

    const ok = server.injectEvent({
      channel: 'test-channel',
      content: 'Hello from test',
      meta: { sender: 'alice', 'invalid-key': 'dropped' },
    });

    expect(ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe('Hello from test');
    // Meta should be filtered — invalid-key dropped
    expect(events[0].meta).toEqual({ sender: 'alice' });
  });

  it('rejects oversized payloads', () => {
    server = new ChannelServer(config);

    const oversized: ChannelEvent[] = [];
    server.on('payload-too-large', () => oversized.push({} as ChannelEvent));

    const ok = server.injectEvent({
      channel: 'test-channel',
      content: 'x'.repeat(2000), // Over 1024 limit
    });

    expect(ok).toBe(false);
    expect(oversized).toHaveLength(1);
  });

  it('enforces sender gating when configured', () => {
    config.senderAllowlist = ['alice', 'bob'];
    server = new ChannelServer(config);

    const rejected: string[] = [];
    server.on('sender-rejected', (s: string) => rejected.push(s));

    // Alice is allowed
    expect(server.injectEvent({
      channel: 'test-channel',
      content: 'Hi from Alice',
      sender: 'alice',
    })).toBe(true);

    // Eve is not allowed
    expect(server.injectEvent({
      channel: 'test-channel',
      content: 'Hi from Eve',
      sender: 'eve',
    })).toBe(false);

    expect(rejected).toEqual(['eve']);
  });

  it('allows all senders when no allowlist is configured', () => {
    server = new ChannelServer(config);

    expect(server.injectEvent({
      channel: 'test-channel',
      content: 'Anyone can send',
      sender: 'unknown',
    })).toBe(true);
  });

  it('adapter accumulates messages', () => {
    server = new ChannelServer(config);

    server.injectEvent({ channel: 'ch', content: 'msg1' });
    server.injectEvent({ channel: 'ch', content: 'msg2' });

    const adapter = server.getAdapter();
    expect(adapter.getMessages()).toHaveLength(2);

    const prompt = adapter.serializeForPrompt();
    expect(prompt).toContain('msg1');
    expect(prompt).toContain('msg2');
    expect(prompt).toContain('<channel source="ch">');
  });
});

// ---------------------------------------------------------------------------
// HTTP bridge integration test
// ---------------------------------------------------------------------------

describe('ChannelServer HTTP bridge', () => {
  let server: ChannelServer;
  const PORT = 19876; // Unlikely to conflict

  afterEach(() => {
    if (server) {
      server.shutdown();
    }
  });

  it('receives events via HTTP POST and emits MCP notification', async () => {
    server = new ChannelServer({
      channelName: 'webhook-test',
      httpBridge: true,
      httpBridgePort: PORT,
      httpBridgeHost: '127.0.0.1',
      maxPayloadSize: 65536,
    });

    const injected: ChannelEvent[] = [];
    server.on('event-injected', (e: ChannelEvent) => injected.push(e));

    // Start only the HTTP bridge (skip stdio to avoid test interference)
    await server.start();

    // POST an event
    const response = await fetch(`http://127.0.0.1:${PORT}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Test webhook event',
        meta: { source: 'github', repo: 'smallchat' },
      }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.channel).toBe('webhook-test');

    // Verify event was injected
    expect(injected).toHaveLength(1);
    expect(injected[0].content).toBe('Test webhook event');
    expect(injected[0].meta).toEqual({ source: 'github', repo: 'smallchat' });
  });

  it('rejects invalid payloads', async () => {
    server = new ChannelServer({
      channelName: 'webhook-test',
      httpBridge: true,
      httpBridgePort: PORT + 1,
      httpBridgeHost: '127.0.0.1',
    });

    await server.start();

    // Missing content field
    const response = await fetch(`http://127.0.0.1:${PORT + 1}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: { foo: 'bar' } }),
    });

    expect(response.status).toBe(400);
  });

  it('health endpoint reports status', async () => {
    server = new ChannelServer({
      channelName: 'health-test',
      twoWay: true,
      permissionRelay: true,
      httpBridge: true,
      httpBridgePort: PORT + 2,
      httpBridgeHost: '127.0.0.1',
    });

    await server.start();

    const response = await fetch(`http://127.0.0.1:${PORT + 2}/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.channel).toBe('health-test');
    expect(body.twoWay).toBe(true);
    expect(body.permissionRelay).toBe(true);
  });

  it('enforces shared secret on HTTP bridge', async () => {
    server = new ChannelServer({
      channelName: 'secret-test',
      httpBridge: true,
      httpBridgePort: PORT + 3,
      httpBridgeHost: '127.0.0.1',
      httpBridgeSecret: 'my-secret-token',
    });

    await server.start();

    // Without secret
    const badResponse = await fetch(`http://127.0.0.1:${PORT + 3}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(badResponse.status).toBe(401);

    // With correct secret
    const goodResponse = await fetch(`http://127.0.0.1:${PORT + 3}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Channel-Secret': 'my-secret-token',
      },
      body: JSON.stringify({ content: 'test' }),
    });
    expect(goodResponse.status).toBe(200);
  });
});
