import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const initCommand = new Command('init')
  .description('Scaffold a new smallchat project with sample tools and configuration')
  .argument('[directory]', 'Directory to initialize (defaults to current directory)')
  .option('-t, --template <type>', 'Project template: basic, mcp-server, agent', 'basic')
  .option('--no-git', 'Skip git initialization')
  .option('--no-install', 'Skip npm install')
  .action(async (directory, options) => {
    const projectDir = resolve(directory ?? '.');
    const projectName = projectDir.split('/').pop() ?? 'my-smallchat-project';
    const template = options.template as 'basic' | 'mcp-server' | 'agent';

    console.log(`\nInitializing smallchat project in ${projectDir}...\n`);

    // Create directory structure
    const dirs = [
      '',
      'tools',
      'manifests',
      'src',
    ];

    for (const dir of dirs) {
      const fullPath = join(projectDir, dir);
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
        console.log(`  Created ${dir || '.'}/`);
      }
    }

    // Write package.json
    const packageJson = generatePackageJson(projectName, template);
    writeIfNotExists(join(projectDir, 'package.json'), JSON.stringify(packageJson, null, 2));

    // Write tsconfig.json
    const tsconfig = generateTsconfig();
    writeIfNotExists(join(projectDir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

    // Write .gitignore
    writeIfNotExists(join(projectDir, '.gitignore'), GITIGNORE_CONTENT);

    // Write smallchat config
    writeIfNotExists(join(projectDir, 'smallchat.config.json'), JSON.stringify(generateConfig(template), null, 2));

    // Generate template-specific files
    switch (template) {
      case 'basic':
        generateBasicTemplate(projectDir);
        break;
      case 'mcp-server':
        generateMcpServerTemplate(projectDir);
        break;
      case 'agent':
        generateAgentTemplate(projectDir);
        break;
    }

    // Write sample manifest
    const sampleManifest = generateSampleManifest(projectName);
    writeIfNotExists(
      join(projectDir, 'manifests', `${projectName}-manifest.json`),
      JSON.stringify(sampleManifest, null, 2),
    );

    console.log('\nProject scaffolded successfully!\n');
    console.log('Next steps:');
    console.log(`  cd ${directory ?? '.'}`);
    if (options.install !== false) {
      console.log('  npm install');
    }
    console.log('  npx smallchat compile');
    console.log('  npx smallchat resolve tools.toolkit.json "hello world"');
    console.log('');
    console.log(`Template: ${template}`);
    console.log('Run "smallchat doctor" to verify your setup.\n');
  });

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

function generateBasicTemplate(projectDir: string): void {
  // Sample tool definition
  const toolFile = `import type { ToolResult } from 'smallchat';

/**
 * A sample greeting tool that demonstrates the basic tool structure.
 */
export async function greet(args: { name: string; greeting?: string }): Promise<ToolResult> {
  const greeting = args.greeting ?? 'Hello';
  return {
    content: \`\${greeting}, \${args.name}! Welcome to smallchat.\`,
  };
}

/**
 * A sample echo tool that returns whatever you send it.
 */
export async function echo(args: { message: string }): Promise<ToolResult> {
  return {
    content: args.message,
  };
}
`;
  writeIfNotExists(join(projectDir, 'tools', 'sample-tools.ts'), toolFile);

  // Entry point
  const entryPoint = `import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from 'smallchat';

async function main() {
  // Create the runtime with in-memory vector index
  const vectorIndex = new MemoryVectorIndex();
  const embedder = new LocalEmbedder();
  const runtime = new ToolRuntime(vectorIndex, embedder);

  // Compile your tools
  console.log('Compiling tools...');
  // Use: npx smallchat compile --source ./manifests

  // Dispatch an intent
  const result = await runtime.dispatch('greet someone', { name: 'World' });
  console.log('Result:', result.content);
}

main().catch(console.error);
`;
  writeIfNotExists(join(projectDir, 'src', 'index.ts'), entryPoint);
}

function generateMcpServerTemplate(projectDir: string): void {
  const serverFile = `import { MCPServer } from 'smallchat';

const server = new MCPServer({
  port: 3001,
  host: '127.0.0.1',
  sourcePath: './manifests',
  dbPath: 'smallchat.db',
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

server.start().then(() => {
  console.log('MCP server running on http://127.0.0.1:3001');
  console.log('Discovery: http://127.0.0.1:3001/.well-known/mcp.json');
});
`;
  writeIfNotExists(join(projectDir, 'src', 'server.ts'), serverFile);

  // Sample tool
  const toolFile = `import type { ToolResult } from 'smallchat';

export async function fetchUrl(args: { url: string }): Promise<ToolResult> {
  const response = await fetch(args.url);
  const text = await response.text();
  return {
    content: text.slice(0, 5000),
    metadata: {
      status: response.status,
      contentType: response.headers.get('content-type'),
    },
  };
}

export async function currentTime(_args: Record<string, unknown>): Promise<ToolResult> {
  return {
    content: new Date().toISOString(),
  };
}
`;
  writeIfNotExists(join(projectDir, 'tools', 'mcp-tools.ts'), toolFile);
}

function generateAgentTemplate(projectDir: string): void {
  const agentFile = `import { ToolRuntime, MemoryVectorIndex, LocalEmbedder } from 'smallchat';

/**
 * A simple agent loop that takes user input, dispatches to tools,
 * and streams the results.
 */
async function agent() {
  const vectorIndex = new MemoryVectorIndex();
  const embedder = new LocalEmbedder();
  const runtime = new ToolRuntime(vectorIndex, embedder);

  console.log('Agent ready. Processing intents...\\n');

  // Example: process a list of intents
  const intents = [
    'look up the weather',
    'search for documents',
    'send a notification',
  ];

  for (const intent of intents) {
    console.log(\`Intent: "\${intent}"\`);

    for await (const event of runtime.dispatchStream(intent)) {
      switch (event.type) {
        case 'resolving':
          console.log('  Resolving...');
          break;
        case 'tool-start':
          console.log(\`  Tool: \${event.toolName} (confidence: \${(event.confidence * 100).toFixed(1)}%)\`);
          break;
        case 'chunk':
          console.log(\`  Result: \${JSON.stringify(event.content)}\`);
          break;
        case 'error':
          console.log(\`  Error: \${event.error}\`);
          break;
        case 'done':
          console.log('  Done.\\n');
          break;
      }
    }
  }
}

agent().catch(console.error);
`;
  writeIfNotExists(join(projectDir, 'src', 'agent.ts'), agentFile);

  // Tools for the agent
  const toolFile = `import type { ToolResult } from 'smallchat';

export async function searchDocuments(args: { query: string; limit?: number }): Promise<ToolResult> {
  const limit = args.limit ?? 10;
  return {
    content: {
      query: args.query,
      results: [],
      message: \`Searched for "\${args.query}" (limit: \${limit}). No documents indexed yet.\`,
    },
  };
}

export async function sendNotification(args: { channel: string; message: string }): Promise<ToolResult> {
  return {
    content: \`Notification sent to \${args.channel}: \${args.message}\`,
  };
}
`;
  writeIfNotExists(join(projectDir, 'tools', 'agent-tools.ts'), toolFile);
}

// ---------------------------------------------------------------------------
// Config generators
// ---------------------------------------------------------------------------

function generatePackageJson(name: string, template: string): object {
  const base: Record<string, unknown> = {
    name,
    version: '0.1.0',
    type: 'module',
    scripts: {
      build: 'tsc',
      compile: 'smallchat compile --source ./manifests',
      dev: 'tsc --watch',
    },
    dependencies: {
      smallchat: '^0.1.0',
    },
    devDependencies: {
      '@types/node': '^22.0.0',
      typescript: '^5.7.0',
    },
  };

  if (template === 'mcp-server') {
    (base.scripts as Record<string, string>).start = 'node dist/server.js';
    (base.scripts as Record<string, string>).serve = 'smallchat serve --source ./manifests';
  }

  if (template === 'agent') {
    (base.scripts as Record<string, string>).start = 'node dist/agent.js';
  }

  return base;
}

function generateTsconfig(): object {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      lib: ['ES2022'],
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      declaration: true,
      sourceMap: true,
      skipLibCheck: true,
    },
    include: ['src/**/*', 'tools/**/*'],
    exclude: ['node_modules', 'dist'],
  };
}

function generateConfig(template: string): object {
  return {
    $schema: 'https://smallchat.dev/schema/config.json',
    version: '0.1.0',
    embedder: 'local',
    manifests: ['./manifests'],
    output: 'tools.toolkit.json',
    template,
  };
}

function generateSampleManifest(projectName: string): object {
  return {
    id: projectName,
    name: projectName,
    transportType: 'local',
    tools: [
      {
        name: 'greet',
        description: 'Greet a user by name with an optional custom greeting',
        providerId: projectName,
        transportType: 'local',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The name of the person to greet',
            },
            greeting: {
              type: 'string',
              description: 'Optional custom greeting (defaults to "Hello")',
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'echo',
        description: 'Echo back the provided message',
        providerId: projectName,
        transportType: 'local',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to echo back',
            },
          },
          required: ['message'],
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function writeIfNotExists(filePath: string, content: string): void {
  if (existsSync(filePath)) {
    console.log(`  Skipped ${filePath.split('/').pop()} (already exists)`);
    return;
  }
  writeFileSync(filePath, content);
  console.log(`  Created ${filePath.split('/').pop()}`);
}

const GITIGNORE_CONTENT = `node_modules/
dist/
*.toolkit
*.toolkit.json
.env
.DS_Store
coverage/
smallchat.db
smallchat.db-wal
smallchat.db-shm
`;
