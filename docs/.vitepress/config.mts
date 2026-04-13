import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CSP Analyser',
  description:
    'Generate production-ready Content Security Policy headers by crawling websites',

  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#5b7ee5' }],
    ['meta', { name: 'og:type', content: 'website' }],
    ['meta', { name: 'og:title', content: 'CSP Analyser' }],
    [
      'meta',
      {
        name: 'og:description',
        content:
          'Generate production-ready Content Security Policy headers by crawling websites',
      },
    ],
  ],

  themeConfig: {
    nav: [
      { text: 'Getting Started', link: '/getting-started/' },
      { text: 'CLI Reference', link: '/cli/' },
      { text: 'MCP Server', link: '/mcp/' },
      { text: 'Guides', link: '/guides/' },
    ],

    sidebar: {
      '/getting-started/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Installation & Setup', link: '/getting-started/' },
            { text: 'Quick Start', link: '/getting-started/quick-start' },
          ],
        },
      ],
      '/cli/': [
        {
          text: 'CLI Reference',
          items: [
            { text: 'Overview', link: '/cli/' },
            { text: 'crawl', link: '/cli/crawl' },
            { text: 'interactive', link: '/cli/interactive' },
            { text: 'generate', link: '/cli/generate' },
            { text: 'export', link: '/cli/export' },
            { text: 'diff', link: '/cli/diff' },
            { text: 'score', link: '/cli/score' },
            { text: 'permissions', link: '/cli/permissions' },
            { text: 'sessions', link: '/cli/sessions' },
            { text: 'setup', link: '/cli/setup' },
          ],
        },
      ],
      '/guides/': [
        {
          text: 'Guides',
          items: [
            { text: 'Overview', link: '/guides/' },
            { text: 'Authentication', link: '/guides/authentication' },
            { text: 'Export Formats', link: '/guides/export-formats' },
            { text: 'Strictness Levels', link: '/guides/strictness' },
            { text: 'Understanding Scores', link: '/guides/scoring' },
            { text: 'CI/CD Integration', link: '/guides/ci-integration' },
          ],
        },
      ],
      '/mcp/': [
        {
          text: 'MCP Server',
          items: [
            { text: 'Overview', link: '/mcp/' },
            { text: 'Configuration', link: '/mcp/configuration' },
            { text: 'Tools Reference', link: '/mcp/tools' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'All CLI Options', link: '/reference/options' },
            { text: 'CSP Directives', link: '/reference/csp-directives' },
            { text: 'Troubleshooting', link: '/reference/troubleshooting' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/MakerXStudio/CSPAnalyser' },
    ],

    editLink: {
      pattern:
        'https://github.com/MakerXStudio/CSPAnalyser/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    search: {
      provider: 'local',
      options: {
        detailedView: true,
      },
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright MakerX',
    },
  },
})
