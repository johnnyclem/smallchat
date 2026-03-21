import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    'intro',
    'getting-started',
    'what-it-does',
    'why-it-matters',
    {
      type: 'category',
      label: 'Deep Dive',
      items: [
        'concepts/index',
        'concepts/selector-table',
        'concepts/dispatch',
        'concepts/tool-class',
        'concepts/resolution-cache',
        'concepts/sc-object',
        'concepts/overloading',
        'concepts/streaming',
        'concepts/swizzling',
      ],
    },
    {
      type: 'category',
      label: 'CLI Reference',
      items: ['cli/index', 'cli/compile', 'cli/inspect', 'cli/resolve', 'cli/serve'],
    },
    {
      type: 'category',
      label: 'API Reference',
      items: ['api/runtime', 'api/dispatch', 'api/compiler', 'api/mcp-server'],
    },
    {
      type: 'category',
      label: 'Manifests',
      items: ['manifests/format', 'manifests/examples'],
    },
    'architecture',
  ],
};

export default sidebars;
