---
layout: home
title: CSP Analyser — Automated Content Security Policy Generator
description: Generate production-ready Content Security Policy headers by crawling websites with Playwright. Available as a CLI and MCP server for AI coding agents.

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
      link: https://github.com/MakerXStudio/CSPAnalyser

features:
  - title: Headless Crawling
    details: Automatically crawl your site with a deny-all report-only CSP, capturing every violation. Playwright-powered with configurable depth, page limits, and authentication support.
  - title: MCP Server for AI Agents
    details: Expose the full pipeline as an MCP server over stdio. AI coding agents can generate, score, and diff CSP policies without leaving their workflow.
  - title: 9 Export Formats
    details: Export your policy as a raw header, HTML meta tag, Nginx config, Apache config, Cloudflare Workers, Cloudflare Pages, Azure Front Door (Bicep), Helmet.js, or structured JSON.
---

## What is CSP Analyser?

Content Security Policy headers are one of the strongest browser-side defences against XSS and data injection attacks, but writing them by hand is tedious and error-prone. CSP Analyser automates the process:

1. **Crawl** your website with a deny-all `Content-Security-Policy-Report-Only` header
2. **Capture** every violation the browser reports (scripts, styles, images, fonts, frames, etc.)
3. **Generate** a minimal, correct policy that allows exactly the resources your site needs
4. **Export** the policy in the format your server or CDN expects

The tool runs entirely on your local machine. No data is sent to any external service.

## Who is it for?

- **Web developers** who need to add or tighten a CSP header before shipping to production
- **Security engineers** auditing existing CSP deployments for gaps or overly permissive rules
- **DevOps teams** integrating CSP generation into CI/CD pipelines
- **AI coding agents** that need a structured tool for CSP analysis via the [MCP server](/mcp/)

## Key use cases

| Use case | Command |
|----------|---------|
| Generate a CSP for a live website | [`csp-analyser crawl`](/cli/crawl) |
| Audit an existing CSP deployment | [`csp-analyser audit`](/cli/audit) |
| Generate a CSP for static HTML (no browser) | [`csp-analyser hash-static`](/cli/hash-static) |
| Browse a SPA manually and capture violations | [`csp-analyser interactive`](/cli/interactive) |
| Score a policy against best practices | [`csp-analyser score`](/cli/score) |
| Compare policies across crawl sessions | [`csp-analyser diff`](/cli/diff) |

## Supported output formats

Export your generated policy in any of these formats:

`header` | `meta` | `nginx` | `apache` | `cloudflare` | `cloudflare-pages` | `azure-frontdoor` | `helmet` | `json`

See [Export Formats](/guides/export-formats) for examples and deployment instructions.

## CLI vs MCP server

CSP Analyser ships as both a **standalone CLI** and an **MCP server** for AI coding agents:

- **[CLI](/cli/)** — Run from your terminal. Ideal for local development, scripting, and CI/CD integration.
- **[MCP Server](/mcp/)** — Expose the full pipeline as structured tools over stdio. AI agents like Claude Code and Cursor can crawl, generate, score, and export CSP policies without leaving their workflow.

## Authentication support

Need to analyse a site behind login? CSP Analyser supports:

- **Playwright storage state files** for cookie/session-based auth
- **Interactive login** via a headed browser window
- **Raw cookie injection** for automated pipelines

See the [Authentication guide](/guides/authentication) for details.
