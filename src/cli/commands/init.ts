import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packageVersion } from '../package-info.js';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const initCommand = new Command('init')
  .description('Scaffold a new smallchat project with sample tools and configuration')
  .argument('[directory]', 'Directory to initialize (defaults to current directory)')
  .option('-t, --template <type>', 'Project template: basic, mcp-server, agent', 'basic')
  .option('--no-git', 'Skip git initialization (git init, unless already inside a repository)')
  .option('--no-install', 'Skip npm install')
  .action(async (directory, options) => {
    const projectDir = resolve(directory ?? '.');
    const projectName = projectDir.split('/').pop() ?? 'my-smallchat-project';
    const template = options.template as 'basic' | 'mcp-server' | 'agent';

    console.log(`\nInitializing smallchat project in ${projectDir}...\n`);

    // Create directory structure
    const dirs = [
      '',
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

    // Write smallchat.json project manifest (the package.json analog)
    writeIfNotExists(join(projectDir, 'smallchat.json'), JSON.stringify(generateSmallChatJson(projectName, template), null, 2));

    // The sample tools' implementations; manifests/ declares them ('local' transport)
    writeIfNotExists(join(projectDir, 'src', 'tools.ts'), SAMPLE_TOOLS);

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

    if (options.git !== false) {
      await initGitRepository(projectDir);
    }
    let installed = false;
    if (options.install !== false) {
      installed = await installDependencies(projectDir);
    }

    console.log('\nNext steps:');
    console.log(`  cd ${directory ?? '.'}`);
    if (!installed) {
      console.log('  npm install');
    }
    // `npm run` uses the locally installed smallchat bin; never the unscoped
    // `smallchat` name through npx, which would fetch an unrelated
    // (unregistered) package.
    console.log('  npm run compile        # smallchat compile --source ./manifests');
    if (template === 'mcp-server') {
      console.log('  npm run build          # then point your MCP host at: node dist/server.js');
    } else {
      console.log('  npm run build && npm start');
    }
    console.log('');
    console.log(`Template: ${template}`);
    console.log('Run "npm run doctor" to verify your setup.\n');
  });

// ---------------------------------------------------------------------------
// git / npm
// ---------------------------------------------------------------------------

/** Run a command; resolves with its exit code (or null if it could not start). */
function run(command: string, args: string[], cwd: string, quiet = false): Promise<number | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      stdio: quiet ? 'ignore' : 'inherit',
      // npm is a .cmd shim on Windows; the arguments here are fixed literals.
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolvePromise(null));
    child.on('close', (code) => resolvePromise(code));
  });
}

/** `git init`, unless the directory is already inside a git work tree. */
async function initGitRepository(projectDir: string): Promise<void> {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], projectDir, true);
  if (inside === null) {
    console.log('  git not found; skipped git init');
    return;
  }
  if (inside === 0) {
    console.log('  Already inside a git repository; skipped git init');
    return;
  }
  const code = await run('git', ['init', '--quiet'], projectDir, true);
  console.log(code === 0 ? '  Initialized a git repository' : '  ⚠ git init failed; run it yourself');
}

/** `npm install` in the project; false (with a warning) if it failed. */
async function installDependencies(projectDir: string): Promise<boolean> {
  console.log('  Installing dependencies (npm install)...');
  const code = await run('npm', ['install'], projectDir);
  if (code === 0) return true;
  console.log('  ⚠ npm install failed; run it yourself once the problem above is fixed');
  return false;
}

// ---------------------------------------------------------------------------
// Template generators
// ---------------------------------------------------------------------------

function generateBasicTemplate(projectDir: string): void {
  // Entry point: compile ./manifests, resolve an intent, run the chosen tool
  const entryPoint = `import { loadRuntime, registerLocalHandler } from '@smallchat/core';
import { echo, greet } from './tools.js';

// Implementations for the tools declared in manifests/ (transportType 'local').
registerLocalHandler('greet', greet);
registerLocalHandler('echo', echo);

async function main() {
  // Compiles ./manifests in-process; point it at tools.toolkit.json
  // (npm run compile) to load a compiled artifact instead.
  const { runtime, upstreams } = await loadRuntime('./manifests');
  try {
    // Resolution proposes one tool and runs nothing...
    const resolution = await runtime.resolve('greet a user by name with a custom greeting');
    console.log(\`Resolved: \${resolution.outcome} -> \${resolution.chosen ?? '(none)'} (\${resolution.tier})\`);

    // ...then exactly that tool runs, with arguments checked against its schema.
    if (resolution.chosen) {
      const result = await runtime.dispatchById(resolution.chosen, { name: 'World' });
      console.log('Result:', result.content);
    } else {
      console.log('Candidates:', resolution.candidates.map((c) => c.toolId).join(', '));
    }
  } finally {
    await upstreams.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
  writeIfNotExists(join(projectDir, 'src', 'index.ts'), entryPoint);
}

function generateMcpServerTemplate(projectDir: string): void {
  const serverFile = `import { MCPServer, registerLocalHandler } from '@smallchat/core';
import { echo, greet } from './tools.js';

// The tools in manifests/ use the 'local' transport: they run in this
// process, so their implementations are registered before serving them.
registerLocalHandler('greet', greet);
registerLocalHandler('echo', echo);

// Serves ./manifests over stdio — point your MCP host at \`node dist/server.js\`.
// Logs go to stderr: stdout is the protocol channel. (\`smallchat serve\`
// forwards calls to upstream MCP servers; it cannot run these local tools.)
const server = new MCPServer({ sourcePath: './manifests' });

// Graceful shutdown
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});

server.startStdio()
  .then(() => server.closed())
  .then(() => server.stop());
`;
  writeIfNotExists(join(projectDir, 'src', 'server.ts'), serverFile);
}

function generateAgentTemplate(projectDir: string): void {
  const agentFile = `import { existsSync } from 'node:fs';
import { loadRuntime, registerLocalHandler } from '@smallchat/core';
import { echo, greet } from './tools.js';

// Implementations for the tools declared in manifests/ (transportType 'local').
registerLocalHandler('greet', greet);
registerLocalHandler('echo', echo);

/**
 * A simple agent loop: each request is resolved to one tool, which runs and
 * streams its result. Only a HIGH-confidence match runs; anything less comes
 * back as needs-disambiguation (or unresolved) for the agent to refine.
 */
async function agent() {
  // tools.toolkit.json (npm run compile) carries smallchat.json's hints;
  // without it, ./manifests is compiled in-process.
  const source = existsSync('tools.toolkit.json') ? 'tools.toolkit.json' : './manifests';
  const { runtime, upstreams } = await loadRuntime(source);

  const requests: { intent: string; args: Record<string, unknown> }[] = [
    { intent: 'greet a user by name with a custom greeting', args: { name: 'Ada', greeting: 'Hi' } },
    { intent: 'echo back the provided message', args: { message: 'ping' } },
    { intent: 'book a flight to Lisbon', args: {} },
  ];

  try {
    for (const { intent, args } of requests) {
      console.log(\`Intent: "\${intent}"\`);
      for await (const event of runtime.dispatchStream(intent, args)) {
        switch (event.type) {
          case 'tool-start':
            console.log(\`  Tool: \${event.toolId} (confidence: \${(event.confidence * 100).toFixed(1)}%)\`);
            break;
          case 'chunk':
            console.log(\`  Result: \${JSON.stringify(event.content)}\`);
            break;
          case 'done':
            // Nothing ran: the outcome says why (unresolved, needs-disambiguation, ...).
            if (event.result.isError) {
              console.log(\`  Not run (\${String(event.result.metadata?.outcome ?? 'error')})\`);
            }
            break;
          case 'error':
            console.log(\`  Error: \${event.error}\`);
            break;
        }
      }
      console.log('');
    }
  } finally {
    await upstreams.close();
  }
}

agent().catch((err) => {
  console.error(err);
  process.exit(1);
});
`;
  writeIfNotExists(join(projectDir, 'src', 'agent.ts'), agentFile);
}

const SAMPLE_TOOLS = `import type { ToolResult } from '@smallchat/core';

/**
 * A sample greeting tool that demonstrates the basic tool structure.
 */
export async function greet(args: Record<string, unknown>): Promise<ToolResult> {
  const greeting = typeof args.greeting === 'string' ? args.greeting : 'Hello';
  return {
    content: \`\${greeting}, \${String(args.name)}! Welcome to smallchat.\`,
  };
}

/**
 * A sample echo tool that returns whatever you send it.
 */
export async function echo(args: Record<string, unknown>): Promise<ToolResult> {
  return {
    content: String(args.message),
  };
}
`;

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
      doctor: 'smallchat doctor',
      dev: 'tsc --watch',
    },
    dependencies: {
      '@smallchat/core': `^${packageVersion()}`,
    },
    devDependencies: {
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    engines: {
      node: '>=22.0.0',
    },
  };

  if (template === 'mcp-server') {
    (base.scripts as Record<string, string>).start = 'node dist/server.js';
  }

  if (template === 'agent') {
    (base.scripts as Record<string, string>).start = 'node dist/agent.js';
  }

  if (template === 'basic') {
    (base.scripts as Record<string, string>).start = 'node dist/index.js';
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
      skipLibCheck: true,
    },
    include: ['src'],
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

function generateSmallChatJson(name: string, template: string): object {
  const base: Record<string, unknown> = {
    $schema: 'https://smallchat.dev/schema/smallchat.json',
    name,
    version: '0.1.0',
    description: `A smallchat ${template} project`,
    manifests: ['./manifests'],
    compiler: {
      embedder: 'onnx',
      duplicateThreshold: 0.95,
      collisionThreshold: 0.89,
    },
    output: {
      path: 'tools.toolkit.json',
      format: 'json',
    },
  };

  if (template === 'agent') {
    // Agent template gets example hint overrides to demonstrate the feature
    base.providerHints = {
      [name]: {
        selectorHint: `Tools for the ${name} agent`,
      },
    };
    base.toolHints = {
      [`${name}.greet`]: {
        aliases: ['say hello', 'welcome user'],
      },
    };
  }

  return base;
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
