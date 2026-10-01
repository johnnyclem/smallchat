import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRuntime } from '@smallchat/core';

/**
 * Playground web server — serves a single-page UI for testing smallchat
 * tool resolution in real time, through the same `runtime.resolve()` that
 * dispatch uses: outcome, tier, chosen tool id, candidates and proof digest.
 * It resolves only; nothing is executed.
 */

interface PlaygroundConfig {
  port: number;
  toolkitPath: string;
  /** Interface to listen on (default 127.0.0.1). */
  host?: string;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Build the playground server for a compiled artifact (not listening yet).
 * The artifact's embedder fingerprint decides which embedder resolves
 * intents; loading refuses a pre-1.0 artifact or an unavailable embedder.
 */
export async function createPlaygroundServer(toolkitPath: string): Promise<{ server: Server; close: () => Promise<void> }> {
  const { runtime, artifact } = await loadRuntime(toolkitPath);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PLAYGROUND_HTML);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/resolve') {
      let body = '';
      let received = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) { tooLarge = true; break; }
        body += chunk;
      }
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }

      try {
        const { intent } = JSON.parse(body) as { intent: string };
        if (typeof intent !== 'string' || intent.trim() === '') throw new Error('"intent" must be a non-empty string');
        const started = performance.now();
        const resolution = await runtime.resolve(intent);
        const elapsedMs = performance.now() - started;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          intent,
          outcome: resolution.outcome,
          tier: resolution.tier,
          chosen: resolution.chosen ?? null,
          confidence: resolution.confidence ?? null,
          reason: resolution.reason ?? null,
          candidates: resolution.candidates.map((c) => ({
            toolId: c.toolId,
            selector: c.selector,
            score: c.score,
            tier: c.tier,
            source: c.source,
            description: artifact.tools[c.toolId]?.description ?? '',
          })),
          proofDigest: resolution.proof.proofDigest,
          elapsedMs,
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tools') {
      const tools = Object.entries(artifact.tools).map(([toolId, tool]) => ({
        toolId,
        provider: tool.providerId,
        tool: tool.name,
        description: tool.description,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools, stats: artifact.stats }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const close = () => new Promise<void>((done) => {
    if (!server.listening) { done(); return; }
    server.close(() => done());
  });
  return { server, close };
}

export async function startPlayground(config: PlaygroundConfig): Promise<void> {
  const { port, toolkitPath, host = '127.0.0.1' } = config;

  if (!existsSync(toolkitPath)) {
    console.error(`Toolkit file not found: ${toolkitPath}`);
    console.error('Run "smallchat compile" first to generate a toolkit artifact.');
    process.exit(1);
  }

  const { server } = await createPlaygroundServer(toolkitPath);
  server.listen(port, host, () => {
    console.log(`smallchat playground running at http://${host}:${port}`);
  });
}

const PLAYGROUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>smallchat playground</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; }
    h1 { color: #58a6ff; margin-bottom: 0.5rem; font-size: 1.5rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    .input-row { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    input { flex: 1; padding: 0.75rem 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 1rem; font-family: inherit; }
    input:focus { outline: none; border-color: #58a6ff; }
    button { padding: 0.75rem 1.5rem; background: #238636; border: none; border-radius: 6px; color: #fff; font-size: 1rem; cursor: pointer; font-family: inherit; }
    button:hover { background: #2ea043; }
    .results { margin-top: 1rem; }
    .result-header { color: #58a6ff; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .chain { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
    .chain-step { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid #21262d; }
    .chain-step:last-child { border-bottom: none; }
    .confidence { font-weight: bold; min-width: 50px; }
    .confidence.high { color: #3fb950; }
    .confidence.medium { color: #d29922; }
    .confidence.low { color: #f85149; }
    .selector { color: #d2a8ff; }
    .provider { color: #8b949e; font-size: 0.85rem; }
    .tool-name { color: #79c0ff; }
    .meta { color: #8b949e; font-size: 0.85rem; margin-top: 0.25rem; }
    .stats { display: flex; gap: 2rem; margin-bottom: 1.5rem; color: #8b949e; }
    .stat-value { color: #58a6ff; font-weight: bold; }
    .arrow { color: #484f58; }
  </style>
</head>
<body>
  <h1>smallchat playground</h1>
  <p class="subtitle">Type a natural language intent and see how the runtime resolves it. Nothing is executed.</p>
  <div class="stats" id="stats"></div>
  <div class="input-row">
    <input id="intent" type="text" placeholder="Describe what you want to do..." autofocus />
    <button onclick="resolve()">Resolve</button>
  </div>
  <div class="results" id="results"></div>
  <script>
    const intentInput = document.getElementById('intent');
    const resultsDiv = document.getElementById('results');
    const statsDiv = document.getElementById('stats');

    // Escape any value coming from a loaded toolkit before injecting
    // it into HTML. A malicious manifest can otherwise put '<script>'
    // in a tool name and execute it in the developer's browser.
    function esc(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    intentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') resolve(); });

    fetch('/api/tools').then(r => r.json()).then(data => {
      statsDiv.innerHTML = [
        '<span>Tools: <span class="stat-value">' + esc(data.stats.toolCount) + '</span></span>',
        '<span>Selectors: <span class="stat-value">' + esc(data.stats.selectorCount) + '</span></span>',
        '<span>Providers: <span class="stat-value">' + esc(data.stats.providerCount) + '</span></span>',
      ].join('');
    });

    async function resolve() {
      const intent = intentInput.value.trim();
      if (!intent) return;

      resultsDiv.innerHTML = '<div class="chain">Resolving...</div>';

      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      });
      const data = await res.json();

      if (data.error) {
        resultsDiv.innerHTML = '<div class="chain" style="color:#f85149">Error: ' + esc(data.error) + '</div>';
        return;
      }

      let html = '<div class="result-header">Outcome: <span class="selector">' + esc(data.outcome) + '</span> (tier ' + esc(data.tier) + ')';
      if (data.chosen) html += ' &rarr; <span class="tool-name">' + esc(data.chosen) + '</span>';
      html += '</div>';
      if (data.reason) html += '<div class="meta">' + esc(data.reason) + '</div>';
      html += '<div class="chain">';

      if (data.candidates.length === 0) {
        html += '<div class="chain-step">No candidates.</div>';
      }

      for (const c of data.candidates) {
        const tier = String(c.tier).toLowerCase();
        const cls = tier === 'exact' || tier === 'high' ? 'high' : tier === 'medium' ? 'medium' : 'low';
        html += '<div class="chain-step">';
        html += '<span class="confidence ' + cls + '">' + esc((c.score * 100).toFixed(1)) + '%</span>';
        html += '<span class="arrow">&rarr;</span>';
        html += '<span class="tool-name">' + esc(c.toolId) + '</span>';
        html += '<span class="provider">' + esc(tier) + ' via ' + esc(c.selector) + '</span>';
        html += '</div>';
      }

      html += '</div>';
      html += '<div class="meta">Resolved in ' + esc(data.elapsedMs.toFixed(1)) + 'ms; proof ' + esc(String(data.proofDigest).slice(0, 12)) + '; nothing was executed</div>';

      resultsDiv.innerHTML = html;
    }
  </script>
</body>
</html>`;

// CLI entry point
if (process.argv[1]?.endsWith('playground') || process.argv[1]?.includes('playground/dist')) {
  const toolkitPath = process.argv[2] ?? 'tools.toolkit.json';
  const port = parseInt(process.argv[3] ?? '3002', 10);
  startPlayground({ port, toolkitPath: resolve(toolkitPath) });
}
