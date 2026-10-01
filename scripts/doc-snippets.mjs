/**
 * TypeScript code blocks in the documentation that import @smallchat/*.
 *
 * `extractSnippets()` finds them; `checkSnippets()` typechecks them as
 * modules against whatever @smallchat/* packages resolve from a directory
 * (scripts/pack-smoke.mjs runs it against the packed package), so a doc page
 * cannot keep calling an API that no longer exists. Snippets are fragments:
 * names they use without declaring (a `runtime` from an earlier block, a
 * placeholder like `githubSearchImp`) and relative imports are allowed, and
 * a few common names are declared with their real types (SNIPPET_PRELUDE).
 * Every other diagnostic is an error.
 *
 * Not checked: the historical 0.1 → 0.2 part of MIGRATION.md and the blog,
 * which show the API of the release they describe.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const HISTORICAL_MIGRATION = '# Migration Guide: 0.1.0 → 0.2.0';

/** Markdown files whose snippets describe the current API. */
export function documentationFiles(root) {
  const files = ['README.md', 'QUICKSTART.md', 'ARCHITECTURE.md', 'MIGRATION.md', 'docs/REFERENCE.md'];
  const walk = (dir) => {
    if (!existsSync(join(root, dir))) return;
    for (const entry of readdirSync(join(root, dir))) {
      const path = join(dir, entry);
      if (entry === 'node_modules' || entry === 'build') continue;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (/\.mdx?$/.test(entry)) files.push(path);
    }
  };
  walk('packages/docs/docs');
  walk('examples');
  return files.filter((f) => existsSync(join(root, f)));
}

/** `{ file, line, lang, code }` for every ts/typescript/tsx block importing @smallchat/*. */
export function extractSnippets(root) {
  const snippets = [];
  for (const file of documentationFiles(root)) {
    let text = readFileSync(join(root, file), 'utf-8');
    if (file === 'MIGRATION.md' && text.includes(HISTORICAL_MIGRATION)) text = text.slice(0, text.indexOf(HISTORICAL_MIGRATION));
    const lines = text.split('\n');
    let open = null;
    lines.forEach((line, i) => {
      const fence = line.match(/^\s*```(\w*)/);
      if (!open && fence) {
        open = { lang: fence[1], start: i + 2, body: [] };
        return;
      }
      if (open && /^\s*```\s*$/.test(line)) {
        const code = open.body.join('\n');
        if (/^(ts|typescript|tsx)$/.test(open.lang) && /from ['"]@smallchat\//.test(code)) {
          snippets.push({ file: relative(root, join(root, file)), line: open.start, lang: open.lang === 'tsx' ? 'tsx' : 'ts', code });
        }
        open = null;
        return;
      }
      if (open) open.body.push(line);
    });
  }
  return snippets;
}

/** Declarations of names many snippets use without declaring them. */
export const SNIPPET_PRELUDE = [
  "declare const runtime: import('@smallchat/core').ToolRuntime;",
  "declare const embedder: import('@smallchat/core').Embedder;",
  "declare const vectorIndex: import('@smallchat/core').VectorIndex;",
  "declare const manifests: import('@smallchat/core').ProviderManifest[];",
  'declare const args: Record<string, unknown>;',
  '',
].join('\n');

/** Diagnostics a fragment may have: undeclared names and relative imports. */
const FRAGMENT_CODES = new Set([2304, 2552, 2582]);

/**
 * Typecheck snippet files (`files`, prelude included) in `dir`, whose
 * node_modules provide @smallchat/* and @types. `paths` maps package names
 * to declaration files that are not installed there. Returns the
 * `{ fileName, line, message }` of every diagnostic that is not a
 * fragment's (line is 1-based in the snippet file).
 */
export function checkSnippets(ts, dir, files, paths = {}) {
  const program = ts.createProgram(files, {
    paths,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noImplicitAny: false,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [join(dir, 'node_modules', '@types')],
  });
  const errors = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (FRAGMENT_CODES.has(d.code)) continue;
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.code === 2307 && /Cannot find module '\.{1,2}\//.test(message)) continue;
    const line = d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0;
    errors.push({ fileName: d.file?.fileName ?? '(program)', line, message: `TS${d.code}: ${message}` });
  }
  return errors;
}
