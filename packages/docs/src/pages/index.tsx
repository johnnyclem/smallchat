import React, { useEffect, useRef, useState } from 'react';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import clsx from 'clsx';

// ---------- Terminal animation ----------

const TERMINAL_LINES: Array<{ type: 'comment' | 'prompt' | 'output' | 'blank'; text?: string }> = [
  { type: 'comment', text: '# Install' },
  { type: 'prompt', text: 'npm install @smallchat/core' },
  { type: 'blank' },
  { type: 'comment', text: '# Compile tool definitions' },
  { type: 'prompt', text: 'npx @smallchat/core compile --source ./tools --output tools.json' },
  { type: 'output', text: 'Compiling tools... ✓ 3 tools from 2 providers embedded.' },
  { type: 'blank' },
  { type: 'comment', text: '# Test a natural-language dispatch' },
  { type: 'prompt', text: 'npx @smallchat/core resolve tools.json "search for code"' },
  { type: 'output', text: 'Matched: github.search_code (confidence: 0.98)' },
  { type: 'blank' },
  { type: 'comment', text: '# Spin up the built-in MCP server' },
  { type: 'prompt', text: 'npx @smallchat/core serve tools.json --port 3000' },
  { type: 'output', text: 'smallchat server running on http://localhost:3000 ✓' },
];

function TerminalWindow() {
  const [visibleLines, setVisibleLines] = useState(0);
  const [showCursor, setShowCursor] = useState(true);

  useEffect(() => {
    if (visibleLines >= TERMINAL_LINES.length) return;
    const delay = TERMINAL_LINES[visibleLines]?.type === 'blank' ? 200 : 600;
    const timer = setTimeout(() => {
      setVisibleLines((v) => v + 1);
    }, delay);
    return () => clearTimeout(timer);
  }, [visibleLines]);

  return (
    <div className="terminal-window">
      <div className="terminal-titlebar">
        <span className="terminal-dot red" />
        <span className="terminal-dot yellow" />
        <span className="terminal-dot green" />
        <span className="terminal-title">terminal</span>
      </div>
      <div className="terminal-body">
        {TERMINAL_LINES.slice(0, visibleLines).map((line, i) => {
          if (line.type === 'blank') {
            return <span key={i} className="terminal-blank" />;
          }
          if (line.type === 'comment') {
            return (
              <span key={i} className="terminal-line terminal-comment">
                {line.text}
              </span>
            );
          }
          if (line.type === 'prompt') {
            return (
              <span key={i} className="terminal-line">
                <span className="terminal-prompt">{line.text}</span>
              </span>
            );
          }
          if (line.type === 'output') {
            return (
              <span key={i} className="terminal-line terminal-output">
                {line.text}
              </span>
            );
          }
          return null;
        })}
        {visibleLines < TERMINAL_LINES.length && (
          <span className="terminal-line">
            <span className="terminal-cursor" />
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- Feature cards ----------

const FEATURES = [
  {
    icon: '⚡',
    title: 'What it does',
    desc: 'smallchat compiles tool definitions, embeds semantic fingerprints, and dispatches natural-language intent to the best-matching implementation — at runtime, with caching.',
    href: '/docs/what-it-does',
    linkLabel: 'See the dispatch model',
  },
  {
    icon: '🎯',
    title: 'Why it matters',
    desc: 'Tool proliferation is the next scaling problem. Routing by string matching breaks. Routing by semantic vector search does not. smallchat brings the Obj-C message dispatch model to LLM tooling.',
    href: '/docs/why-it-matters',
    linkLabel: 'Read the motivation',
  },
  {
    icon: '🔬',
    title: 'Deep dive',
    desc: 'SelectorTable, DispatchContext, OverloadTable, ResolutionCache, ToolClass hierarchies, method swizzling, streaming tiers, and the MCP 2025-11-25 server — all documented.',
    href: '/docs/concepts',
    linkLabel: 'Explore the internals',
  },
];

function FeatureCard({
  icon,
  title,
  desc,
  href,
  linkLabel,
}: (typeof FEATURES)[number]) {
  return (
    <div className="feature-card">
      <span className="feature-card-icon">{icon}</span>
      <div className="feature-card-title">{title}</div>
      <div className="feature-card-desc">{desc}</div>
      <Link className="feature-card-link" to={href}>
        {linkLabel} →
      </Link>
    </div>
  );
}

// ---------- Comparison table ----------

function ComparisonTable() {
  return (
    <section
      style={{
        background: '#0a0a0a',
        borderTop: '1px solid #1a1a1a',
        padding: '4rem 2rem',
      }}
    >
      <div style={{ maxWidth: 800, margin: '0 auto', textAlign: 'center' }}>
        <div className="section-eyebrow">Primitives, not a framework</div>
        <div className="section-title">Why not LangChain?</div>
        <div className="section-subtitle" style={{ marginBottom: '2rem' }}>
          smallchat gives you the dispatch layer. You build the agent. No abstractions you didn't
          ask for.
        </div>
        <table style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Concern</th>
              <th>LangChain</th>
              <th>smallchat</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Streaming</td>
              <td>CallbackManager + custom piping</td>
              <td>
                <code>for await</code> over native provider deltas
              </td>
            </tr>
            <tr>
              <td>Tool dispatch</td>
              <td>Chain/Agent hierarchy</td>
              <td>
                One <code>smallchat_dispatchStream</code> call
              </td>
            </tr>
            <tr>
              <td>Caching</td>
              <td>External wrappers</td>
              <td>Built-in resolution cache</td>
            </tr>
            <tr>
              <td>Extensibility</td>
              <td>Subclass and register</td>
              <td>
                <code>toolClass.addMethod</code> or swizzle
              </td>
            </tr>
            <tr>
              <td>Bundle size</td>
              <td>Multiple adapter packages</td>
              <td>&lt; 5 MB, zero dependencies</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- Install strip ----------

const INSTALL_COMMANDS = {
  typescript: 'npm install @smallchat/core',
  swift: '.package(url: "https://github.com/johnnyclem/smallchat-swift", from: "0.2.0")',
};

function InstallStrip() {
  const [copied, setCopied] = useState(false);
  const [lang, setLang] = useState<'typescript' | 'swift'>('typescript');
  const cmd = INSTALL_COMMANDS[lang];

  function copyCmd() {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const toggleStyle = (active: boolean): React.CSSProperties => ({
    background: active ? 'rgba(37, 99, 235, 0.15)' : 'transparent',
    border: active ? '1px solid rgba(37, 99, 235, 0.4)' : '1px solid #2a2a2a',
    borderRadius: 6,
    color: active ? '#3b82f6' : '#6b7280',
    fontFamily: 'var(--ifm-font-family-monospace)',
    fontSize: '0.8rem',
    padding: '4px 12px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    fontWeight: active ? 600 : 400,
  });

  return (
    <section
      style={{
        background: '#111111',
        borderTop: '1px solid #1a1a1a',
        borderBottom: '1px solid #1a1a1a',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: '1rem' }}>
        <span style={{ color: '#6b7280', fontSize: '0.875rem', marginRight: '0.5rem' }}>
          Get started in seconds:
        </span>
        <button onClick={() => setLang('typescript')} style={toggleStyle(lang === 'typescript')}>
          TypeScript
        </button>
        <button onClick={() => setLang('swift')} style={toggleStyle(lang === 'swift')}>
          Swift
        </button>
      </div>
      <button
        onClick={copyCmd}
        style={{
          background: '#0d1117',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          color: '#e5e5e5',
          fontFamily: 'var(--ifm-font-family-monospace)',
          fontSize: '0.875rem',
          padding: '8px 16px',
          cursor: 'pointer',
          transition: 'border-color 0.15s ease',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
        onMouseEnter={(e) =>
          (e.currentTarget.style.borderColor = '#2563EB')
        }
        onMouseLeave={(e) =>
          (e.currentTarget.style.borderColor = '#2a2a2a')
        }
      >
        <span style={{ color: '#6b7280' }}>$</span>
        {cmd}
        <span style={{ color: copied ? '#22c55e' : '#6b7280', fontSize: '0.75rem', marginLeft: 4 }}>
          {copied ? '✓ copied' : '⎘'}
        </span>
      </button>
    </section>
  );
}

// ---------- Page ----------

export default function Home(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout
      title="object oriented inference"
      description="smallchat — a message-passing tool compiler for LLM tool use. Semantic dispatch, streaming, and an MCP server in one tiny package."
    >
      {/* Hero */}
      <section className="hero-section">
        <div className="hero-badge">
          <span style={{ fontSize: '0.9em' }}>&#x25CF;</span> v0.1.0 — MCP 2025-11-25 compliant
        </div>

        <h1 className="hero-title">object oriented inference</h1>

        <p className="hero-subtitle">
          Drop it in with one command. Watch it stream in your own UI. Or spin up the built-in
          server in seconds.
        </p>

        <div className="hero-cta-group">
          <Link className="cta-primary" to="/docs/getting-started">
            Start building now
          </Link>
          <Link className="cta-secondary" to="/docs/intro">
            Read docs
          </Link>
        </div>

        <TerminalWindow />
      </section>

      {/* Install strip */}
      <InstallStrip />

      {/* Features */}
      <section className="features-section">
        <div
          style={{
            textAlign: 'center',
            marginBottom: '3rem',
          }}
        >
          <div className="section-eyebrow">What you get</div>
          <div className="section-title">The Obj-C runtime for LLM tooling</div>
          <div className="section-subtitle">
            Selectors, dispatch tables, forwarding chains, method swizzling — applied to tool
            orchestration.
          </div>
        </div>
        <div className="features-grid">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </section>

      {/* Comparison table */}
      <ComparisonTable />

      {/* Final CTA */}
      <section
        style={{
          background: '#0a0a0a',
          padding: '5rem 2rem',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            maxWidth: 520,
            margin: '0 auto',
          }}
        >
          <blockquote
            style={{
              borderLeft: 'none',
              fontStyle: 'italic',
              fontSize: '1.2rem',
              color: '#a0a0a0',
              margin: '0 auto 2.5rem',
              padding: 0,
            }}
          >
            "The big idea is messaging."
            <cite
              style={{
                display: 'block',
                fontSize: '0.875rem',
                color: '#6b7280',
                fontStyle: 'normal',
                marginTop: '0.5rem',
              }}
            >
              — Alan Kay
            </cite>
          </blockquote>
          <Link className="cta-primary" to="/docs/getting-started">
            Get started →
          </Link>
        </div>
      </section>
    </Layout>
  );
}
