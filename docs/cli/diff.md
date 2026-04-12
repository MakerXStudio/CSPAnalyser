# diff

Compare the policies and violations between two sessions to see what changed.

## Usage

```bash
csp-analyser diff <session-id-a> <session-id-b> [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--strictness <level>` | `moderate` | Strictness used when generating policies for comparison. |

## What it shows

The diff command generates optimized policies for both sessions using the specified strictness level, then compares them side by side. The output has two sections:

### Policy Changes

- **New directives**: directives present in session B but not in session A
- **Removed directives**: directives present in session A but not in session B
- **Changed directives**: directives present in both sessions but with different source expressions, showing added (`+`) and removed (`-`) sources

### Violation Changes

- **New violations**: directive/blocked-URI pairs that appear in session B but not in session A, with occurrence count
- **Resolved violations**: directive/blocked-URI pairs that appeared in session A but are gone in session B

## Example output

```
Session comparison: abc123 → def456

=== Policy Changes ===

New directives:
  + connect-src

Changed directives:
  script-src:
    + https://new-cdn.example.com
    - https://old-cdn.example.com

=== Violation Changes ===

New violations:
  + [connect-src] https://api.analytics.com (12x)

Resolved violations:
  - [script-src] https://old-cdn.example.com (5x)
```

## Examples

### Compare before and after a deployment

```bash
# Crawl before the change
csp-analyser crawl https://example.com
# Session ID: session-before

# Deploy your changes, then crawl again
csp-analyser crawl https://example.com
# Session ID: session-after

# See what changed
csp-analyser diff session-before session-after
```

### Compare at different strictness levels

```bash
csp-analyser diff abc123 def456 --strictness strict
csp-analyser diff abc123 def456 --strictness permissive
```

### Track CSP drift over time

Run periodic crawls and diff the most recent session against the previous one to detect new third-party resources or removed dependencies.
