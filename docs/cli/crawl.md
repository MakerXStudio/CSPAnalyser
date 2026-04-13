# crawl

Headlessly crawl a website, capture CSP violations, and generate a policy.

## Usage

```bash
csp-analyser crawl <url> [options]
```

## Options

| Option                   | Default       | Description                                                                                                                   |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--depth <n>`            | `1`           | How many links deep to follow from the start URL. `0` means visit only the start URL.                                         |
| `--max-pages <n>`        | `10`          | Maximum number of pages to visit before stopping. Must be a positive integer.                                                 |
| `--strictness <level>`   | `moderate`    | Policy generation strictness: `strict`, `moderate`, or `permissive`.                                                          |
| `--format <fmt>`         | `header`      | Output format: `header`, `meta`, `nginx`, `apache`, `cloudflare`, `cloudflare-pages`, `azure-frontdoor`, `helmet`, or `json`. |
| `--storage-state <path>` | --            | Path to a Playwright storage state JSON file for authenticated crawling.                                                      |
| `--violation-limit <n>`  | `10000`       | Maximum violations to capture per session. Set to `0` for unlimited.                                                          |
| `--nonce`                | `false`       | Replace `'unsafe-inline'` with nonce placeholders in script/style directives.                                                 |
| `--strict-dynamic`       | `false`       | Add `'strict-dynamic'` alongside nonces in script directives. Implies `--nonce`.                                              |
| `--hash`                 | `false`       | Compute SHA-256 hashes for all inline content and remove `'unsafe-inline'` from directives that have hash sources.            |
| `--strip-unsafe-eval`    | `false`       | Remove `'unsafe-eval'` from the generated policy even if violations were captured for it.                                     |
| `--report-only`          | `false`       | Generate a `Content-Security-Policy-Report-Only` header instead of an enforcing one.                                          |
| `--project <name>`       | auto-detected | Override auto-detected project name. Sessions are tagged with this name.                                                      |

## How crawling works

The crawler uses breadth-first search (BFS) starting from the provided URL:

1. Visit the start URL at depth 0
2. Extract all `<a href="...">` links from the page
3. Filter to same-origin links only (different origins are ignored)
4. Normalize URLs (strip fragments, resolve relative paths)
5. Add unvisited links to the queue at depth + 1
6. Repeat until `--max-pages` is reached or no more links remain within `--depth`

On each page, a deny-all `Content-Security-Policy-Report-Only` header is injected. Every resource the page tries to load triggers a violation, which is captured via both DOM event listeners and an HTTP report endpoint. After each page loads, the crawler also extracts all inline content (`<script>`, `<style>`, event handlers, `style` attributes) from the DOM and computes SHA-256 hashes. After crawling completes, these violations and inline hashes are aggregated into a minimal policy.

A settlement delay (500ms by default) follows each page load to catch violations from lazy-loaded resources and deferred scripts.

## Progress output

Progress is written to stderr so it does not interfere with the policy on stdout. You will see:

- Status messages (browser launch, CSP injection, crawl start)
- A line for each visited page showing the page count, total, and URL
- A summary table at the end with pages visited, violations found, unique directives, elapsed time, and the top violated directives

## Examples

### Basic crawl

```bash
csp-analyser crawl https://example.com
```

Crawls up to 10 pages at depth 1 with moderate strictness, outputs a `Content-Security-Policy` header.

### Deep crawl

```bash
csp-analyser crawl https://example.com --depth 3 --max-pages 50
```

Follows links up to 3 levels deep, visiting at most 50 pages.

### With authentication

```bash
csp-analyser crawl https://app.example.com --storage-state auth.json
```

Uses a Playwright storage state file (cookies + localStorage) to crawl an authenticated area. Generate the storage state file using `npx playwright codegen --save-storage=auth.json`.

### Output as JSON

```bash
csp-analyser crawl https://example.com --format json
```

### Strict policy

```bash
csp-analyser crawl https://example.com --strictness strict
```

Generates a tighter policy. Prefers hashes over host-based allowlisting where possible.

### Report-only mode

```bash
csp-analyser crawl https://example.com --report-only
```

Outputs a `Content-Security-Policy-Report-Only` header suitable for testing in production without blocking resources.

### Save to file

```bash
csp-analyser crawl https://example.com > csp-header.txt
```

Progress still appears in the terminal (stderr), policy goes to the file (stdout).

### Unlimited violations

```bash
csp-analyser crawl https://large-site.com --violation-limit 0
```

Disables the 10,000 violation cap. Useful for very large sites, but increases memory and database usage.
