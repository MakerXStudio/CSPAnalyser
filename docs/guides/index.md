---
title: CSP Analyser Guides
description: In-depth guides for Content Security Policy generation, authentication, export formats, strictness levels, scoring, and CI/CD integration.
---

# Guides

In-depth guides for getting the most out of CSP Analyser. These cover the decisions you'll face after running your first [crawl](/cli/crawl) — how to handle authenticated pages, choose the right strictness level, interpret your policy score, and integrate CSP generation into your deployment pipeline.

If you're just getting started, begin with the [Quick Start](/getting-started/quick-start) to generate your first policy, then come back here to fine-tune it.

## Authentication

Most real-world sites require login. CSP Analyser supports Playwright storage state files, interactive browser login, and raw cookie injection so you can analyse protected pages without weakening your test.

- **[Authentication guide](/guides/authentication)** — Step-by-step setup for each method

## Policy tuning

The generated policy is controlled by two main levers: strictness level and post-generation options like nonces, hashes, and `strict-dynamic`. These guides explain the trade-offs.

- **[Strictness Levels](/guides/strictness)** — How `strict`, `moderate`, and `permissive` affect the generated directives
- **[Understanding Scores](/guides/scoring)** — The 100-point scoring scale, grade boundaries, and how to improve your score

## Deployment

Once you have a policy you're happy with, export it in the format your infrastructure expects and optionally automate future runs.

- **[Export Formats](/guides/export-formats)** — All output formats with examples for nginx, Apache, Cloudflare, Azure Front Door, Helmet, and more
- **[CI/CD Integration](/guides/ci-integration)** — Run CSP Analyser in GitHub Actions and other CI pipelines to catch regressions automatically
