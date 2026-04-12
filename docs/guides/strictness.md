---
title: Strictness Levels
description: Control the trade-off between security and compatibility
---

# Strictness Levels

The `--strictness` flag controls how specific the generated CSP source expressions are. Stricter policies are more secure but may break if CDN subdomains change. More permissive policies are resilient to infrastructure changes but allow a broader attack surface.

## The three levels

### strict

Every external origin is allowed by its exact scheme + host + port. No wildcards.

```
script-src 'self' https://cdn.jsdelivr.net https://unpkg.com;
style-src 'self' https://fonts.googleapis.com;
img-src 'self' https://images.example.com;
font-src 'self' https://fonts.gstatic.com
```

**When a violation for `https://cdn.jsdelivr.net/npm/vue@3/dist/vue.js` is seen**, strict produces:

```
https://cdn.jsdelivr.net
```

### moderate (default)

Three-or-more-label hostnames get a wildcard on the leftmost label. Two-label hostnames and everything else stays exact.

```
script-src 'self' *.jsdelivr.net https://unpkg.com;
style-src 'self' *.googleapis.com;
img-src 'self' *.example.com;
font-src 'self' *.gstatic.com
```

**When a violation for `https://cdn.jsdelivr.net/npm/vue@3/dist/vue.js` is seen**, moderate produces:

```
*.jsdelivr.net
```

Because `cdn.jsdelivr.net` has 3 labels, the leftmost (`cdn`) is replaced with `*`.

### permissive

Same wildcard behaviour as moderate, plus two-label hostnames also get a wildcard prefix.

```
script-src 'self' *.jsdelivr.net *.unpkg.com;
style-src 'self' *.googleapis.com;
img-src 'self' *.example.com;
font-src 'self' *.gstatic.com
```

**When a violation for `https://unpkg.com/vue@3/dist/vue.js` is seen**, permissive produces:

```
*.unpkg.com
```

While moderate would produce the exact origin `https://unpkg.com` (only 2 labels).

## Comparison

| Scenario | strict | moderate | permissive |
|----------|--------|----------|------------|
| `cdn.jsdelivr.net` | `https://cdn.jsdelivr.net` | `*.jsdelivr.net` | `*.jsdelivr.net` |
| `unpkg.com` | `https://unpkg.com` | `https://unpkg.com` | `*.unpkg.com` |
| `fonts.googleapis.com` | `https://fonts.googleapis.com` | `*.googleapis.com` | `*.googleapis.com` |
| Same-origin resource | `'self'` | `'self'` | `'self'` |
| `data:` URI | `data:` | `data:` | `data:` |
| `blob:` URI | `blob:` | `blob:` | `blob:` |
| Inline script/style | `'unsafe-inline'` | `'unsafe-inline'` | `'unsafe-inline'` |

## When to use each

### Use `strict` when

- You are deploying to production and want the tightest possible policy
- You control all the CDN origins and they do not change hostnames
- You are targeting compliance requirements (PCI DSS, SOC 2) that mandate specific origin allow-listing
- You want the highest possible [security score](/guides/scoring)

### Use `moderate` when

- You want a good balance between security and maintainability
- Your site uses CDN subdomains that may vary (e.g., region-specific CDN nodes)
- You are starting out and want a sensible default

### Use `permissive` when

- You are in early development and the site's external dependencies are still changing
- You need to unblock development quickly and will tighten the policy later
- The site loads resources from many two-label domains and exact origins would be fragile

## Usage

::: code-group

```bash [CLI]
csp-analyser crawl https://example.com --strictness strict
csp-analyser generate <session-id> --strictness permissive
```

```json [MCP]
{
  "tool": "start_session",
  "targetUrl": "https://example.com",
  "strictness": "strict"
}
```

:::

::: tip
You can regenerate a policy from the same session with a different strictness level without re-crawling. The violations are stored in the database; only the source expression mapping changes.
:::
