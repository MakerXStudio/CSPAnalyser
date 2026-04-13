# CSP Analyser

Automatically generate production-ready [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP) headers by crawling your website. CSP Analyser headlessly browses a target site with a deny-all report-only CSP, captures every violation, and produces a minimal, correct policy you can deploy immediately.

Available as a **CLI** and as an **MCP server** for AI coding agents (Claude Code, Cursor, Windsurf, Copilot).

## Features

- Headless crawling with configurable depth and page limits
- Interactive mode for manual browsing with live violation capture
- Authentication support (storage state, manual login, raw cookies)
- Dual violation capture (DOM events + HTTP reporting endpoint)
- Smart policy optimization (common sources factored into `default-src`)
- Nonce generation replacing `unsafe-inline` with `nonce-` placeholders
- Full inline content hash extraction (scripts, styles, event handlers, style attributes)
- Hash-based `unsafe-inline` removal using SHA-256/384/512 hashes
- `strict-dynamic` support for script loading
- Session diffing to compare policy changes over time
- Policy scoring and security grading
- Permissions-Policy header capture
- Export to 9 formats: HTTP header, `<meta>` tag, nginx, Apache, Cloudflare Workers, Cloudflare Pages, Azure Front Door (Bicep), Helmet.js, JSON

## Install

```bash
npm install -g @makerx/csp-analyser
```

Then install the browser dependency:

```bash
csp-analyser setup
```

Requires Node.js 20+.

## Quick start

Crawl a public site and generate a CSP header:

```bash
csp-analyser crawl https://example.com
```

Crawl with authentication (Playwright storage state):

```bash
csp-analyser crawl https://example.com --storage-state auth.json
```

Interactive mode for sites that need manual navigation:

```bash
csp-analyser interactive https://example.com
```

Save your auth session for later headless crawls:

```bash
csp-analyser interactive https://example.com --save-storage-state auth.json
```

## CLI commands

| Command | Description |
|---------|-------------|
| `crawl <url>` | Headless crawl and generate policy |
| `interactive <url>` | Manual browsing with violation capture |
| `generate <session-id>` | Regenerate policy from a previous session |
| `export <session-id>` | Export policy in a specific format |
| `diff <id1> <id2>` | Compare policies between two sessions |
| `score <session-id>` | Score a generated policy |
| `permissions <session-id>` | Show captured Permissions-Policy headers |
| `sessions` | List all sessions |
| `setup` | Install browser and check dependencies |

### Common flags

```
--depth <n>             Crawl depth (default: 1)
--max-pages <n>         Maximum pages to visit (default: 10)
--strictness <level>    strict | moderate | permissive (default: moderate)
--format <fmt>          header | meta | nginx | apache | cloudflare |
                        cloudflare-pages | azure-frontdoor | helmet | json
--nonce                 Replace unsafe-inline with nonce placeholders
--strict-dynamic        Add strict-dynamic alongside nonces (implies --nonce)
--hash                  Remove unsafe-inline when hash sources are available
--storage-state <path>  Playwright storage state file for auth
--cookies <json>        Raw cookies as JSON string
--manual-login          Open browser for manual login before crawl
--report-only           Generate report-only header
--no-color              Disable colored output
```

## MCP server

CSP Analyser exposes an MCP server for AI coding agents over stdio:

```bash
csp-analyser start
```

Add to your MCP client config (e.g. Claude Code `mcp.json`):

```json
{
  "mcpServers": {
    "csp-analyser": {
      "command": "csp-analyser",
      "args": ["start"]
    }
  }
}
```

The MCP server provides tools for starting sessions, crawling URLs, generating policies, exporting in various formats, diffing sessions, and scoring policies.

## Export formats

**HTTP header:**
```
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com
```

**nginx:**
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com" always;
```

**Apache:**
```apache
Header always set Content-Security-Policy "default-src 'self'; script-src 'self' https://cdn.example.com"
```

**Cloudflare Workers, Cloudflare Pages, Azure Front Door (Bicep), Helmet.js, `<meta>` tag, JSON** are also supported. See the [docs](https://makerxstudio.github.io/CSPAnalyser/) for examples.

## Documentation

Full documentation is available at [makerxstudio.github.io/CSPAnalyser](https://makerxstudio.github.io/CSPAnalyser/).

## Development

```bash
npm install
npx playwright install chromium
npm run build
npm run test
```

## License

MIT
