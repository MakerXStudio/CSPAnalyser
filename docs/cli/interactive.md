---
title: csp-analyser interactive — Manual Browser CSP Capture
description: Open a headed Playwright browser for manual navigation to capture CSP violations and generate a policy for SPAs and complex sites.
---

# interactive

Open a headed (visible) browser window for manual navigation. Violations are captured as you browse, and a policy is generated when you close the browser.

## Usage

```bash
csp-analyser interactive <url> [options]
```

## Options

| Option                        | Default       | Description                                                                                                                   |
| ----------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--strictness <level>`        | `moderate`    | Policy generation strictness: `strict`, `moderate`, or `permissive`.                                                          |
| `--format <fmt>`              | `header`      | Output format: `header`, `meta`, `nginx`, `apache`, `cloudflare`, `cloudflare-pages`, `azure-frontdoor`, `helmet`, or `json`. |
| `--storage-state <path>`      | --            | Path to a Playwright storage state JSON file for pre-authenticated sessions.                                                  |
| `--save-storage-state <path>` | --            | Export cookies and storage state to a JSON file when the browser closes.                                                      |
| `--violation-limit <n>`       | `10000`       | Maximum violations to capture. Set to `0` for unlimited.                                                                      |
| `--nonce`                     | `false`       | Replace `'unsafe-inline'` with nonce placeholders.                                                                            |
| `--strict-dynamic`            | `false`       | Add `'strict-dynamic'` alongside nonces. Implies `--nonce`.                                                                   |
| `--hash`                      | `false`       | Compute SHA-256 hashes for all inline content and remove `'unsafe-inline'` from directives that have hash sources.            |
| `--strip-unsafe-eval`         | `false`       | Remove `'unsafe-eval'` from the generated policy even if violations were captured for it.                                     |
| `--report-only`               | `false`       | Generate a report-only header.                                                                                                |
| `--project <name>`            | auto-detected | Override auto-detected project name. Sessions are tagged with this name.                                                      |

::: info
The `--depth` and `--max-pages` options do not apply to interactive mode. You control which pages are visited by navigating manually.
:::

## How it works

1. A Chromium browser window opens, navigated to the provided URL
2. A deny-all report-only CSP is injected into every response
3. As you browse, every CSP violation is captured in the background
4. After each page load, all inline content (`<script>`, `<style>`, event handlers, `style` attributes) is extracted from the DOM and SHA-256 hashes are computed
5. New tabs opened during your session are also instrumented — violations and inline hashes are captured across all tabs
6. When you close the browser window, the session ends
7. The captured violations and inline hashes are aggregated into a policy, which is printed to stdout

Each page you visit is recorded. The summary table shows the total pages visited and violations captured.

## When to use interactive mode

Interactive mode is the right choice when:

- **Single-page applications (SPAs)**: automated crawling only follows `<a>` links, so SPA routes triggered by JavaScript navigation are missed. Use interactive mode to click through the app.
- **Complex authentication flows**: if your site uses multi-factor auth, CAPTCHAs, or OAuth redirects that cannot be captured in a storage state file.
- **Dynamic content**: pages that require user interaction (scrolling, clicking tabs, expanding accordions) to load all resources.
- **Testing specific workflows**: you want a policy that covers a specific user journey rather than the entire site.

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

### Replace `'unsafe-inline'` with hashes

```bash
csp-analyser interactive https://app.example.com --hash
```

As you browse, CSP Analyser extracts the full content of every inline `<script>`, `<style>`, event handler, and `style` attribute and computes SHA-256 hashes. The resulting policy uses these hashes instead of `'unsafe-inline'`, so no runtime changes to your application are required.

### Export session state for later headless crawls

```bash
# Log in interactively and save the authenticated session
csp-analyser interactive https://app.example.com --save-storage-state auth.json

# Reuse the session for a deep headless crawl later
csp-analyser crawl https://app.example.com --storage-state auth.json --depth 3
```

The storage state file captures cookies, localStorage, and sessionStorage. It's saved with `0600` permissions. See the [Authentication guide](/guides/authentication) for more details.

### Save the result

```bash
csp-analyser interactive https://example.com > policy.txt
```

Progress messages appear in the terminal while you browse. The policy is written to the file after you close the browser.

## When to use this command

Use `interactive` for single-page applications, sites with complex client-side routing, or any page that requires manual interaction to trigger all resource loads. Unlike [`crawl`](/cli/crawl) which follows links automatically, `interactive` opens a visible browser window and lets you navigate manually — clicking buttons, filling forms, triggering modals, and exercising dynamic content. When you close the browser, CSP Analyser generates the policy from everything it observed. Not suitable for headless CI environments.

## Related commands

- [`crawl`](/cli/crawl) — Automatic headless crawling for traditional multi-page sites
- [`audit`](/cli/audit) — Audit an existing CSP with manual or automatic navigation
- [`generate`](/cli/generate) — Regenerate the policy with different settings
- [`export`](/cli/export) — Export the generated policy in a deployment format
