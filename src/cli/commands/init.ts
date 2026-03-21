import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Sample manifests bundled into the scaffolded project
// ---------------------------------------------------------------------------

const HELLO_WORLD_MANIFEST = {
  id: 'hello-world',
  name: 'Hello World',
  transportType: 'local',
  description: 'A minimal example provider with a single greeting tool.',
  tools: [
    {
      name: 'greet',
      description: 'Greet a person by name',
      providerId: 'hello-world',
      transportType: 'local',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the person to greet' },
          language: {
            type: 'string',
            description: 'Language for the greeting (en, es, fr)',
            enum: ['en', 'es', 'fr'],
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'farewell',
      description: 'Say goodbye to a person by name',
      providerId: 'hello-world',
      transportType: 'local',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the person to bid farewell' },
        },
        required: ['name'],
      },
    },
  ],
};

const WEATHER_MANIFEST = {
  id: 'weather',
  name: 'Weather Agent',
  transportType: 'rest',
  description: 'Fetch current weather and forecasts for any location.',
  tools: [
    {
      name: 'get_current_weather',
      description: 'Get the current weather conditions for a city or coordinates',
      providerId: 'weather',
      transportType: 'rest',
      inputSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name or "lat,lon" coordinates (e.g. "London" or "51.5,-0.1")',
          },
          units: {
            type: 'string',
            description: 'Unit system for temperature',
            enum: ['metric', 'imperial', 'kelvin'],
          },
        },
        required: ['location'],
      },
    },
    {
      name: 'get_forecast',
      description: 'Get a multi-day weather forecast for a location',
      providerId: 'weather',
      transportType: 'rest',
      inputSchema: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City name or "lat,lon" coordinates',
          },
          days: {
            type: 'number',
            description: 'Number of forecast days (1–7)',
          },
          units: {
            type: 'string',
            enum: ['metric', 'imperial', 'kelvin'],
          },
        },
        required: ['location'],
      },
    },
  ],
};

const ECHO_MANIFEST = {
  id: 'echo',
  name: 'Echo',
  transportType: 'local',
  description: 'Utility tools for testing: echo, reverse, and uppercase.',
  tools: [
    {
      name: 'echo',
      description: 'Return the input text unchanged — useful for testing dispatch',
      providerId: 'echo',
      transportType: 'local',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to echo back' },
        },
        required: ['text'],
      },
    },
    {
      name: 'reverse',
      description: 'Reverse a string character-by-character',
      providerId: 'echo',
      transportType: 'local',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to reverse' },
        },
        required: ['text'],
      },
    },
    {
      name: 'uppercase',
      description: 'Convert text to uppercase',
      providerId: 'echo',
      transportType: 'local',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to convert' },
        },
        required: ['text'],
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Starter SDK usage example
// ---------------------------------------------------------------------------

function makeIndexTs(projectName: string): string {
  return `import { ToolRuntime, ToolCompiler, LocalEmbedder, MemoryVectorIndex } from 'smallchat';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  // 1. Load manifests
  const manifestDir = join(import.meta.dirname, 'manifests');
  const manifests = readdirSync(manifestDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(manifestDir, f), 'utf-8')));

  // 2. Compile tool definitions
  const embedder = new LocalEmbedder();
  const vectorIndex = new MemoryVectorIndex();
  const compiler = new ToolCompiler(embedder, vectorIndex);
  const compiled = await compiler.compile(manifests);

  // 3. Boot the runtime
  const runtime = new ToolRuntime(vectorIndex, embedder);

  console.log('${projectName} runtime ready!');
  console.log(runtime.generateHeader());

  // 4. Fluent SDK dispatch
  //    runtime.dispatch("intent").withArgs({ ... }).exec()
  const result = await runtime
    .dispatch('greet someone')
    .withArgs({ name: 'World' })
    .exec();

  console.log('Result:', result);

  // 5. Streaming dispatch
  for await (const event of runtime.dispatch('get current weather').withArgs({ location: 'London' }).stream()) {
    if (event.type === 'tool-start') console.log('Resolved:', event.toolName);
    if (event.type === 'done')      console.log('Done:', event.result);
  }
}

main().catch(console.error);
`;
}

function makeReadme(projectName: string, projectDir: string): string {
  return `# ${projectName}

A [smallchat](https://github.com/johnnyclem/smallchat) project.

## Quick start

\`\`\`bash
npm install
npm run build
node dist/index.js
\`\`\`

## Compile tool manifests

\`\`\`bash
npx smallchat compile -s manifests/ -o tools.toolkit.json
\`\`\`

## Start the MCP server

\`\`\`bash
npx smallchat serve tools.toolkit.json
\`\`\`

## Project layout

\`\`\`
${projectDir}/
├── manifests/
│   ├── hello-world.json   # Greeting tools
│   ├── weather.json       # Weather agent
│   └── echo.json          # Echo/test utilities
├── src/
│   └── index.ts           # SDK usage example
└── package.json
\`\`\`

## SDK fluent interface

\`\`\`typescript
// One-shot execution
const result = await runtime.dispatch("greet someone").withArgs({ name: "Alice" }).exec();

// Streaming execution
for await (const event of runtime.dispatch("get weather").withArgs({ location: "Paris" }).stream()) {
  console.log(event);
}

// Token-level inference stream
for await (const token of runtime.dispatch("summarise").withArgs({ url }).inferStream()) {
  process.stdout.write(token);
}
\`\`\`
`;
}

function makePackageJson(projectName: string): object {
  return {
    name: projectName,
    version: '0.1.0',
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsc',
      dev: 'tsc --watch',
      start: 'node dist/index.js',
    },
    dependencies: {
      smallchat: '^0.1.0',
    },
    devDependencies: {
      typescript: '^5.7.0',
      '@types/node': '^22.0.0',
    },
    engines: {
      node: '>=20.0.0',
    },
  };
}

function makeTsConfig(): object {
  return {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ['src'],
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const initCommand = new Command('init')
  .description('Scaffold a new smallchat project with sample tool manifests')
  .argument('[project-name]', 'Name for the new project directory', 'my-smallchat-project')
  .option('--no-examples', 'Skip example manifests (create an empty manifests/ folder)')
  .action((projectName: string, options: { examples: boolean }) => {
    const projectDir = resolve(process.cwd(), projectName);

    if (existsSync(projectDir)) {
      console.error(`Error: Directory "${projectName}" already exists.`);
      console.error('  Choose a different name or remove the existing directory first.');
      process.exit(1);
    }

    console.log(`Scaffolding "${projectName}"...`);

    // Create directory tree
    const manifestsDir = join(projectDir, 'manifests');
    const srcDir = join(projectDir, 'src');

    mkdirSync(manifestsDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });

    // Write sample manifests
    if (options.examples) {
      writeFileSync(
        join(manifestsDir, 'hello-world.json'),
        JSON.stringify(HELLO_WORLD_MANIFEST, null, 2),
      );
      writeFileSync(
        join(manifestsDir, 'weather.json'),
        JSON.stringify(WEATHER_MANIFEST, null, 2),
      );
      writeFileSync(
        join(manifestsDir, 'echo.json'),
        JSON.stringify(ECHO_MANIFEST, null, 2),
      );
      console.log('  Created manifests/hello-world.json');
      console.log('  Created manifests/weather.json');
      console.log('  Created manifests/echo.json');
    }

    // Write starter source file
    writeFileSync(join(srcDir, 'index.ts'), makeIndexTs(projectName));
    console.log('  Created src/index.ts');

    // Write project files
    writeFileSync(
      join(projectDir, 'package.json'),
      JSON.stringify(makePackageJson(projectName), null, 2),
    );
    console.log('  Created package.json');

    writeFileSync(
      join(projectDir, 'tsconfig.json'),
      JSON.stringify(makeTsConfig(), null, 2),
    );
    console.log('  Created tsconfig.json');

    writeFileSync(join(projectDir, 'README.md'), makeReadme(projectName, projectName));
    console.log('  Created README.md');

    // Success message
    const totalTools = options.examples
      ? HELLO_WORLD_MANIFEST.tools.length +
        WEATHER_MANIFEST.tools.length +
        ECHO_MANIFEST.tools.length
      : 0;

    console.log(`\nCreated ${projectName}/`);
    if (options.examples) {
      console.log(`  ${totalTools} sample tools across 3 manifests`);
    }

    console.log(`\nNext steps:\n`);
    console.log(`  cd ${projectName}`);
    console.log(`  npm install`);
    console.log(`  npx smallchat compile -s manifests/ -o tools.toolkit.json`);
    console.log(`  npx smallchat serve tools.toolkit.json`);
    console.log('');
    console.log('Run "smallchat --help" for a full list of commands.');
  });
