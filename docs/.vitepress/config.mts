import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'CSP Analyser',
  description:
    'Generate production-ready Content Security Policy headers by crawling websites',

  base: '/',
  ignoreDeadLinks: true,

  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    [
      'meta',
      {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; base-uri 'self'; font-src 'self'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src-elem 'self' 'sha256-DQUgNM9X0iH2019NkUxeBvnBoEoRKkHBc/I0iLqPNPA=' 'sha256-La1r0VSk0Po4KFI0duEKhmPu+u0I416JW3oONqtdf4M=' 'sha256-bRofa3+iWgGT9OXIjnVL70cshN2mE0woN+zwe0vZwME='; style-src-attr 'unsafe-hashes' 'sha256-+hZXdsbhLzxxkvd2M1OswNwbdnZLTO/zrekviXJwBXU=' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' 'sha256-B10mpnNxgkVfOTJci9xDpY8b+vrCTbVAb2abhZDQzPQ=' 'sha256-K6tyCl4ixBxHA7EhQQQ3FPdMIASAMOY5X3dG/dN495w=' 'sha256-UBwgzPF93ltSrtsHPxvIhqcs2cGF57mEDa4nGXu5Z2E=' 'sha256-Wi3+8jbn12vus9Oq4FOqEUCOpuRG3clBaVvLZZ2b9Fs=' 'sha256-cmdnZAQ9Sz/DBsLKbUCeA/dpDVLa2vMPOArwu9K/DLc=' 'sha256-g3qMmuQ1iSjSYGpi8/uhXrdcZGFemU5eoRtBX6xjeUc=' 'sha256-iYwYhiMcsGmXCUzLEpEzZNz5dINrlkqf1sLbLhEcqGM=' 'sha256-mc/FArgxuOj5vGNP2U9rZeJ70zL4CCOy+qHHI5Pvxr0=' 'sha256-nTNO8OhAqdErJ6WsyH5naQxWCiz7XHJL6dvSpY1wTOo=' 'sha256-qNJfWKpUa+9t3V7DObXtkSGVtQaK5sVnLbVurtS2IQE=' 'sha256-u9VPJmPho+yfz5iKnELpLCwdgYLsePehd2H36mSWFdQ=' 'sha256-xWy5hUKvawTkfXjCN9TJovpVPCC5q4K1RkOLcTfiqBk='; style-src-elem 'self' 'sha256-skqujXORqzxt1aE0NNXxujEanPTX6raoqSscTV/Ww/Y='",
      },
    ],
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
      message:
        '<a href="https://makerx.com.au" target="_blank" rel="noopener"><img class="footer-logo footer-logo-light" src="/makerx-logo-black.png" alt="MakerX"><img class="footer-logo footer-logo-dark" src="/makerx-logo-white.png" alt="MakerX"></a><br>Released under the MIT License.',
      copyright: 'Copyright © MakerX',
    },
  },
})
