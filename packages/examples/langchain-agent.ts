/**
 * LangChain Agent Example — powered by Smallchat dispatch
 *
 * This example shows two integration patterns:
 *
 *  Pattern A — Individual tools (SmallChatToolkit)
 *    Each registered Smallchat tool is exposed as a discrete LangChain tool.
 *    The agent selects tools by name using the LLM's native tool-calling.
 *
 *  Pattern B — Dispatch tool (SmallChatDispatchTool)
 *    A single omnibus tool that routes natural-language intents through
 *    toolkit_dispatch. The LLM describes what it wants; Smallchat resolves
 *    the best provider and executes it.
 *
 * Run:
 *   ts-node packages/examples/langchain-agent.ts
 *
 * Prerequisites:
 *   npm install langchain @langchain/openai @langchain/core
 *   export OPENAI_API_KEY=sk-...
 */

import { MemoryVectorIndex } from '../../src/embedding/memory-vector-index.js';
import { LocalEmbedder } from '../../src/embedding/local-embedder.js';
import { ToolRuntime } from '../../src/runtime/runtime.js';
import { ToolClass } from '../../src/core/tool-class.js';
import { SelectorTable } from '../../src/core/selector-table.js';
import type { ToolIMP, ToolResult } from '../../src/core/types.js';
import {
  SmallChatTool,
  SmallChatToolkit,
  SmallChatDispatchTool,
} from '../../src/integrations/langchain/index.js';

// ---------------------------------------------------------------------------
// 1. Bootstrap the Smallchat runtime
// ---------------------------------------------------------------------------

async function buildRuntime(): Promise<ToolRuntime> {
  const embedder = new LocalEmbedder();
  const vectorIndex = new MemoryVectorIndex();
  const runtime = new ToolRuntime(vectorIndex, embedder);

  // Register a mock "weather" provider
  const weatherClass = new ToolClass('weather');

  const getWeatherSelector = await runtime.selectorTable.resolve('get current weather for a city');

  const getWeatherImp: ToolIMP = {
    providerId: 'weather',
    toolName: 'get_weather',
    transportType: 'local',
    schema: {
      name: 'get_weather',
      description: 'Get current weather conditions for a city',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          units: { type: 'string', description: 'celsius or fahrenheit', enum: ['celsius', 'fahrenheit'] },
        },
        required: ['city'],
      },
      arguments: [],
    },
    schemaLoader: async () => getWeatherImp.schema!,
    constraints: {
      required: [],
      optional: [],
      validate: () => ({ valid: true, errors: [] }),
    },
    async execute(args): Promise<ToolResult> {
      const city = args.city as string ?? 'Unknown';
      const units = args.units as string ?? 'celsius';
      // Simulated response
      return {
        content: {
          city,
          temperature: units === 'celsius' ? 22 : 71,
          units,
          conditions: 'partly cloudy',
          humidity: 60,
          wind_speed: 15,
        },
      };
    },
  };

  weatherClass.addMethod(getWeatherSelector, getWeatherImp);

  // Register a mock "calculator" provider
  const calcClass = new ToolClass('calculator');
  const calcSelector = await runtime.selectorTable.resolve('evaluate mathematical expression');

  const calcImp: ToolIMP = {
    providerId: 'calculator',
    toolName: 'evaluate',
    transportType: 'local',
    schema: {
      name: 'evaluate',
      description: 'Evaluate a mathematical expression',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Math expression to evaluate, e.g. "2 + 3 * 4"' },
        },
        required: ['expression'],
      },
      arguments: [],
    },
    schemaLoader: async () => calcImp.schema!,
    constraints: {
      required: [],
      optional: [],
      validate: () => ({ valid: true, errors: [] }),
    },
    async execute(args): Promise<ToolResult> {
      const expr = args.expression as string ?? '';
      try {
        // Safe numeric-only eval (no exec of arbitrary code)
        const sanitized = expr.replace(/[^0-9+\-*/().% ]/g, '');
        // eslint-disable-next-line no-new-func
        const result = Function(`'use strict'; return (${sanitized})`)() as number;
        return { content: { expression: expr, result } };
      } catch {
        return { content: null, isError: true, metadata: { error: `Cannot evaluate: ${expr}` } };
      }
    },
  };

  calcClass.addMethod(calcSelector, calcImp);

  runtime.registerClass(weatherClass);
  runtime.registerClass(calcClass);

  return runtime;
}

// ---------------------------------------------------------------------------
// 2. Pattern A — Individual SmallChatTool instances
// ---------------------------------------------------------------------------

async function patternA_IndividualTools(): Promise<void> {
  console.log('\n=== Pattern A: Individual Tools ===\n');

  const runtime = await buildRuntime();
  const toolkit = new SmallChatToolkit(runtime);
  const tools = toolkit.getTools();

  console.log(`Registered ${tools.length} LangChain tools:`);
  for (const tool of tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }

  // Simulate calling the weather tool directly
  const weatherTool = tools.find(t => t.name.includes('weather'));
  if (weatherTool) {
    console.log('\nCalling weather tool...');
    const result = await weatherTool.invoke({ city: 'London', units: 'celsius' });
    console.log('Result:', result.content);
  }

  // Show OpenAI-compatible function spec
  const functions = toolkit.getOpenAIFunctions();
  console.log('\nOpenAI function spec (first tool):');
  console.log(JSON.stringify(functions[0], null, 2));
}

// ---------------------------------------------------------------------------
// 3. Pattern B — Single dispatch tool
// ---------------------------------------------------------------------------

async function patternB_DispatchTool(): Promise<void> {
  console.log('\n=== Pattern B: SmallChatDispatchTool ===\n');

  const runtime = await buildRuntime();
  const dispatchTool = new SmallChatDispatchTool(runtime);

  console.log(`Tool: ${dispatchTool.name}`);
  console.log(`Description: ${dispatchTool.description}\n`);

  // Example: natural language dispatch
  const intents = [
    { intent: 'what is the weather in Tokyo', args: { city: 'Tokyo', units: 'celsius' } },
    { intent: 'calculate 100 divided by 4 plus 25', args: { expression: '100 / 4 + 25' } },
  ];

  for (const { intent, args } of intents) {
    console.log(`Intent: "${intent}"`);
    const result = await dispatchTool.invoke({ intent, args });
    console.log('Result:', result.content, '\n');
  }
}

// ---------------------------------------------------------------------------
// 4. Pattern C — Integration with LangChain AgentExecutor (pseudo-code)
//    Requires: npm install langchain @langchain/openai @langchain/core
// ---------------------------------------------------------------------------

function patternC_AgentExecutorPseudoCode(): void {
  console.log('\n=== Pattern C: LangChain AgentExecutor Integration ===\n');
  console.log(`
// With LangChain installed:
//
// import { ChatOpenAI } from '@langchain/openai';
// import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
// import { ChatPromptTemplate } from '@langchain/core/prompts';
//
// const runtime = await buildRuntime();
// const toolkit = new SmallChatToolkit(runtime);
// const tools = toolkit.getTools();
//
// const llm = new ChatOpenAI({ model: 'gpt-4o', temperature: 0 });
// const prompt = ChatPromptTemplate.fromMessages([
//   ['system', 'You are a helpful assistant with access to tools.'],
//   ['human', '{input}'],
//   ['placeholder', '{agent_scratchpad}'],
// ]);
//
// const agent = await createToolCallingAgent({ llm, tools, prompt });
// const executor = new AgentExecutor({ agent, tools });
//
// const response = await executor.invoke({
//   input: 'What is the weather in Paris and what is 42 * 17?',
// });
// console.log(response.output);
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await patternA_IndividualTools();
  await patternB_DispatchTool();
  patternC_AgentExecutorPseudoCode();

  console.log('\nDone. See comments in this file for the full LangChain agent integration.');
}

main().catch(err => {
  console.error('Example failed:', err);
  process.exit(1);
});
