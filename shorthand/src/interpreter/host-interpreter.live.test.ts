/**
 * Live integration test for HostInterpreter.
 *
 * Skipped automatically when ANTHROPIC_API_KEY is not set or
 * @anthropic-ai/sdk is not installed. Used to verify the bounded contract
 * end-to-end against the real Anthropic API.
 */
import { describe, it, expect } from 'vitest';
import { HostInterpreter, type AnthropicLikeClient } from './host-interpreter.js';
import { DEFAULT_LIVE_MODEL } from '../benchmark/live.js';

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

async function loadClient(): Promise<AnthropicLikeClient | null> {
  const moduleName = '@anthropic-ai/sdk';
  try {
    const mod = (await import(moduleName)) as unknown as {
      default: new (opts: { apiKey: string }) => AnthropicLikeClient;
    };
    return new mod.default({ apiKey: process.env.ANTHROPIC_API_KEY! });
  } catch {
    return null;
  }
}

describe.skipIf(!HAS_KEY)('HostInterpreter — live (gated by ANTHROPIC_API_KEY)', () => {
  it('returns a non-empty bounded interpretation', async () => {
    const client = await loadClient();
    if (!client) {
      console.warn('skipping: @anthropic-ai/sdk is not installed');
      return;
    }
    const h = new HostInterpreter({
      client,
      model: process.env.SHORTHAND_BENCHMARK_MODEL || DEFAULT_LIVE_MODEL,
    });
    const out = await h.interpret(
      {
        template:
          'Restate the engram in light of {{context}}: {{payload}}.',
        payload: 'user prefers CLI tools',
        context: 'designing a web dashboard for non-technical operators',
      },
      { maxOutputTokens: 64, timeoutMs: 15_000 },
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('user prefers CLI tools');
  }, 30_000);
});
