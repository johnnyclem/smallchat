/**
 * ClaudeCodeChannelAdapter — transforms channel notifications into smallchat
 * message objects and can serialize to <channel> tags for Claude model prompts.
 *
 * This adapter bridges the gap between MCP channel notifications and smallchat's
 * internal message/dispatch model. It provides:
 *
 *   1. Parsing MCP notification params → ChannelEvent objects
 *   2. Converting ChannelEvents → smallchat dispatch-compatible messages
 *   3. Serializing events to <channel> XML tags for prompt injection
 *   4. Accumulating channel context for LLM conversations
 */

import type { ChannelEvent, ChannelNotificationParams, PermissionRequest, PermissionVerdict } from './types.js';
import { filterMetaKeys, serializeChannelTag, validatePayloadSize } from './utils.js';

// ---------------------------------------------------------------------------
// Channel message — smallchat's internal representation
// ---------------------------------------------------------------------------

export interface ChannelMessage {
  /** Message type discriminator */
  type: 'channel-event' | 'permission-request';
  /** Source channel name */
  channel: string;
  /** Message content */
  content: string;
  /** Filtered metadata */
  meta?: Record<string, string>;
  /** Sender identity (post-gating) */
  sender?: string;
  /** When the event was received */
  receivedAt: number;
  /** Original raw event (for auditing) */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeCodeChannelAdapter {
  private messages: ChannelMessage[] = [];
  private maxMessages: number;
  private maxPayloadBytes: number;

  constructor(options?: {
    maxMessages?: number;
    maxPayloadBytes?: number;
  }) {
    this.maxMessages = options?.maxMessages ?? 100;
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 64 * 1024;
  }

  /**
   * Parse an MCP notifications/claude/channel payload into a ChannelEvent.
   * Returns null if the payload is invalid or exceeds size limits.
   */
  parseNotification(params: unknown): ChannelEvent | null {
    if (!params || typeof params !== 'object') return null;

    const p = params as Record<string, unknown>;
    const channel = p.channel;
    const content = p.content;

    if (typeof channel !== 'string' || !channel) return null;
    if (typeof content !== 'string') return null;

    // Payload size check
    const sizeCheck = validatePayloadSize(content, this.maxPayloadBytes);
    if (!sizeCheck.valid) return null;

    const meta = filterMetaKeys(p.meta as Record<string, unknown> | undefined);
    const sender = typeof p.sender === 'string' ? p.sender : undefined;
    const timestamp = typeof p.timestamp === 'string' ? p.timestamp : undefined;

    return { channel, content, meta, sender, timestamp };
  }

  /**
   * Parse an MCP notifications/claude/channel/permission_request payload.
   */
  parsePermissionRequest(params: unknown): PermissionRequest | null {
    if (!params || typeof params !== 'object') return null;

    const p = params as Record<string, unknown>;
    const request_id = p.request_id;
    const description = p.description;

    if (typeof request_id !== 'string' || !request_id) return null;
    if (typeof description !== 'string') return null;

    return {
      request_id,
      description,
      tool_name: typeof p.tool_name === 'string' ? p.tool_name : undefined,
      tool_arguments: typeof p.tool_arguments === 'object' && p.tool_arguments !== null
        ? p.tool_arguments as Record<string, unknown>
        : undefined,
    };
  }

  /**
   * Convert a ChannelEvent to a ChannelMessage and add to the context buffer.
   */
  ingest(event: ChannelEvent): ChannelMessage {
    const message: ChannelMessage = {
      type: 'channel-event',
      channel: event.channel,
      content: event.content,
      meta: event.meta,
      sender: event.sender,
      receivedAt: Date.now(),
      raw: event,
    };

    this.messages.push(message);

    // Evict old messages if buffer is full
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }

    return message;
  }

  /**
   * Get all accumulated channel messages.
   */
  getMessages(): readonly ChannelMessage[] {
    return this.messages;
  }

  /**
   * Clear the message buffer.
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Serialize all accumulated messages to <channel> XML tags for prompt generation.
   * This is the format Claude Code uses to present channel events in LLM context.
   */
  serializeForPrompt(): string {
    return this.messages
      .map(m => serializeChannelTag(m.channel, m.content, m.meta))
      .join('\n\n');
  }

  /**
   * Serialize a single event to a <channel> tag.
   */
  serializeEvent(event: ChannelEvent): string {
    return serializeChannelTag(event.channel, event.content, event.meta);
  }

  /**
   * Build the notification params for emitting a channel event over MCP.
   */
  buildNotificationParams(event: ChannelEvent): ChannelNotificationParams {
    return {
      channel: event.channel,
      content: event.content,
      meta: event.meta,
    };
  }

  /**
   * Build the notification params for a permission verdict.
   */
  buildPermissionVerdict(requestId: string, behavior: 'allow' | 'deny'): PermissionVerdict {
    return { request_id: requestId, behavior };
  }
}
