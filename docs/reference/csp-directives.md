---
title: CSP Directives
description: All supported CSP directives and their fallback semantics
---

# CSP Directives

CSP Analyser supports 18 CSP directives. This page documents each directive and explains the fallback chain the browser uses when a directive is not explicitly declared.

## Supported directives

| Directive | Category | Description |
|-----------|----------|-------------|
| `default-src` | Fallback | Default policy for all fetch directives not explicitly set |
| `script-src` | Fetch | Controls JavaScript execution sources |
| `script-src-elem` | Fetch | Controls `<script>` element sources (overrides `script-src` for elements) |
| `script-src-attr` | Fetch | Controls inline event handler sources (overrides `script-src` for attributes) |
| `style-src` | Fetch | Controls CSS stylesheet sources |
| `style-src-elem` | Fetch | Controls `<style>` and `<link rel="stylesheet">` sources |
| `style-src-attr` | Fetch | Controls inline `style` attribute sources |
| `img-src` | Fetch | Controls image and favicon sources |
| `font-src` | Fetch | Controls web font sources (`@font-face`) |
| `connect-src` | Fetch | Controls `fetch()`, `XMLHttpRequest`, WebSocket, and EventSource targets |
| `media-src` | Fetch | Controls `<audio>` and `<video>` sources |
| `object-src` | Fetch | Controls `<object>`, `<embed>`, and `<applet>` sources |
| `frame-src` | Fetch | Controls `<iframe>` and `<frame>` sources |
| `worker-src` | Fetch | Controls `Worker`, `SharedWorker`, and `ServiceWorker` sources |
| `child-src` | Fetch | Controls workers and nested browsing contexts (fallback for `worker-src` and `frame-src`) |
| `manifest-src` | Fetch | Controls web app manifest sources |
| `form-action` | Navigation | Controls URLs that `<form>` elements can submit to |
| `base-uri` | Navigation | Controls URLs that can appear in the `<base>` element |

## Fallback semantics

When the browser encounters a resource type and the corresponding directive is not declared in the policy, it falls back to a parent directive. CSP Analyser models this fallback chain when optimizing policies.

```
script-src-elem  →  script-src  →  default-src
script-src-attr  →  script-src  →  default-src
style-src-elem   →  style-src   →  default-src
style-src-attr   →  style-src   →  default-src
img-src          →  default-src
font-src         →  default-src
connect-src      →  default-src
media-src        →  default-src
object-src       →  default-src
frame-src        →  default-src
worker-src       →  default-src
child-src        →  default-src
manifest-src     →  default-src
```

::: info
`form-action` and `base-uri` do **not** fall back to `default-src`. If they are not declared, they are effectively unlimited.
:::

## How CSP Analyser uses fallbacks

### During violation capture

When the browser reports a violation, it includes both the `violatedDirective` (what the policy declared) and the `effectiveDirective` (what the browser evaluated). For example, if the policy only has `default-src 'none'` and a script is loaded, the violated directive is `default-src` but the effective directive is `script-src`.

CSP Analyser uses the **effective directive** to place the source expression in the correct directive.

### During policy optimization

The policy optimizer checks whether a child directive's source list is identical to its parent's. If `script-src` sources exactly match `default-src`, the explicit `script-src` is removed because `default-src` already covers it. This produces shorter, cleaner policies.

## Source expression types

CSP Analyser generates these source expression types:

| Expression | Example | Description |
|------------|---------|-------------|
| `'self'` | `'self'` | Same origin as the document |
| Origin | `https://cdn.example.com` | Exact scheme + host + port |
| Wildcard | `*.example.com` | Any subdomain of the given domain |
| `'unsafe-inline'` | `'unsafe-inline'` | Inline scripts/styles (risky) |
| `'unsafe-eval'` | `'unsafe-eval'` | `eval()` and similar (risky) |
| Hash | `'sha256-abc123...'` | SHA-256 hash of inline content (extracted from `<script>`, `<style>`, event handlers, `style` attributes) |
| Scheme | `data:`, `blob:` | All resources using the given URI scheme |
| `'none'` | `'none'` | Block everything for this directive |
