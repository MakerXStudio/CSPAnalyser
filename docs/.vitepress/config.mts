import { defineConfig } from 'vitepress'

const siteUrl = 'https://cspanalyser.com'

export default defineConfig({
  title: 'CSP Analyser',
  description:
    'Automated Content Security Policy generator — crawl any website with Playwright, capture CSP violations, and export production-ready headers. Available as a CLI and MCP server.',

  base: '/',
  ignoreDeadLinks: true,
  cleanUrls: true,
  lastUpdated: true,

  sitemap: {
    hostname: siteUrl,
  },

  // Note: the Content-Security-Policy meta tag is NOT declared here — it is
  // injected post-build by scripts/generate-csp.mjs, which hashes the actual
  // inline content from the built HTML so the policy never drifts from the
  // output. See the script header for how to capture runtime-injected hashes.
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    ['meta', { name: 'theme-color', content: '#5b7ee5' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'CSP Analyser' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Automated Content Security Policy generator — crawl any website with Playwright, capture CSP violations, and export production-ready headers.',
      },
    ],
    ['meta', { property: 'og:image', content: `${siteUrl}/social-card.png` }],
    ['meta', { property: 'og:url', content: siteUrl }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'CSP Analyser' }],
    [
      'meta',
      {
        name: 'twitter:description',
        content:
          'Automated Content Security Policy generator — crawl any website with Playwright, capture CSP violations, and export production-ready headers.',
      },
    ],
    ['meta', { name: 'twitter:image', content: `${siteUrl}/social-card.png` }],
  ],

  transformHead({ pageData }) {
    const canonicalUrl = `${siteUrl}/${pageData.relativePath}`
      .replace(/index\.md$/, '')
      .replace(/\.md$/, '')

    const head: Array<[string, Record<string, string>]> = [
      ['link', { rel: 'canonical', href: canonicalUrl }],
    ]

    if (pageData.frontmatter.ogImage) {
      head.push([
        'meta',
        { property: 'og:image', content: `${siteUrl}${pageData.frontmatter.ogImage}` },
      ])
    }

    return head
  },

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
            { text: 'audit', link: '/cli/audit' },
            { text: 'generate', link: '/cli/generate' },
            { text: 'export', link: '/cli/export' },
            { text: 'diff', link: '/cli/diff' },
            { text: 'score', link: '/cli/score' },
            { text: 'permissions', link: '/cli/permissions' },
            { text: 'sessions', link: '/cli/sessions' },
            { text: 'setup', link: '/cli/setup' },
            { text: 'start', link: '/cli/start' },
            { text: 'hash-static', link: '/cli/hash-static' },
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
      message:
        '<a href="https://makerx.com.au" target="_blank" rel="noopener"><img class="footer-logo footer-logo-light" src="/makerx-logo-black.png" alt="MakerX"><img class="footer-logo footer-logo-dark" src="/makerx-logo-white.png" alt="MakerX"></a><br>Released under the MIT License.',
      copyright: 'Copyright © MakerX',
    },
  },
})
