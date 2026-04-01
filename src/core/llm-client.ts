/**
 * LLMClient — pluggable interface for LLM-powered features in 0.4.0.
 *
 * smallchat does not bundle an LLM SDK. Callers inject an implementation
 * of this interface to enable:
 *   - Pillar 2c: LLM micro-check verification
 *   - Pillar 3:  Intent decomposition
 *   - Pillar 4:  Refinement protocol
 *
 * All methods are optional. Features degrade gracefully without them.
 */

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface LLMClient {
  /**
   * Micro-check: does a tool match an intent? Single-token yes/no response.
   * Used by Pillar 2c for MEDIUM-confidence verification.
   *
   * @returns true if the tool matches the intent, false otherwise
   */
  microCheck?(request: MicroCheckRequest): Promise<boolean>;

  /**
   * Decompose a complex intent into sub-intents using available tools.
   * Used by Pillar 3 for LOW-confidence dispatches.
   *
   * @returns Array of sub-intents with optional dependency graph
   */
  decompose?(request: DecomposeRequest): Promise<DecomposeResponse>;

  /**
   * Generate refinement options for an ambiguous intent.
   * Used by Pillar 4 for NONE-confidence dispatches.
   *
   * @returns Structured question with options to narrow the intent
   */
  refine?(request: RefineRequest): Promise<RefineResponse>;
}

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export interface MicroCheckRequest {
  intent: string;
  toolName: string;
  toolDescription: string;
}

export interface DecomposeRequest {
  intent: string;
  availableTools: ToolSummary[];
}

export interface DecomposeResponse {
  subIntents: SubIntent[];
  strategy: 'sequential' | 'parallel' | 'conditional';
}

export interface SubIntent {
  intent: string;
  args?: Record<string, unknown>;
  dependsOn?: string[];
}

export interface RefineRequest {
  intent: string;
  nearestTools: ToolSummary[];
}

export interface RefineResponse {
  question: string;
  options: RefinementOption[];
  narrowedIntents: string[];
}

export interface RefinementOption {
  label: string;
  intent: string;
  confidence: number;
}

export interface ToolSummary {
  name: string;
  description: string;
  parameters?: string[];
}

// ---------------------------------------------------------------------------
// No-op implementation — all features disabled
// ---------------------------------------------------------------------------

export const NULL_LLM_CLIENT: LLMClient = Object.freeze({});
