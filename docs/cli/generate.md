---
title: csp-analyser generate — Regenerate a CSP Policy
description: Regenerate a Content Security Policy from an existing crawl session without re-running the Playwright analysis.
---

# generate

Regenerate a CSP policy from an existing session's violation data, without re-crawling the site.

## Usage

```bash
csp-analyser generate [session-id] [options]
```

When `session-id` is omitted, the most recent completed session for the current project is used automatically. The project is auto-detected from the nearest `package.json`, falling back to the directory name. Override with `--project` or the `CSP_ANALYSER_PROJECT` environment variable.

## Options

| Option                 | Default       | Description                                                                                                                   |
| ---------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--strictness <level>` | `moderate`    | Policy generation strictness: `strict`, `moderate`, or `permissive`.                                                          |
| `--format <fmt>`       | `header`      | Output format: `header`, `meta`, `nginx`, `apache`, `cloudflare`, `cloudflare-pages`, `azure-frontdoor`, `helmet`, or `json`. |
| `--nonce`              | `false`       | Replace `'unsafe-inline'` with nonce placeholders.                                                                            |
| `--strict-dynamic`     | `false`       | Add `'strict-dynamic'` alongside nonces. Implies `--nonce`.                                                                   |
| `--hash`               | `false`       | Compute SHA-256 hashes for all inline content and remove `'unsafe-inline'` from directives that have hash sources.            |
| `--strip-unsafe-eval`  | `false`       | Remove `'unsafe-eval'` from the generated policy even if violations were captured for it.                                     |
| `--collapse-hash-threshold <n>` | disabled | Collapse hashes to `'unsafe-inline'` when a directive exceeds `<n>` hashes. Useful for CSS-in-JS apps that generate thousands of dynamic inline styles. |
| `--static-site`        | `false`       | Target is a static site — disables nonce replacement since nonces require a server to generate per-request values.             |
| `--report-only`        | `false`       | Generate a report-only header.                                                                                                |
| `--project <name>`     | auto-detected | Override auto-detected project name for session lookup.                                                                       |

## When to use

After running `crawl` or `interactive`, the session ID is printed in the summary. Use `generate` to produce a new policy from the same violation data with different settings. No need to re-crawl.

Common reasons to regenerate:

- Switch between `strict`, `moderate`, and `permissive` to compare the resulting policies
- Change the output format without re-crawling
- Toggle between enforcing and report-only modes

## Examples

### Change strictness

```bash
# Original crawl used moderate (default)
csp-analyser crawl https://example.com
# Session ID: abc123

# Try a stricter policy from the same data
csp-analyser generate abc123 --strictness strict
```

### Compare all three strictness levels

```bash
SESSION=abc123

echo "=== Strict ==="
csp-analyser generate $SESSION --strictness strict

echo "=== Moderate ==="
csp-analyser generate $SESSION --strictness moderate

echo "=== Permissive ==="
csp-analyser generate $SESSION --strictness permissive
```

### Generate as report-only

```bash
csp-analyser generate abc123 --report-only
```

### Output as JSON for programmatic use

```bash
csp-analyser generate abc123 --format json | jq '.directives'
```

## When to use this command

Use `generate` when you want to rebuild a CSP policy from an existing session's violation data without re-crawling the site. This is useful when you want to try different [strictness levels](/guides/strictness), toggle nonce or hash options, or adjust other policy generation settings. It's much faster than running a new crawl since it reuses the already-captured violations.

## Related commands

- [`crawl`](/cli/crawl) — Run a new crawl to capture fresh violation data
- [`export`](/cli/export) — Export the regenerated policy in a deployment format
- [`score`](/cli/score) — Score the regenerated policy
- [`diff`](/cli/diff) — Compare the regenerated policy with another session
