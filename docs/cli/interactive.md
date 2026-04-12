# interactive

Open a headed (visible) browser window for manual navigation. Violations are captured as you browse, and a policy is generated when you close the browser.

## Usage

```bash
csp-analyser interactive <url> [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--strictness <level>` | `moderate` | Policy generation strictness: `strict`, `moderate`, or `permissive`. |
| `--format <fmt>` | `header` | Output format: `header`, `meta`, `nginx`, `apache`, `cloudflare`, `cloudflare-pages`, or `json`. |
| `--mode <mode>` | auto-detect | Interception mode: `local` or `mitm`. |
| `--storage-state <path>` | -- | Path to a Playwright storage state JSON file for pre-authenticated sessions. |
| `--violation-limit <n>` | `10000` | Maximum violations to capture. Set to `0` for unlimited. |
| `--report-only` | `false` | Generate a report-only header. |

::: info
The `--depth` and `--max-pages` options do not apply to interactive mode. You control which pages are visited by navigating manually.
:::

## How it works

1. A Chromium browser window opens, navigated to the provided URL
2. A deny-all report-only CSP is injected into every response
3. As you browse, every CSP violation is captured in the background
4. When you close the browser window, the session ends
5. The captured violations are aggregated into a policy, which is printed to stdout

Each page you visit is recorded. The summary table shows the total pages visited and violations captured.

## When to use interactive mode

Interactive mode is the right choice when:

- **Single-page applications (SPAs)** -- automated crawling only follows `<a>` links, so SPA routes triggered by JavaScript navigation are missed. Use interactive mode to click through the app.
- **Complex authentication flows** -- if your site uses multi-factor auth, CAPTCHAs, or OAuth redirects that cannot be captured in a storage state file.
- **Dynamic content** -- pages that require user interaction (scrolling, clicking tabs, expanding accordions) to load all resources.
- **Testing specific workflows** -- you want a policy that covers a specific user journey rather than the entire site.

## Examples

### Basic interactive session

```bash
csp-analyser interactive https://app.example.com
```

Opens the browser. Navigate through the app, then close the window. The policy appears in your terminal.

### With pre-existing auth

```bash
csp-analyser interactive https://app.example.com --storage-state auth.json
```

Starts the session already logged in.

### Strict policy as JSON

```bash
csp-analyser interactive https://example.com --strictness strict --format json
```

### Save the result

```bash
csp-analyser interactive https://example.com > policy.txt
```

Progress messages appear in the terminal while you browse. The policy is written to the file after you close the browser.
