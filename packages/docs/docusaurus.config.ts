import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'smallchat',
  tagline: 'object oriented inference',
  favicon: 'img/favicon.ico',

  url: 'https://smallchat.dev',
  baseUrl: '/',

  organizationName: 'johnnyclem',
  projectName: 'smallchat',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/johnnyclem/smallchat/tree/main/packages/docs/',
        },
        blog: {
          path: 'blog',
          routeBasePath: 'blog',
          showReadingTime: true,
          blogTitle: 'smallchat blog',
          blogDescription: 'Releases, design notes, and integration deep dives.',
          editUrl: 'https://github.com/johnnyclem/smallchat/tree/main/packages/docs/',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },

    image: 'img/smallchat-og.png',

    navbar: {
      title: 'smallchat',
      logo: {
        alt: 'smallchat logo',
        src: 'img/logo.svg',
        srcDark: 'img/logo.svg',
      },
      style: 'dark',
      items: [
        {
          to: '/docs/what-it-does',
          label: 'What it does',
          position: 'left',
        },
        {
          to: '/docs/why-it-matters',
          label: 'Why it matters',
          position: 'left',
        },
        {
          to: '/docs/concepts',
          label: 'Deep dive',
          position: 'left',
        },
        {
          to: '/docs/integrations',
          label: 'Integrations',
          position: 'left',
        },
        {
          to: '/blog',
          label: 'Blog',
          position: 'left',
        },
        {
          to: '/docs/getting-started',
          label: 'Get Started',
          position: 'right',
          className: 'navbar-cta-button',
        },
        {
          href: 'https://github.com/johnnyclem/smallchat',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },

    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Introduction', to: '/docs/intro' },
            { label: 'Getting Started', to: '/docs/getting-started' },
            { label: 'What it does', to: '/docs/what-it-does' },
            { label: 'Why it matters', to: '/docs/why-it-matters' },
          ],
        },
        {
          title: 'Deep Dive',
          items: [
            { label: 'Concepts', to: '/docs/concepts' },
            { label: 'CLI Reference', to: '/docs/cli' },
            { label: 'API Reference', to: '/docs/api/runtime' },
            { label: 'Architecture', to: '/docs/architecture' },
          ],
        },
        {
          title: 'Integrations',
          items: [
            { label: 'Overview', to: '/docs/integrations' },
            { label: 'LoomMCP', to: '/docs/integrations/loom-mcp' },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'Blog',
              to: '/blog',
            },
            {
              label: 'Source Code',
              href: 'https://github.com/johnnyclem/smallchat',
            },
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/@smallchat/core',
            },
          ],
        },
      ],
      copyright: `Built by Johnny Clem. MIT License.`,
    },

    prism: {
      theme: prismThemes.oneDark,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'json', 'typescript', 'swift'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
