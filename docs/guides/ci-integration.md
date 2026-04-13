---
title: CI Integration
description: Automate CSP analysis in your CI/CD pipeline
---

# CI Integration

CSP Analyser can run in CI environments to enforce CSP quality gates, detect policy regressions, and keep your security posture tracked over time.

## GitHub Actions

### Basic workflow

```yaml
name: CSP Analysis
on:
  push:
    branches: [main]
  pull_request:

jobs:
  csp:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browser
        run: npx @makerx/csp-analyser setup

      - name: Start dev server
        run: npm run dev &
        env:
          PORT: 3000

      - name: Wait for server
        run: npx wait-on http://localhost:3000

      - name: Analyse CSP
        run: npx @makerx/csp-analyser crawl http://localhost:3000 --format json > csp-report.json

      - name: Upload report
        uses: actions/upload-artifact@v4
        with:
          name: csp-report
          path: csp-report.json
```

### Quality gate with score threshold

Fail the build if the CSP score drops below a threshold:

```yaml
      - name: Analyse CSP
        id: csp
        run: |
          # Crawl and capture session ID from JSON output
          OUTPUT=$(npx @makerx/csp-analyser crawl http://localhost:3000 --format json)
          echo "$OUTPUT" > csp-policy.json

          # Extract session ID from the database and score
          SESSION_ID=$(echo "$OUTPUT" | jq -r '.sessionId // empty')
          if [ -n "$SESSION_ID" ]; then
            npx @makerx/csp-analyser score "$SESSION_ID" > csp-score.txt
            cat csp-score.txt
          fi

      - name: Check score threshold
        run: |
          SCORE=$(head -1 csp-score.txt | grep -oP '\d+(?=/100)')
          echo "CSP Score: $SCORE"
          if [ "$SCORE" -lt 75 ]; then
            echo "::error::CSP score $SCORE is below threshold of 75"
            exit 1
          fi
```

## JSON format for programmatic parsing

The `json` export format provides structured output for CI tools:

```json
{
  "directives": {
    "default-src": ["'self'"],
    "script-src": ["'self'", "https://cdn.example.com"],
    "style-src": ["'self'", "https://fonts.googleapis.com"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'", "https://fonts.gstatic.com"]
  },
  "policyString": "default-src 'self'; script-src 'self' https://cdn.example.com; ...",
  "isReportOnly": false
}
```

Parse it with `jq` or any JSON tool:

```bash
# Count the number of directives
cat csp-report.json | jq '.directives | keys | length'

# List all allowed script sources
cat csp-report.json | jq '.directives["script-src"]'

# Get the raw policy string for deployment
cat csp-report.json | jq -r '.policyString'
```

## Regression detection with diff

Compare the current analysis against a previous session to detect policy changes:

```yaml
      - name: Detect regressions
        run: |
          # Assume BASELINE_SESSION is stored from a previous run
          CURRENT=$(npx @makerx/csp-analyser crawl http://localhost:3000 --format json | jq -r '.sessionId')

          if [ -n "$BASELINE_SESSION" ]; then
            npx @makerx/csp-analyser diff "$BASELINE_SESSION" "$CURRENT"
          fi
```

The `diff` command shows:

- **Added directives**: new source expressions that were not in the baseline
- **Removed directives**: source expressions that are no longer needed
- **Changed directives**: directives where the source list has changed

This is useful for pull request reviews: if a PR introduces a new third-party script, the diff will show the new `script-src` entry.

### Storing baseline sessions

The CSP Analyser database is stored at `.csp-analyser/data.db`. To persist baselines across CI runs:

```yaml
      - name: Cache CSP database
        uses: actions/cache@v4
        with:
          path: .csp-analyser
          key: csp-baseline-${{ github.ref }}
          restore-keys: |
            csp-baseline-refs/heads/main
```

## Score as a quality gate

| Threshold | Use case |
|:---------:|----------|
| 90+ (A) | Security-critical applications, compliance requirements |
| 75+ (B) | Standard web applications |
| 55+ (C) | Legacy applications being gradually hardened |

::: tip
Start with a lower threshold and raise it over time. A failing CI gate that nobody fixes is worse than no gate at all.
:::

## Environment considerations

### Browser installation

Playwright's Chromium browser must be installed in CI. The `csp-analyser setup` command handles this:

```yaml
- name: Install Playwright browser
  run: npx @makerx/csp-analyser setup
```

On Ubuntu runners, system dependencies are installed automatically. For other environments, see the [troubleshooting guide](/reference/troubleshooting).

### Headless mode

CI environments are headless by default. The `crawl` command runs in headless mode. Do not use the `interactive` command in CI. It requires a visible browser.

### Network access

The crawled site must be reachable from the CI runner. For local development servers, start the server in the background and wait for it to be ready before crawling. For remote sites, ensure the CI runner has network access and consider using `--storage-state` for authentication.
