# Quick Start

Generate a production-ready CSP policy in five minutes.

## Step 1: Install and set up

If you have not already, install CSP Analyser and download the browser:

```bash
npm install -g @makerx/csp-analyser
csp-analyser setup
```

See [Installation & Setup](/getting-started/) for details and platform-specific notes.

## Step 2: Crawl a public site

Point the `crawl` command at any website. Here we use `https://example.com` as a safe starting target:

```bash
csp-analyser crawl https://example.com
```

CSP Analyser will:

1. Launch a headless Chromium browser
2. Inject a deny-all `Content-Security-Policy-Report-Only` header
3. Visit the target URL and discover same-origin links (one level deep by default)
4. Capture every CSP violation the browser reports
5. Generate and display a minimal policy

The output includes a summary table and the generated policy:

```
Session abc123 completed

  Pages crawled:   1
  Violations:     12
  Elapsed:       3.2s

Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'
```

::: tip
To crawl deeper, pass `--depth` and `--max-pages`:

```bash
csp-analyser crawl https://example.com --depth 2 --max-pages 25
```
:::

## Step 3: Try different export formats

The default output is a raw `Content-Security-Policy` header. You can change the format with `--format`:

::: code-group

```bash [Nginx]
csp-analyser crawl https://example.com --format nginx
```

```bash [Apache]
csp-analyser crawl https://example.com --format apache
```

```bash [Cloudflare Pages]
csp-analyser crawl https://example.com --format cloudflare-pages
```

```bash [JSON]
csp-analyser crawl https://example.com --format json
```

:::

All nine formats: `header`, `meta`, `nginx`, `apache`, `cloudflare`, `cloudflare-pages`, `azure-frontdoor`, `helmet`, `json`.

## Step 4: Score the policy

Every crawl creates a session. Score the generated policy against security best practices:

```bash
csp-analyser score
```

This automatically uses the most recent session. You can also pass a specific session ID if needed (`csp-analyser score <session-id>`).

The scorer evaluates the policy on criteria such as whether `default-src` is set, whether `unsafe-inline` or `unsafe-eval` appear, and whether the policy uses report-only mode. You get a numeric score and a breakdown of passed and failed checks.

## Step 5: Compare sessions with diff

If you run `crawl` again after making changes to your site, you can compare the two sessions:

```bash
csp-analyser diff <session-id-a> <session-id-b>
```

This shows which directives were added, removed, or changed between the two runs --- useful for tracking how your policy evolves.

## Step 6: Interactive mode for dev servers

For local development servers or sites that require manual navigation (e.g. SPAs with client-side routing), use `interactive` mode:

```bash
csp-analyser interactive http://localhost:3000
```

This opens a **headed** (visible) browser window. Browse your site manually --- click through pages, fill out forms, trigger dynamic content. When you are done, close the browser window and CSP Analyser generates the policy from everything it observed.

::: warning
Interactive mode requires a display server. It will not work in headless CI environments.
:::

## What's next?

- [CLI Reference](/cli/) --- Full documentation for every command and option
- [MCP Server](/mcp/) --- Use CSP Analyser from AI coding agents
- [Guides](/guides/) --- Recipes for authenticated sites, CI pipelines, and more
