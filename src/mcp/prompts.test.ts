import { describe, it, expect, beforeEach } from 'vitest';
import { PromptRegistry, PromptNotFoundError, type PromptHandler, type StaticPrompt } from './prompts.js';

describe('PromptRegistry', () => {
  let registry: PromptRegistry;

  const mockHandler: PromptHandler = {
    providerId: 'test-provider',
    async list() {
      return [
        {
          name: 'summarize',
          description: 'Summarize text',
          arguments: [{ name: 'text', required: true }],
        },
      ];
    },
    async get(name: string, args?: Record<string, string>) {
      if (name === 'summarize') {
        return [
          { role: 'user' as const, content: { type: 'text' as const, text: `Summarize: ${args?.text ?? ''}` } },
        ];
      }
      throw new PromptNotFoundError(name);
    },
  };

  beforeEach(() => {
    registry = new PromptRegistry();
  });

  it('lists prompts from registered handlers', async () => {
    registry.registerHandler(mockHandler);
    const result = await registry.list();
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].name).toBe('summarize');
  });

  it('gets and renders a prompt from a handler', async () => {
    registry.registerHandler(mockHandler);
    const result = await registry.get('summarize', { text: 'Hello world' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toEqual({
      type: 'text',
      text: 'Summarize: Hello world',
    });
  });

  it('throws PromptNotFoundError for unknown prompt', async () => {
    await expect(registry.get('nonexistent')).rejects.toThrow(PromptNotFoundError);
  });

  it('registers and renders static prompts', async () => {
    const staticPrompt: StaticPrompt = {
      name: 'greet',
      description: 'Greet a user',
      arguments: [{ name: 'name', required: true }],
      template: [
        { role: 'system', content: { type: 'text', text: 'You are a friendly assistant.' } },
        { role: 'user', content: { type: 'text', text: 'Hello, {{name}}!' } },
      ],
    };

    registry.registerPrompt(staticPrompt);

    const listed = await registry.list();
    expect(listed.prompts).toHaveLength(1);
    expect(listed.prompts[0].name).toBe('greet');

    const result = await registry.get('greet', { name: 'Alice' });
    expect(result.description).toBe('Greet a user');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].content).toEqual({
      type: 'text',
      text: 'Hello, Alice!',
    });
  });

  it('combines handler and static prompts in list', async () => {
    registry.registerHandler(mockHandler);
    registry.registerPrompt({
      name: 'static-prompt',
      template: [{ role: 'user', content: { type: 'text', text: 'Static' } }],
    });

    const result = await registry.list();
    expect(result.prompts).toHaveLength(2);
  });

  it('unregisters a handler', async () => {
    registry.registerHandler(mockHandler);
    registry.unregisterHandler('test-provider');
    const result = await registry.list();
    expect(result.prompts).toHaveLength(0);
  });
});
