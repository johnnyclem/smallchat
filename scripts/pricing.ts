/**
 * Claude model pricing and token cost calculations.
 *
 * Prices as of March 2026, per million tokens (MTok).
 * 1M-context variants use the same per-token price but are noted separately
 * so the spreadsheet can distinguish runs.
 */

export interface ModelSpec {
  id: string;
  label: string;
  inputPricePerMTok: number;   // USD per 1M input tokens
  outputPricePerMTok: number;  // USD per 1M output tokens
  contextWindow: string;       // "200k" | "1M"
}

export const MODELS: ModelSpec[] = [
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    inputPricePerMTok: 0.80,
    outputPricePerMTok: 4.00,
    contextWindow: '200k',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    inputPricePerMTok: 3.00,
    outputPricePerMTok: 15.00,
    contextWindow: '200k',
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6 (1M)',
    inputPricePerMTok: 3.00,
    outputPricePerMTok: 15.00,
    contextWindow: '1M',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    inputPricePerMTok: 15.00,
    outputPricePerMTok: 75.00,
    contextWindow: '200k',
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6 (1M)',
    inputPricePerMTok: 15.00,
    outputPricePerMTok: 75.00,
    contextWindow: '1M',
  },
];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

export function calculateCost(model: ModelSpec, usage: TokenUsage): CostBreakdown {
  const inputCost = (usage.inputTokens / 1_000_000) * model.inputPricePerMTok;
  const outputCost = (usage.outputTokens / 1_000_000) * model.outputPricePerMTok;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  };
}

export function formatUSD(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
