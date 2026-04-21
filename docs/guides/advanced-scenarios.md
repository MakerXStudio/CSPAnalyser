---
title: Advanced Scenarios — Static Sites, Hash Collapsing, and eval() Attribution
description: Handle CSS-in-JS hash explosions, static site hosting without nonces, unsafe-eval attribution, and option interactions for real-world CSP deployment.
---

# Advanced Scenarios

Real-world CSP deployment often involves trade-offs that don't fit neatly into a single flag. This guide covers the advanced options introduced to handle common pain points: thousands of dynamic inline style hashes, static hosting without nonce support, and identifying which dependencies require `eval()`.

## The hash explosion problem

Modern frontend frameworks (NativeWind, Emotion, styled-components, MUI) inject inline `style` attributes dynamically at runtime. Each unique computed value produces a distinct SHA-256 hash. A typical React Native Web or CSS-in-JS app can generate **hundreds to thousands** of unique `style-src-attr` hashes from a single crawl.

These hashes are:

- **Impractical to maintain** — the list changes whenever styles change
- **Build-specific** — large inline scripts that embed bundle filenames change on every deployment
- **Unbounded** — new user interactions can generate new inline styles not seen during the crawl

### Collapsing hashes to `'unsafe-inline'`

The `--collapse-hash-threshold` flag replaces all hashes in a directive with `'unsafe-inline'` when the count exceeds the threshold:

```bash
# Collapse any directive with more than 10 hashes
csp-analyser generate --hash --collapse-hash-threshold 10
```

This gives you the best of both worlds:

| Directive | Hashes found | Result |
|-----------|-------------|--------|
| `script-src-elem` | 3 | Hashes kept, `'unsafe-inline'` removed |
| `style-src-attr` | 1,963 | Hashes removed, `'unsafe-inline'` added |
| `style-src-elem` | 5 | Hashes kept, `'unsafe-inline'` removed |

### How `--hash` and `--collapse-hash-threshold` interact

When both flags are used together, the optimizer applies them in sequence:

1. **`--hash`** runs first: removes `'unsafe-inline'` from any directive that has hash sources
2. **`--collapse-hash-threshold`** runs second: for directives exceeding the threshold, removes all hashes and adds `'unsafe-inline'` back

The net effect per directive:

- **Below threshold**: hashes are kept, `'unsafe-inline'` is removed. This is the secure hash-based policy.
- **Above threshold**: hashes are removed, `'unsafe-inline'` is restored. This is the pragmatic fallback.

This is intentional — you get hash-based security where it's practical and a clean `'unsafe-inline'` fallback where it isn't, all from a single command:

```bash
csp-analyser export --format json --hash --collapse-hash-threshold 10
```

### `--strip-unsafe-eval` is independent

The `--strip-unsafe-eval` flag only affects `'unsafe-eval'` in script directives. It has no interaction with hash collapsing or `--hash`. You can combine all three freely:

```bash
csp-analyser generate \
  --hash \
  --collapse-hash-threshold 10 \
  --strip-unsafe-eval
```

This produces a policy where:

- Inline content uses hashes (below threshold) or `'unsafe-inline'` (above threshold)
- `'unsafe-eval'` is stripped entirely, causing `eval()` calls to be blocked and reported

## Static site mode

Static sites (Azure Static Web Apps, GitHub Pages, Netlify, Cloudflare Pages, S3 + CloudFront) serve pre-built files from a CDN. There is no server in the request path to generate a unique nonce per request, which means **nonce-based CSP is not possible**.

The `--static-site` flag tells the optimizer to skip nonce replacement, even if `--nonce` is also passed:

```bash
# --nonce is silently ignored because --static-site takes precedence
csp-analyser generate --nonce --static-site --hash --collapse-hash-threshold 10
```

### Automatic detection

When using the MCP server's `generate_policy` tool, CSP Analyser automatically analyses the session data and returns a `staticSiteAnalysis` object when it detects static site patterns:

```json
{
  "staticSiteAnalysis": {
    "isLikelyStatic": true,
    "confidence": "high",
    "reasons": [
      "Static site indicator found: Expo static export",
      "1963 style-src-attr hashes — CSS-in-JS generating dynamic inline styles",
      "'unsafe-eval' in script-src — common in static SPA builds"
    ],
    "noncesFeasible": false
  }
}
```

Detection signals include:

| Signal | Indicates |
|--------|-----------|
| Expo/webpack/Gatsby/Vite patterns in inline content | Static site generator |
| High `style-src-attr` hash count (50+) | CSS-in-JS on a client-side SPA |
| `'unsafe-eval'` in script-src | Bundler runtime (common in static builds) |
| Many `script-src-elem` hashes | Inline scripts in a static HTML shell |
| `__NEXT_DATA__`, `__NUXT__` patterns | Server-side rendering (nonces *are* feasible) |
| Existing `nonce="..."` attributes | Server already supports nonces |

### Recommended static site policy

For a typical static SPA (React, Vue, Expo) on a static host:

```bash
csp-analyser generate \
  --hash \
  --collapse-hash-threshold 10 \
  --static-site \
  --format header
```

This produces a practical policy like:

```
default-src 'self';
script-src 'self' 'unsafe-eval';
script-src-elem 'self' 'sha256-abc...' 'sha256-def...';
style-src-attr 'unsafe-inline';
style-src-elem 'self' 'unsafe-inline';
img-src 'self' data:;
object-src 'none';
```

## unsafe-eval source attribution

When the generated policy includes `'unsafe-eval'`, the MCP server's `generate_policy` tool returns `evalSources` — a list of the exact source files and line numbers that triggered eval violations, aggregated across all pages (the same callsite hit on 50 pages returns one entry with `count: 50`):

```json
{
  "evalSources": [
    {
      "sourceFile": "https://example.com/_expo/static/js/web/entry-abc123.js",
      "lineNumber": 750,
      "columnNumber": 8896,
      "count": 1
    },
    {
      "sourceFile": "https://example.com/_expo/static/js/web/entry-abc123.js",
      "lineNumber": 754,
      "columnNumber": 623,
      "count": 1
    }
  ]
}
```

This helps you identify which dependencies require `eval()` or `new Function()` so you can decide whether to:

- **Accept `'unsafe-eval'`** — if the dependency is essential and can't be replaced
- **Replace the dependency** — switch to an alternative that doesn't use eval
- **Strip it** — use `--strip-unsafe-eval` to block eval and let violation reports surface the remaining callsites

Common offenders in the JavaScript ecosystem:

| Library | Reason |
|---------|--------|
| `react-native-reanimated` | `new Function("")` feature detection for worklet compilation |
| `react-native-css-interop` / NativeWind | `new Function(...args, body)` to compile CSS-to-JS style rules |
| `regenerator-runtime` | `new Function()` for async/generator polyfills |
| CSS-in-JS libraries | Runtime style compilation |

## Hash stability analysis

The MCP server also returns `hashStability` warnings when it detects that hashes are likely to break across builds:

```json
{
  "hashStability": {
    "warnings": [
      {
        "directive": "script-src-elem",
        "hashCount": 5,
        "reason": "5 hash(es) over 1024 bytes — large inline content is likely build-specific",
        "severity": "warning"
      },
      {
        "directive": "script-src-elem",
        "hashCount": 1,
        "reason": "Hash abc123... contains Expo bundler references — this content changes on every build",
        "severity": "warning"
      }
    ],
    "isHashBasedPolicyPractical": false
  }
}
```

When `isHashBasedPolicyPractical` is `false`, consider using `--collapse-hash-threshold` to automatically fall back to `'unsafe-inline'` for the affected directives.

## Putting it all together

A realistic workflow for deploying CSP on a static Expo/React Native Web app:

```bash
# 1. Crawl the deployed site
csp-analyser crawl https://app.example.com --depth 2 --max-pages 20

# 2. Generate with practical defaults for a static SPA
csp-analyser generate \
  --hash \
  --collapse-hash-threshold 10 \
  --static-site \
  --format json

# 3. Review the evalSources, hashStability, and staticSiteAnalysis
#    in the MCP output to understand the trade-offs

# 4. Export for your hosting platform
csp-analyser export --format cloudflare-pages \
  --hash \
  --collapse-hash-threshold 10 \
  --static-site
```
