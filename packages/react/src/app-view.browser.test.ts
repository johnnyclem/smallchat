/**
 * AppView in a real browser (Chromium through playwright-core).
 *
 * The view is a real MCP Apps view: ext-apps' App connected through
 * PostMessageTransport, which sends a JSON-RPC ui/initialize request and
 * waits for the host's answer. The react-test-renderer tests in
 * index.test.tsx stub contentWindow.postMessage, so the browser's origin
 * check and DOM timing never run there. Review findings reproduced here:
 *
 * - AppView spoke a private protocol ({type: 'mcp-ui/ready'}), never
 *   answered ui/initialize, so an ext-apps view never initialized.
 * - With the default sandbox (allow-scripts, no allow-same-origin) the
 *   frame's origin is opaque ('null'), so posting to the view URL's origin
 *   delivered nothing to an http(s) view.
 * - ui/resource-teardown was posted from an effect cleanup that runs after
 *   the frame has been removed, so the view never received it.
 *
 * Skipped when playwright-core or its Chromium build is missing, unless
 * SMALLCHAT_BROWSER_TESTS=1 (CI), which makes a missing browser a failure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const require = createRequire(import.meta.url);
const SRC = fileURLToPath(new URL('.', import.meta.url));
const REQUIRED = process.env.SMALLCHAT_BROWSER_TESTS === '1';

type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  close(): Promise<void>;
};

async function launch(): Promise<{ browser: Browser | null; reason?: string }> {
  try {
    const { chromium } = require('playwright-core') as { chromium: { launch(): Promise<Browser> } };
    return { browser: await chromium.launch() };
  } catch (err) {
    return { browser: null, reason: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

const launched = await launch();
if (!launched.browser && REQUIRED) {
  throw new Error(`SMALLCHAT_BROWSER_TESTS=1 but Chromium could not be launched: ${launched.reason}`);
}

/** The host page: AppView under React, driven from the test through window globals. */
const HOST_ENTRY = `
import { createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { AppView } from './index.tsx';

const w = window;
w.calls = [];
const ref = createRef();
let root = null;
const handlers = {
  onCallTool: async (name, args) => {
    w.calls.push(['call', name, args]);
    return { content: 'echo:' + args.text };
  },
  onInteraction: (event, toolName, payload) => w.calls.push(['interaction', event, toolName, payload]),
};
w.mount = (props) => {
  root = createRoot(document.getElementById('root'));
  root.render(createElement(AppView, { ...handlers, ...props, ref }));
};
w.update = (props) => root.render(createElement(AppView, { ...handlers, ...props, ref }));
w.teardown = () => ref.current.teardown();
w.unmount = () => { root.unmount(); root = null; };
`;

/** The view: ext-apps' App, reporting everything it receives to the test server's /log. */
const VIEW_ENTRY = `
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const log = (event, data) => fetch(LOG_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify({ tag: TAG, event, data }) });
(async () => {
  const app = new App({ name: 'probe-view', version: '1.0.0' }, {});
  app.ontoolinput = (params) => log('tool-input', params);
  app.ontoolresult = (params) => log('tool-result', params);
  app.onteardown = async () => { await log('teardown'); return {}; };
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  log('connected', { origin: self.origin, host: app.getHostVersion(), displayMode: app.getHostContext()?.displayMode });
  const called = await app.callServerTool({ name: 'echo', arguments: { text: 'hi' } });
  log('call-result', called);
  await app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'hello from the view' }] });
})().catch((err) => log('error', String(err)));
`;

interface Logged { tag: string; event: string; data?: unknown }

describe.skipIf(!launched.browser)('AppView in Chromium', () => {
  const browser = launched.browser!;
  const logs: Logged[] = [];
  let server: http.Server;
  let port = 0;
  let hostBundle = '';
  let viewBundle = '';
  let page: Page;

  const viewHtml = (tag: string) =>
    `<!doctype html><meta charset="utf-8"><script>const TAG = ${JSON.stringify(tag)}; const LOG_URL = "http://127.0.0.1:${port}/log";</script><script>${viewBundle}</script>`;

  beforeAll(async () => {
    const { build } = await import('esbuild');
    const bundle = async (contents: string) => {
      const out = await build({
        stdin: { contents, resolveDir: SRC, loader: 'tsx', sourcefile: 'entry.tsx' },
        bundle: true,
        format: 'iife',
        platform: 'browser',
        jsx: 'automatic',
        write: false,
        logLevel: 'silent',
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      // Inlined into <script>: keep a literal "</script" from closing it.
      return out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
    };
    [hostBundle, viewBundle] = await Promise.all([bundle(HOST_ENTRY), bundle(VIEW_ENTRY)]);

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/log') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { logs.push(JSON.parse(body) as Logged); res.end('ok'); });
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/view.html') { res.end(viewHtml(url.searchParams.get('tag') ?? 'http')); return; }
      res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script>${hostBundle}</script>`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await browser.close();
    await new Promise((r) => server?.close(r));
  });

  async function freshPage(): Promise<Page> {
    page = await browser.newPage();
    // The host page is http://localhost:<port>; http views are served from
    // http://127.0.0.1:<port>, a different origin.
    await page.goto(`http://localhost:${port}/`);
    return page;
  }

  const of = (tag: string, event: string) => logs.filter((l) => l.tag === tag && l.event === event);
  async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
    const until = Date.now() + ms;
    while (!check()) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}; logs: ${JSON.stringify(logs)}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  const resultText = (l: Logged) => ((l.data as { content?: { text?: string }[] }).content ?? [])[0]?.text;

  for (const sandbox of [undefined, 'allow-scripts allow-same-origin']) {
    const tag = `http-${sandbox ? 'same-origin' : 'default'}`;
    it(`initializes an http(s) view (sandbox ${sandbox ?? 'default'}), delivers every tool result and answers its requests`, async () => {
      const p = await freshPage();
      const componentUri = `http://127.0.0.1:${port}/view.html?tag=${tag}`;
      await p.evaluate((props) => (window as any).mount(props), { componentUri, sandbox, toolInput: { city: 'Oslo' }, toolResult: { content: 'first' } });
      await waitFor(() => of(tag, 'tool-result').length === 1, `${tag} first tool result`);
      // Without allow-same-origin the view's origin is opaque ('null').
      const origin = sandbox ? `http://127.0.0.1:${port}` : 'null';
      expect(of(tag, 'connected')[0].data).toMatchObject({ origin, host: { name: '@smallchat/react' }, displayMode: 'inline' });
      expect(of(tag, 'tool-input')[0].data).toEqual({ arguments: { city: 'Oslo' } });

      await p.evaluate((props) => (window as any).update(props), { componentUri, sandbox, toolInput: { city: 'Oslo' }, toolResult: { content: 'second' } });
      await waitFor(() => of(tag, 'tool-result').length === 2, `${tag} second tool result`);
      expect(of(tag, 'tool-result').map(resultText)).toEqual(['first', 'second']);

      // tools/call is answered by onCallTool; ui/message reaches onInteraction.
      await waitFor(() => of(tag, 'call-result').length === 1, `${tag} call result`);
      expect(resultText(of(tag, 'call-result')[0])).toBe('echo:hi');
      await p.evaluate(async () => { for (let i = 0; i < 40 && (window as any).calls.length < 3; i++) await new Promise((r) => setTimeout(r, 25)); }, null);
      const calls = await p.evaluate(() => (window as any).calls, null);
      expect(calls).toEqual([
        ['interaction', 'tool-call', 'echo', { text: 'hi' }],
        ['call', 'echo', { text: 'hi' }],
        ['interaction', 'message', '', [{ type: 'text', text: 'hello from the view' }]],
      ]);

      // teardown() reaches the view while it is still on the page, and resolves once it answers.
      const acknowledged = await p.evaluate(() => (window as any).teardown(), null);
      expect(acknowledged).toBe(true);
      expect(of(tag, 'teardown')).toHaveLength(1);
      await p.evaluate(() => (window as any).unmount(), null);
      await p.close();
    }, 30_000);
  }

  it('renders a ui:// view from its HTML (srcdoc) and speaks the same protocol', async () => {
    const p = await freshPage();
    const html = viewHtml('srcdoc');
    await p.evaluate((props) => (window as any).mount(props), { componentUri: 'ui://demo/view', html, toolResult: { content: { temperature: 21 } } });
    await waitFor(() => of('srcdoc', 'tool-result').length === 1, 'srcdoc tool result');
    expect(of('srcdoc', 'tool-input')[0].data).toEqual({ arguments: {} });
    expect(of('srcdoc', 'tool-result')[0].data).toMatchObject({ content: [{ type: 'text', text: '{"temperature":21}' }], structuredContent: { temperature: 21 } });
    expect(await p.evaluate(() => (window as any).teardown(), null)).toBe(true);
    await p.close();
  }, 30_000);

  it('ignores JSON-RPC requests from any window but its own frame', async () => {
    const p = await freshPage();
    await p.evaluate((props) => (window as any).mount(props), { componentUri: 'ui://demo/view', html: viewHtml('own') });
    await waitFor(() => of('own', 'call-result').length === 1, 'own frame call');
    // A second, unrelated frame on the page sends the same tools/call.
    await p.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.srcdoc = `<script>parent.postMessage({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'echo', arguments: { text: 'intruder' } } }, '*');</script>`;
      document.body.appendChild(frame);
      await new Promise((r) => setTimeout(r, 300));
    }, null);
    const calls = await p.evaluate(() => (window as any).calls, null);
    expect(calls.filter((c: unknown[]) => c[0] === 'call').map((c: unknown[]) => (c[2] as { text: string }).text)).toEqual(['hi']);
    await p.close();
  }, 30_000);
});
