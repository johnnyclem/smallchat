/**
 * Feature: Claude Code Channel Adapter
 *
 * Transforms channel notifications into smallchat message objects,
 * serializes to <channel> tags for Claude model prompts, and
 * accumulates channel context for LLM conversations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ClaudeCodeChannelAdapter } from './adapter.js';

describe('Feature: Channel Notification Parsing', () => {
  let adapter: ClaudeCodeChannelAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeChannelAdapter();
  });

  describe('Scenario: Parse valid channel notification', () => {
    it('Given valid notification params, When parseNotification is called, Then a ChannelEvent is returned', () => {
      const event = adapter.parseNotification({
        channel: 'slack',
        content: 'Hello from Slack!',
        sender: 'user-1',
        timestamp: '2025-01-01T00:00:00Z',
      });

      expect(event).not.toBeNull();
      expect(event!.channel).toBe('slack');
      expect(event!.content).toBe('Hello from Slack!');
      expect(event!.sender).toBe('user-1');
      expect(event!.timestamp).toBe('2025-01-01T00:00:00Z');
    });
  });

  describe('Scenario: Parse notification with metadata', () => {
    it('Given notification params with meta, When parseNotification is called, Then meta keys are filtered', () => {
      const event = adapter.parseNotification({
        channel: 'discord',
        content: 'Hi',
        meta: { valid_key: 'value', 'invalid-key': 'dropped' },
      });

      expect(event).not.toBeNull();
      expect(event!.meta?.valid_key).toBe('value');
      expect(event!.meta?.['invalid-key']).toBeUndefined();
    });
  });

  describe('Scenario: Reject invalid notification params', () => {
    it('Given null params, When parseNotification is called, Then null is returned', () => {
      expect(adapter.parseNotification(null)).toBeNull();
    });

    it('Given params without channel, When parseNotification is called, Then null is returned', () => {
      expect(adapter.parseNotification({ content: 'text' })).toBeNull();
    });

    it('Given params without content, When parseNotification is called, Then null is returned', () => {
      expect(adapter.parseNotification({ channel: 'ch' })).toBeNull();
    });

    it('Given non-object params, When parseNotification is called, Then null is returned', () => {
      expect(adapter.parseNotification('string')).toBeNull();
    });
  });

  describe('Scenario: Reject oversized payloads', () => {
    it('Given content exceeding maxPayloadBytes, When parseNotification is called, Then null is returned', () => {
      const smallAdapter = new ClaudeCodeChannelAdapter({ maxPayloadBytes: 10 });
      const event = smallAdapter.parseNotification({
        channel: 'ch',
        content: 'This content is way too long for the limit',
      });

      expect(event).toBeNull();
    });
  });
});

describe('Feature: Permission Request Parsing', () => {
  let adapter: ClaudeCodeChannelAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeChannelAdapter();
  });

  describe('Scenario: Parse valid permission request', () => {
    it('Given valid permission params, When parsePermissionRequest is called, Then a PermissionRequest is returned', () => {
      const req = adapter.parsePermissionRequest({
        request_id: 'abc123',
        description: 'Run dangerous command',
        tool_name: 'bash',
        tool_arguments: { command: 'rm -rf /' },
      });

      expect(req).not.toBeNull();
      expect(req!.request_id).toBe('abc123');
      expect(req!.description).toBe('Run dangerous command');
      expect(req!.tool_name).toBe('bash');
      expect(req!.tool_arguments).toEqual({ command: 'rm -rf /' });
    });
  });

  describe('Scenario: Reject invalid permission request', () => {
    it('Given null params, When parsePermissionRequest is called, Then null is returned', () => {
      expect(adapter.parsePermissionRequest(null)).toBeNull();
    });

    it('Given missing request_id, When parsePermissionRequest is called, Then null is returned', () => {
      expect(adapter.parsePermissionRequest({ description: 'test' })).toBeNull();
    });

    it('Given missing description, When parsePermissionRequest is called, Then null is returned', () => {
      expect(adapter.parsePermissionRequest({ request_id: 'id' })).toBeNull();
    });
  });

  describe('Scenario: Optional fields default to undefined', () => {
    it('Given no tool_name or tool_arguments, When parsePermissionRequest is called, Then optional fields are undefined', () => {
      const req = adapter.parsePermissionRequest({
        request_id: 'id1',
        description: 'Do something',
      });

      expect(req!.tool_name).toBeUndefined();
      expect(req!.tool_arguments).toBeUndefined();
    });
  });
});

describe('Feature: Message Ingestion and Buffer', () => {
  let adapter: ClaudeCodeChannelAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeChannelAdapter({ maxMessages: 3 });
  });

  describe('Scenario: Ingest a channel event', () => {
    it('Given a channel event, When ingest is called, Then the message is added to the buffer', () => {
      const msg = adapter.ingest({
        channel: 'slack',
        content: 'Hello',
      });

      expect(msg.type).toBe('channel-event');
      expect(msg.channel).toBe('slack');
      expect(msg.content).toBe('Hello');
      expect(msg.receivedAt).toBeGreaterThan(0);

      expect(adapter.getMessages()).toHaveLength(1);
    });
  });

  describe('Scenario: Buffer evicts old messages when full', () => {
    it('Given a buffer of maxMessages=3, When 5 events are ingested, Then only the last 3 remain', () => {
      for (let i = 0; i < 5; i++) {
        adapter.ingest({ channel: 'ch', content: `msg-${i}` });
      }

      const messages = adapter.getMessages();
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('msg-2');
      expect(messages[2].content).toBe('msg-4');
    });
  });

  describe('Scenario: Clear the message buffer', () => {
    it('Given accumulated messages, When clear is called, Then the buffer is empty', () => {
      adapter.ingest({ channel: 'ch', content: 'msg' });
      adapter.clear();

      expect(adapter.getMessages()).toHaveLength(0);
    });
  });
});

describe('Feature: Prompt Serialization', () => {
  let adapter: ClaudeCodeChannelAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeChannelAdapter();
  });

  describe('Scenario: Serialize events to <channel> tags', () => {
    it('Given ingested events, When serializeForPrompt is called, Then events are serialized as XML tags', () => {
      adapter.ingest({ channel: 'slack', content: 'Hello' });
      adapter.ingest({ channel: 'discord', content: 'World' });

      const prompt = adapter.serializeForPrompt();

      expect(prompt).toContain('<channel source="slack">');
      expect(prompt).toContain('Hello');
      expect(prompt).toContain('<channel source="discord">');
      expect(prompt).toContain('World');
    });
  });

  describe('Scenario: Serialize single event', () => {
    it('Given a single event, When serializeEvent is called, Then it returns a <channel> tag', () => {
      const tag = adapter.serializeEvent({
        channel: 'test',
        content: 'Test content',
        meta: { priority: 'high' },
      });

      expect(tag).toContain('<channel source="test"');
      expect(tag).toContain('priority="high"');
      expect(tag).toContain('Test content');
      expect(tag).toContain('</channel>');
    });
  });
});

describe('Feature: Notification Building', () => {
  let adapter: ClaudeCodeChannelAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeChannelAdapter();
  });

  describe('Scenario: Build notification params from event', () => {
    it('Given a channel event, When buildNotificationParams is called, Then MCP notification params are returned', () => {
      const params = adapter.buildNotificationParams({
        channel: 'slack',
        content: 'test',
        meta: { key: 'val' },
      });

      expect(params).toEqual({
        channel: 'slack',
        content: 'test',
        meta: { key: 'val' },
      });
    });
  });

  describe('Scenario: Build permission verdict', () => {
    it('Given a request ID and allow, When buildPermissionVerdict is called, Then a verdict is returned', () => {
      const verdict = adapter.buildPermissionVerdict('req-1', 'allow');
      expect(verdict).toEqual({ request_id: 'req-1', behavior: 'allow' });
    });

    it('Given a request ID and deny, When buildPermissionVerdict is called, Then a deny verdict is returned', () => {
      const verdict = adapter.buildPermissionVerdict('req-2', 'deny');
      expect(verdict).toEqual({ request_id: 'req-2', behavior: 'deny' });
    });
  });
});
