#!/usr/bin/env node
/**
 * shorthand/ is a mirror of @shorthand/core from the short-hand repository,
 * never a fork. This script writes it, and checks it.
 *
 *   node scripts/sync-shorthand.mjs ../short-hand
 *   SHORTHAND_DIR=../short-hand npm run sync:shorthand
 *   npm run check:shorthand            (verify shorthand/ against shorthand/SOURCE)
 *   node scripts/sync-shorthand.mjs --check ../short-hand
 *                                      (also verify it is the checkout's current tree)
 *
 * Sync replaces shorthand/ with the checkout's src/ and test/ trees,
 * tsconfig.json, vitest.config.ts and LICENSE, copied byte for byte. It
 * writes shorthand/package.json from the checkout's package.json (identity,
 * exports, dependencies, devDependencies and the build/test scripts) with
 * three local changes: `private: true`, a `prepare` script that builds dist/
 * on `npm ci`, and a description that says it is a mirror. It writes a
 * README pointer and records the checkout's commit and every file's sha256
 * in shorthand/SOURCE. Check mode (also run by src/shorthand-mirror.test.ts
 * and CI) fails when any file under shorthand/ is missing, added or differs
 * from SOURCE, so the mirror only ever changes by re-running this script.
 *
 * @smallchat/core itself depends on "@shorthand/core": "^1.0.0" from the
 * registry; the workspace link to this mirror is for development only.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DEFAULT_MIRROR = join(REPO, 'shorthand');

/** Copied verbatim from the short-hand checkout. */
const MIRRORED_TREES = ['src', 'test'];
const MIRRORED_FILES = ['tsconfig.json', 'vitest.config.ts', 'LICENSE'];
/** package.json fields taken from the checkout as they are. */
const MIRRORED_FIELDS = [
  'name', 'version', 'type', 'main', 'types', 'exports', 'files', 'sideEffects', 'engines',
  'dependencies', 'devDependencies', 'keywords', 'author', 'license', 'repository', 'bugs', 'homepage',
];
/** Scripts that only need what the mirror contains. */
const MIRRORED_SCRIPTS = ['clean', 'build', 'test', 'test:watch', 'lint'];
/** Never part of the mirror's recorded contents. */
const IGNORED_TOP_LEVEL = new Set(['node_modules', 'dist', 'SOURCE']);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(root, dir = root) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    const rel = relative(root, path).split(sep).join('/');
    if (dir === root && IGNORED_TOP_LEVEL.has(e.name)) return [];
    if (e.isDirectory()) return walk(root, path);
    return [rel];
  });
}

/** git output in the short-hand checkout, or null when git can't answer. */
function git(checkout, ...args) {
  try {
    // --no-optional-locks: never touch the other checkout's index
    return execFileSync('git', ['--no-optional-locks', '-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function assertCheckout(checkout) {
  const pkgPath = join(checkout, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`${checkout} has no package.json: is it a short-hand checkout?`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.name !== '@shorthand/core') throw new Error(`${pkgPath} is ${pkg.name}, not @shorthand/core`);
  for (const tree of MIRRORED_TREES) {
    if (!existsSync(join(checkout, tree))) throw new Error(`${checkout} has no ${tree}/`);
  }
  return pkg;
}

/** The mirror's package.json, derived from the checkout's. */
export function mirrorPackageJson(upstream, commit) {
  const out = {};
  for (const field of ['name', 'version']) out[field] = upstream[field];
  out.private = true;
  out.description =
    `Mirror of @shorthand/core ${upstream.version} from the short-hand repository (commit ${commit.slice(0, 12)}), ` +
    'written by scripts/sync-shorthand.mjs. Development only; never published from here. See README.md and SOURCE.';
  for (const field of MIRRORED_FIELDS) {
    if (field in upstream && !(field in out)) out[field] = upstream[field];
  }
  out.scripts = { prepare: 'npm run build' };
  for (const name of MIRRORED_SCRIPTS) {
    if (upstream.scripts?.[name]) out.scripts[name] = upstream.scripts[name];
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

function readmeText(version, commit, dirty) {
  return [
    '# shorthand/ — mirror of `@shorthand/core`',
    '',
    `This directory is an exact copy of \`@shorthand/core\` ${version} from the`,
    '[short-hand](https://github.com/johnnyclem/short-hand) repository',
    `(commit \`${commit}\`${dirty === 'yes' ? ', with uncommitted changes' : ''}), written by`,
    '`scripts/sync-shorthand.mjs`. It is not a fork: do not edit it. Change',
    'short-hand, then run `SHORTHAND_DIR=../short-hand npm run sync:shorthand`.',
    '`npm run check:shorthand` (and `src/shorthand-mirror.test.ts`, in CI) fails',
    'when anything here differs from what `SOURCE` records.',
    '',
    '`@smallchat/core` depends on `"@shorthand/core": "^1.0.0"` from the npm',
    'registry. This mirror is the npm workspace that satisfies that range during',
    'development, so the repository builds and tests offline against the exact',
    'release it depends on. It is `private`; an installed `@smallchat/core`',
    'never sees it (`npm run test:pack` checks the packed tarball).',
    '',
    'The ONNX embedding module is not part of `@shorthand/core`: smallchat\'s',
    '`src/embedding` is its only copy.',
    '',
    'Documentation, CHANGELOG and MIGRATION live in the short-hand repository.',
    '',
  ].join('\n');
}

/** Replace the mirror with the checkout's tree and record it in SOURCE. */
export function syncMirror(checkout, mirror = DEFAULT_MIRROR) {
  checkout = resolve(checkout);
  const upstream = assertCheckout(checkout);
  const commit = git(checkout, 'rev-parse', 'HEAD') ?? 'unknown';
  const status = git(checkout, 'status', '--porcelain', '--', ...MIRRORED_TREES, ...MIRRORED_FILES, 'package.json');
  const dirty = status === null ? 'unknown' : status.length > 0 ? 'yes' : 'no';

  // Keep the installed state (node_modules/, dist/); replace everything else.
  mkdirSync(mirror, { recursive: true });
  for (const entry of readdirSync(mirror)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    rmSync(join(mirror, entry), { recursive: true, force: true });
  }
  for (const tree of MIRRORED_TREES) cpSync(join(checkout, tree), join(mirror, tree), { recursive: true });
  for (const file of MIRRORED_FILES) {
    if (existsSync(join(checkout, file))) cpSync(join(checkout, file), join(mirror, file));
  }
  writeFileSync(join(mirror, 'package.json'), mirrorPackageJson(upstream, commit));
  writeFileSync(join(mirror, 'README.md'), readmeText(upstream.version, commit, dirty));
  writeFileSync(join(mirror, '.gitignore'), 'node_modules/\ndist/\n*.tsbuildinfo\n');

  const files = walk(mirror).sort();
  writeFileSync(
    join(mirror, 'SOURCE'),
    [
      '# Written by scripts/sync-shorthand.mjs. Do not edit files under shorthand/ by hand: re-run the script.',
      'repository: https://github.com/johnnyclem/short-hand',
      `package: ${upstream.name}@${upstream.version}`,
      `commit: ${commit}`,
      `uncommitted-changes: ${dirty}`,
      'files:',
      ...files.map((f) => `  ${sha256(readFileSync(join(mirror, f)))}  ${f}`),
      '',
    ].join('\n'),
  );
  return { commit, dirty, version: upstream.version, files };
}

/** Parse shorthand/SOURCE. */
export function readSource(mirror = DEFAULT_MIRROR) {
  const path = join(mirror, 'SOURCE');
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const field = (name) => text.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1] ?? null;
  const files = new Map();
  for (const m of text.matchAll(/^ {2}([0-9a-f]{64}) {2}(.+)$/gm)) files.set(m[2], m[1]);
  return { commit: field('commit'), pkg: field('package'), dirty: field('uncommitted-changes'), files };
}

/**
 * Differences between the mirror and SOURCE (and, given a checkout, between
 * the mirror and what syncing that checkout would write). Empty when clean.
 */
export function checkMirror(mirror = DEFAULT_MIRROR, checkout) {
  const problems = [];
  const source = readSource(mirror);
  if (!source) return [`${relative(REPO, mirror) || mirror}/SOURCE is missing: run scripts/sync-shorthand.mjs`];
  if (source.files.size === 0) problems.push('SOURCE lists no files');
  const present = new Set(walk(mirror));
  for (const [file, expected] of source.files) {
    if (!present.has(file)) {
      problems.push(`missing: ${file}`);
      continue;
    }
    const actual = sha256(readFileSync(join(mirror, file)));
    if (actual !== expected) problems.push(`changed: ${file}`);
  }
  for (const file of present) {
    if (!source.files.has(file)) problems.push(`not in SOURCE: ${file}`);
  }

  if (checkout) {
    checkout = resolve(checkout);
    const upstream = assertCheckout(checkout);
    const commit = git(checkout, 'rev-parse', 'HEAD');
    if (commit && source.commit !== commit) problems.push(`SOURCE records commit ${source.commit}, ${checkout} is at ${commit}`);
    const expected = new Map();
    for (const tree of MIRRORED_TREES) {
      for (const f of walk(join(checkout, tree))) expected.set(`${tree}/${f}`, sha256(readFileSync(join(checkout, tree, f))));
    }
    for (const file of MIRRORED_FILES) {
      if (existsSync(join(checkout, file))) expected.set(file, sha256(readFileSync(join(checkout, file))));
    }
    expected.set('package.json', sha256(mirrorPackageJson(upstream, commit ?? source.commit ?? 'unknown')));
    for (const [file, hash] of expected) {
      if (source.files.get(file) !== hash) problems.push(`differs from ${checkout}: ${file}`);
    }
    for (const file of source.files.keys()) {
      const local = file === 'README.md' || file === '.gitignore';
      if (!local && !expected.has(file)) problems.push(`not in ${checkout}: ${file}`);
    }
  }
  return problems;
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  const mirrorAt = args.indexOf('--mirror');
  const mirror = mirrorAt >= 0 ? resolve(args[mirrorAt + 1]) : DEFAULT_MIRROR;
  const positional = args.filter((a, i) => !a.startsWith('--') && (mirrorAt < 0 || i !== mirrorAt + 1));
  const checkout = positional[0] ?? process.env.SHORTHAND_DIR;

  if (check) {
    const problems = checkMirror(mirror, checkout);
    if (problems.length > 0) {
      console.error(`shorthand/ is not the mirror SOURCE records (re-run scripts/sync-shorthand.mjs):\n  ${problems.join('\n  ')}`);
      return 1;
    }
    const source = readSource(mirror);
    console.log(`shorthand/ matches SOURCE: ${source.pkg} at ${source.commit} (${source.files.size} files)`);
    return 0;
  }

  if (!checkout) {
    console.error('usage: node scripts/sync-shorthand.mjs <short-hand checkout>  (or set SHORTHAND_DIR)\n       node scripts/sync-shorthand.mjs --check [<short-hand checkout>]');
    return 2;
  }
  const { commit, dirty, version, files } = syncMirror(checkout, mirror);
  console.log(`mirrored @shorthand/core ${version} (commit ${commit}${dirty === 'yes' ? ', with uncommitted changes' : ''}): ${files.length} files in ${relative(REPO, mirror) || mirror}`);
  console.log('Next: npm install --package-lock-only if devDependencies changed, then npm run build --workspace=shorthand and the tests.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv);
  } catch (err) {
    console.error(`sync-shorthand: ${err.message}`);
    process.exitCode = 1;
  }
}
