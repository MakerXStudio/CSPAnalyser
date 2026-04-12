---
layout: home

hero:
  name: CSP Analyser
  tagline: Generate production-ready CSP headers automatically
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/
    - theme: alt
      text: CLI Reference
      link: /cli/
    - theme: alt
      text: View on GitHub
      link: https://github.com/MakerX/csp-analyser

features:
  - title: Headless Crawling
    details: Automatically crawl your site with a deny-all report-only CSP, capturing every violation. Playwright-powered with configurable depth, page limits, and authentication support.
  - title: MCP Server for AI Agents
    details: Expose the full pipeline as an MCP server over stdio. AI coding agents can generate, score, and diff CSP policies without leaving their workflow.
  - title: 7 Export Formats
    details: Export your policy as a raw header, HTML meta tag, Nginx config, Apache config, Cloudflare Workers header, Cloudflare Pages header, or structured JSON.
---

## What is CSP Analyser?

Content Security Policy headers are one of the strongest browser-side defences against XSS and data injection attacks, but writing them by hand is tedious and error-prone. CSP Analyser automates the process:

1. **Crawl** your website with a deny-all `Content-Security-Policy-Report-Only` header
2. **Capture** every violation the browser reports (scripts, styles, images, fonts, frames, etc.)
3. **Generate** a minimal, correct policy that allows exactly the resources your site needs
4. **Export** the policy in the format your server or CDN expects

The tool runs entirely on your local machine. No data is sent to any external service.
