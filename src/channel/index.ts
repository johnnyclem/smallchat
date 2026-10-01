/**
 * Channel module — Claude Code channel protocol support for smallchat.
 */

// Types
export type {
  ChannelCapabilities,
  ChannelExperimentalCapabilities,
  ChannelEvent,
  ChannelNotificationParams,
  PermissionRequest,
  PermissionVerdict,
  RecordedPermissionVerdict,
  ChannelProviderMeta,
  ChannelServerConfig,
} from './types.js';

// Utilities
export {
  filterMetaKeys,
  isValidMetaKey,
  RESERVED_META_KEYS,
  parsePermissionReply,
  isValidPermissionId,
  validatePayloadSize,
  serializeChannelTag,
} from './utils.js';

// Adapter
export { ClaudeCodeChannelAdapter } from './adapter.js';
export type { ChannelMessage } from './adapter.js';

// Sender gate
export { SenderGate } from './sender-gate.js';

// Channel server
export { ChannelServer } from './channel-server.js';
