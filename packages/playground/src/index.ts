import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Embedder, VectorIndex } from 'smallchat';
import { LocalEmbedder } from 'smallchat';
import { MemoryVectorIndex } from 'smallchat';
import { SelectorTable } from 'smallchat';

/**
 * Playground web server — serves a single-page UI for testing
 * smallchat tool resolution in real time.
 */

interface PlaygroundConfig {
  port: number;
  toolkitPath: string;
}

export async function startPlayground(config: PlaygroundConfig): Promise<void> {
  const { port, toolkitPath } = config;

  if (!existsSync(toolkitPath)) {
    console.error(`Toolkit file not found: ${toolkitPath}`);
    console.error('Run "smallchat compile" first to generate a toolkit artifact.');
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(toolkitPath, 'utf-8'));

  // Set up embedder and vector index
  const embedder = new LocalEmbedder();
  const vectorIndex = new MemoryVectorIndex();
  const selectorTable = new SelectorTable(vectorIndex, embedder);

  // Load selectors
  for (const [, sel] of Object.entries(data.selectors)) {
    const s = sel as { canonical: string; vector: number[] };
    selectorTable.intern(new Float32Array(s.vector), s.canonical);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PLAYGROUND_HTML);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/resolve') {
      let body = '';
      for await (const chunk of req) body += chunk;

      try {
        const { intent } = JSON.parse(body) as { intent: string };
        const selector = await selectorTable.resolve(intent);
        const matches = vectorIndex.search(selector.vector, 10, 0.3);

        const results = matches.map((m) => {
          let provider = 'unknown';
          let toolName = m.id;
          for (const [pid, table] of Object.entries(data.dispatchTables)) {
            const methods = table as Record<string, { toolName: string }>;
            if (m.id in methods) {
              provider = pid;
              toolName = methods[m.id].toolName;
              break;
            }
          }
          return {
            selector: m.id,
            distance: m.distance,
            confidence: ((1 - m.distance) * 100).toFixed(1),
            provider,
            toolName,
          };
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          intent,
          resolvedSelector: selector.canonical,
          matches: results,
          timestamp: Date.now(),
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/api/tools') {
      const tools: Array<{ provider: string; tool: string; selector: string }> = [];
      for (const [pid, table] of Object.entries(data.dispatchTables)) {
        const methods = table as Record<string, { toolName: string }>;
        for (const [sel, m] of Object.entries(methods)) {
          tools.push({ provider: pid, tool: m.toolName, selector: sel });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools, stats: data.stats }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`smallchat playground running at http://localhost:${port}`);
    console.log(`Loaded ${Object.keys(data.selectors).length} selectors\n`);
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
  <p class="subtitle">Type a natural language intent and see the resolution chain in real time.</p>
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

    intentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') resolve(); });

    fetch('/api/tools').then(r => r.json()).then(data => {
      statsDiv.innerHTML = [
        '<span>Tools: <span class="stat-value">' + data.stats.toolCount + '</span></span>',
        '<span>Selectors: <span class="stat-value">' + data.stats.uniqueSelectorCount + '</span></span>',
        '<span>Providers: <span class="stat-value">' + data.stats.providerCount + '</span></span>',
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
        resultsDiv.innerHTML = '<div class="chain" style="color:#f85149">Error: ' + data.error + '</div>';
        return;
      }

      let html = '<div class="result-header">Resolved selector: <span class="selector">' + data.resolvedSelector + '</span></div>';
      html += '<div class="chain">';

      if (data.matches.length === 0) {
        html += '<div class="chain-step">No matches found.</div>';
      }

      for (const match of data.matches) {
        const conf = parseFloat(match.confidence);
        const cls = conf > 80 ? 'high' : conf > 50 ? 'medium' : 'low';
        html += '<div class="chain-step">';
        html += '<span class="confidence ' + cls + '">' + match.confidence + '%</span>';
        html += '<span class="arrow">&rarr;</span>';
        html += '<span class="tool-name">' + match.toolName + '</span>';
        html += '<span class="provider">(' + match.provider + ')</span>';
        html += '<span class="selector">' + match.selector + '</span>';
        html += '</div>';
      }

      html += '</div>';
      html += '<div class="meta">Resolved in ' + (Date.now() - data.timestamp) + 'ms</div>';

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
