# generate

Regenerate a CSP policy from an existing session's violation data, without re-crawling the site.

## Usage

```bash
csp-analyser generate <session-id> [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--strictness <level>` | `moderate` | Policy generation strictness: `strict`, `moderate`, or `permissive`. |
| `--format <fmt>` | `header` | Output format: `header`, `meta`, `nginx`, `apache`, `cloudflare`, `cloudflare-pages`, `azure-frontdoor`, `helmet`, or `json`. |
| `--report-only` | `false` | Generate a report-only header. |

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
