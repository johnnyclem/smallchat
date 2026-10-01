/**
 * MCP types for `smallchat serve`.
 *
 * Wire types come from the official SDK (@modelcontextprotocol/sdk/types.js);
 * these are the smallchat-specific shapes for programmatic registration.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '../core/types.js';

/**
 * The MCP protocol versions `smallchat serve` negotiates — exactly the
 * SDK's (newest first). A client asking for another version is answered
 * with the newest.
 */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [...SUPPORTED_PROTOCOL_VERSIONS];

// ---------------------------------------------------------------------------
// MCP Apps Extension types (io.modelcontextprotocol/ui, spec 2026-01-26)
// ---------------------------------------------------------------------------

/** UI resource metadata declared by MCP Apps tool authors */
export interface McpUiToolMeta {
  /** The ui:// resource URI for this tool's interactive view */
  resourceUri: string;
  /**
   * Which audiences may invoke this view.
   * "model" = AI only, "app" = UI only, both = unrestricted (default).
   */
  visibility?: Array<'model' | 'app'>;
}

/** CSP and permission metadata for a ui:// resource */
export interface McpUiResourceMeta {
  /** External domains the view may connect to (connect-src CSP) */
  allowedDomains?: string[];
  /** Browser capabilities the view requests */
  permissions?: Array<'camera' | 'microphone' | 'geolocation' | 'clipboard-write'>;
  /** Dedicated origin for OAuth callbacks or API allowlists */
  domain?: string;
  /** Visual hint: render with border/background (true) or borderless (false) */
  prefersBorder?: boolean;
}

/** A tool registered programmatically with MCPServer.registerTool — an MCP Tool definition. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  outputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  annotations?: ToolAnnotations;
  /** MCP Apps metadata — present when this tool has an interactive view */
  _meta?: { ui?: McpUiToolMeta; [key: string]: unknown };
}
