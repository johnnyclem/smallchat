#!/usr/bin/env node
/**
 * Published-package smoke test: pack @smallchat/core as npm would publish it,
 * install the tarball into an empty project, and load it there.
 *
 * @shorthand/core is a registry dependency (^1.0.0, published from the
 * short-hand repository). Until that version is on npm, the tarball of the
 * shorthand/ workspace (an exact mirror of that release, see
 * scripts/sync-shorthand.mjs) is installed next to it to satisfy the range;
 * nothing from this repository's source tree is visible to the installed
 * package. Run after `npm run build`.
 *
 * Checks: the tarball holds dist/, the CLI and spec/ and nothing from the
 * workspace (shorthand/, src/); its package.json has no file:, link: or
 * workspace: dependency; `import('@smallchat/core')` and every subpath
 * export load, and a Node16 TypeScript consumer resolves each subpath's
 * declarations; `smallchat --version` prints the package version. The
 * packed @smallchat/react (run `npm run build:packages` first) typechecks
 * against React 19's types with skipLibCheck off.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const work = mkdtempSync(join(tmpdir(), 'smallchat-pack-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  console.error(`pack-smoke: ${message}`);
  process.exitCode = 1;
}

try {
  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies })) {
    if (/^(file|link|workspace|git\+|github):/.test(spec)) fail(`dependency ${name} uses a non-registry spec "${spec}"`);
  }

  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf-8' }));
  const files = new Set(packed.files.map(f => f.path));
  for (const required of ['package.json', 'dist/index.js', 'dist/cli/index.js', 'spec/call-digest/vectors.json', 'LICENSE']) {
    if (!files.has(required)) fail(`the tarball is missing ${required}`);
  }
  for (const path of files) {
    if (/^(shorthand|src|packages|node_modules)\//.test(path)) fail(`the tarball contains workspace file ${path}`);
    // A module removed from src/ must not ship from a stale dist/.
    const source = path.match(/^dist\/(.+)\.(?:js|d\.ts)$/)?.[1];
    if (source && !existsSync(join(ROOT, 'src', `${source}.ts`)) && !existsSync(join(ROOT, 'src', `${source}.tsx`))) {
      fail(`the tarball contains ${path}, built from a source file that no longer exists (stale dist/)`);
    }
  }

  const shorthand = JSON.parse(execFileSync(npm, ['pack', '--json', '--workspace', 'shorthand', '--pack-destination', work], { cwd: ROOT, encoding: 'utf-8' }));

  const app = join(work, 'app');
  execFileSync('mkdir', ['-p', app]);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pack-smoke', version: '0.0.0', private: true, type: 'module' }));
  // PACK_SMOKE_IGNORE_SCRIPTS=1 skips dependency install scripts (onnxruntime-node
  // downloads its binaries) where the network is restricted; loading still works.
  const ignoreScripts = process.env.PACK_SMOKE_IGNORE_SCRIPTS === '1' ? ['--ignore-scripts'] : [];
  execFileSync(npm, ['install', '--no-audit', '--no-fund', ...ignoreScripts, join(work, packed.filename), join(work, shorthand[0].filename)], { cwd: app, stdio: 'inherit' });

  const subpaths = Object.keys(pkg.exports).map(k => (k === '.' ? pkg.name : `${pkg.name}/${k.slice(2)}`));
  const probe = `for (const s of ${JSON.stringify(subpaths)}) { const m = await import(s); if (Object.keys(m).length === 0) throw new Error(s + ' exports nothing'); } const core = await import('${pkg.name}'); if (core.PACKAGE_VERSION !== '${pkg.version}') throw new Error('PACKAGE_VERSION ' + core.PACKAGE_VERSION);`;
  execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: app, stdio: 'inherit' });

  // Every subpath also resolves its declarations for a Node16 TypeScript consumer.
  writeFileSync(join(app, 'consumer.ts'), subpaths.map((s, i) => `import * as m${i} from '${s}';\nvoid m${i};`).join('\n') + '\n');
  writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'Node16', moduleResolution: 'Node16', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, types: [] },
    files: ['consumer.ts'],
  }));
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', app], { cwd: app, stdio: 'inherit' });

  // @smallchat/react's declarations against the current React types, with
  // skipLibCheck off: @types/react 19 has no global JSX namespace, so a d.ts
  // naming JSX.Element fails to compile in a React 19 project.
  const react = JSON.parse(execFileSync(npm, ['pack', '--json', '--workspace', 'packages/react', '--pack-destination', work], { cwd: ROOT, encoding: 'utf-8' }));
  execFileSync(npm, ['install', '--no-audit', '--no-fund', ...ignoreScripts, join(work, react[0].filename), 'react@19', '@types/react@19', '@types/node@22'], { cwd: app, stdio: 'inherit' });
  writeFileSync(join(app, 'react-consumer.ts'), [
    `import { createElement, createRef } from 'react';`,
    `import { AppView, useToolDispatch, type AppViewHandle } from '@smallchat/react';`,
    `const ref = createRef<AppViewHandle>();`,
    `void createElement(AppView, { componentUri: 'ui://demo/view', html: '<p></p>', ref });`,
    `void useToolDispatch;`,
  ].join('\n') + '\n');
  writeFileSync(join(app, 'tsconfig.react.json'), JSON.stringify({
    compilerOptions: { module: 'Node16', moduleResolution: 'Node16', target: 'ES2022', lib: ['ES2022', 'DOM'], strict: true, noEmit: true, skipLibCheck: false, types: ['node'] },
    files: ['react-consumer.ts'],
  }));
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(app, 'tsconfig.react.json')], { cwd: app, stdio: 'inherit' });

  const version = execFileSync(process.execPath, [join(app, 'node_modules', '.bin', 'smallchat'), '--version'], { cwd: app, encoding: 'utf-8' }).trim();
  if (version !== pkg.version) fail(`smallchat --version printed ${version}, expected ${pkg.version}`);

  if (!process.exitCode) console.log(`pack-smoke: ${packed.filename} (${packed.files.length} files) installs and loads`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
