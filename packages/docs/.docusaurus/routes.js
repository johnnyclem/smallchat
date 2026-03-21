import React from 'react';
import ComponentCreator from '@docusaurus/ComponentCreator';

export default [
  {
    path: '/__docusaurus/debug',
    component: ComponentCreator('/__docusaurus/debug', '5ff'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/config',
    component: ComponentCreator('/__docusaurus/debug/config', '5ba'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/content',
    component: ComponentCreator('/__docusaurus/debug/content', 'a2b'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/globalData',
    component: ComponentCreator('/__docusaurus/debug/globalData', 'c3c'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/metadata',
    component: ComponentCreator('/__docusaurus/debug/metadata', '156'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/registry',
    component: ComponentCreator('/__docusaurus/debug/registry', '88c'),
    exact: true
  },
  {
    path: '/__docusaurus/debug/routes',
    component: ComponentCreator('/__docusaurus/debug/routes', '000'),
    exact: true
  },
  {
    path: '/docs',
    component: ComponentCreator('/docs', '0ce'),
    routes: [
      {
        path: '/docs',
        component: ComponentCreator('/docs', '169'),
        routes: [
          {
            path: '/docs',
            component: ComponentCreator('/docs', 'f04'),
            routes: [
              {
                path: '/docs/api/compiler',
                component: ComponentCreator('/docs/api/compiler', 'd76'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api/dispatch',
                component: ComponentCreator('/docs/api/dispatch', 'ba6'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api/mcp-server',
                component: ComponentCreator('/docs/api/mcp-server', '7da'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/api/runtime',
                component: ComponentCreator('/docs/api/runtime', 'f1d'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/architecture',
                component: ComponentCreator('/docs/architecture', '38d'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli/',
                component: ComponentCreator('/docs/cli/', '8b4'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli/compile',
                component: ComponentCreator('/docs/cli/compile', '995'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli/inspect',
                component: ComponentCreator('/docs/cli/inspect', 'ce2'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli/resolve',
                component: ComponentCreator('/docs/cli/resolve', '8b7'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/cli/serve',
                component: ComponentCreator('/docs/cli/serve', 'eac'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/',
                component: ComponentCreator('/docs/concepts/', '6a4'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/dispatch',
                component: ComponentCreator('/docs/concepts/dispatch', '5da'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/overloading',
                component: ComponentCreator('/docs/concepts/overloading', '2a8'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/resolution-cache',
                component: ComponentCreator('/docs/concepts/resolution-cache', 'ec1'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/sc-object',
                component: ComponentCreator('/docs/concepts/sc-object', 'e51'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/selector-table',
                component: ComponentCreator('/docs/concepts/selector-table', 'd70'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/streaming',
                component: ComponentCreator('/docs/concepts/streaming', '3b5'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/swizzling',
                component: ComponentCreator('/docs/concepts/swizzling', 'd4a'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/concepts/tool-class',
                component: ComponentCreator('/docs/concepts/tool-class', '4f4'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/getting-started',
                component: ComponentCreator('/docs/getting-started', '565'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/intro',
                component: ComponentCreator('/docs/intro', 'a6e'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/manifests/examples',
                component: ComponentCreator('/docs/manifests/examples', '7ab'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/manifests/format',
                component: ComponentCreator('/docs/manifests/format', '945'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/what-it-does',
                component: ComponentCreator('/docs/what-it-does', '49c'),
                exact: true,
                sidebar: "docs"
              },
              {
                path: '/docs/why-it-matters',
                component: ComponentCreator('/docs/why-it-matters', '854'),
                exact: true,
                sidebar: "docs"
              }
            ]
          }
        ]
      }
    ]
  },
  {
    path: '/',
    component: ComponentCreator('/', 'e5f'),
    exact: true
  },
  {
    path: '*',
    component: ComponentCreator('*'),
  },
];
