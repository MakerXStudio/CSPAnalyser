# audit

Audit an existing CSP deployment: crawl a website preserving its current CSP headers, capture violations, and produce a diff plus an updated policy for both enforced and report-only headers.

## Usage

```bash
csp-analyser audit <url> [options]
```

Unlike `crawl`, the audit command does **not** inject a deny-all CSP. It preserves the site's existing `Content-Security-Policy` and `Content-Security-Policy-Report-Only` headers, appends a local report endpoint, and captures only the violations that the existing policy triggers. This tells you what the current CSP is blocking or reporting.

## Options

| Option                   | Default       | Description                                                                                                                   |
| ------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--depth <n>`            | `1`           | How many links deep to follow from the start URL. `0` means visit only the start URL.                                         |
| `--max-pages <n>`        | `10`          | Maximum number of pages to visit before stopping. Must be a positive integer.                                                 |
| `--strictness <level>`   | `moderate`    | Policy generation strictness: `strict`, `moderate`, or `permissive`. In strict mode, `'unsafe-inline'` is stripped and replaced with hashes. |
| `--storage-state <path>` | --            | Path to a Playwright storage state JSON file for authenticated crawling.                                                      |
| `--violation-limit <n>`  | `10000`       | Maximum violations to capture per session. Set to `0` for unlimited.                                                          |
| `--project <name>`       | auto-detected | Override auto-detected project name. Sessions are tagged with this name.                                                      |

## How it works

1. The existing CSP headers are captured from each page's HTTP response before modification
2. Report-uri and report-to directives are appended to the existing CSP so violations report to our local capture server
3. Pages are crawled using the same BFS strategy as `crawl`, with violation listeners and inline hash extraction active
4. After crawling, violations are split by disposition:
   - `enforce` violations (from `Content-Security-Policy`) feed the enforced CSP diff
   - `report` violations (from `Content-Security-Policy-Report-Only`) feed the report-only CSP diff
5. For each header type present on the site, the output shows:
   - The existing policy as captured
   - A diff showing what needs to change (added/removed/changed directives and sources)
   - The full updated policy ready to deploy

If a page has no CSP headers at all, it passes through unmodified and produces no violations.

## Strict mode

When `--strictness strict` is used:

- `'unsafe-inline'` is unconditionally stripped from all script and style directives
- SHA-256 hashes for inline content (extracted from the DOM during crawling) are included as replacements
- `'unsafe-eval'` is also stripped
- Any inline content that lacks a hash will be blocked, surfacing what still needs to be addressed

This is useful for hardening an existing CSP that relies on `'unsafe-inline'` into a hash-based policy.

## Output

The audit produces structured output to stdout with sections for each CSP header type found:

```
Audit session: a1b2c3d4-...
Violations found: 5

=== Enforced CSP (Content-Security-Policy) ===
Violations: 3

Existing policy:
  default-src 'self'; script-src 'self' 'unsafe-inline'

Changes:
  Changed directives:
    script-src:
      + https://cdn.example.com
      - 'unsafe-inline'

Updated policy:
  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com

=== Report-Only CSP (Content-Security-Policy-Report-Only) ===
Violations: 2

Existing policy:
  default-src 'none'

Changes:
  ...

Updated policy:
  Content-Security-Policy-Report-Only: ...
```

Progress messages are written to stderr, keeping stdout clean for piping.

## Examples

### Basic audit

```bash
csp-analyser audit https://example.com
```

Audits the existing CSP with moderate strictness. Shows what the current policy is blocking and what needs to change.

### Deep audit

```bash
csp-analyser audit https://example.com --depth 3 --max-pages 50
```

Crawls deeper to find violations across more pages.

### Strict audit with hash replacement

```bash
csp-analyser audit https://app.example.com --strictness strict
```

Strips `'unsafe-inline'` and generates SHA-256 hashes for inline content. Useful for migrating from an `'unsafe-inline'`-based policy to a hash-based one.

### Authenticated audit

```bash
csp-analyser audit https://app.example.com --storage-state auth.json
```

Audits an authenticated area using a Playwright storage state file.

### Save audit output

```bash
csp-analyser audit https://example.com > audit-report.txt
```

Progress appears in the terminal; the audit report goes to the file.
