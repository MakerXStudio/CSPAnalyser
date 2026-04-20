---
title: csp-analyser hash-static — CSP for Static HTML Sites
description: Generate a Content Security Policy for static HTML by hashing inline scripts, styles, and event-handler attributes — no browser required.
---

# hash-static

Generate a CSP policy by scanning static HTML files for inline content — no browser or crawl required.

Use this as a post-build step when you ship a static site: it hashes every inline `<script>`, `<style>`, `style="..."` attribute, and `on*="..."` event handler across the built HTML, dedupes across files, and either prints the policy or writes it straight into each `<head>` as a `<meta>` tag.

## When to use this vs `crawl`

| Scenario | Use |
|---|---|
| You have a static build on disk and want deterministic hashes | `hash-static` |
| You need to capture inline content injected by JS at runtime | `crawl` (dynamic) |
| You want both: static build + framework-injected inline content | `hash-static` with `--extra-*` flags seeded from a one-off crawl |

`hash-static` is fast (no Playwright, no network) and ideal for CI. It only sees what is in the HTML on disk — content added by JavaScript at runtime (e.g. some framework hydration scripts) is invisible to it. For those cases, run `crawl` once against a preview server, capture the missing hashes, and feed them back via `--extra-*`.

## Usage

```bash
csp-analyser hash-static <path>... [options]
```

`<path>` may be a file or a directory; directories are walked recursively for `*.html` files. Multiple paths are allowed.

## Options

| Option | Default | Description |
|---|---|---|
| `--inject` | `false` | Rewrite each scanned HTML in place to include the generated CSP as a `<meta http-equiv="Content-Security-Policy">` immediately after `<head>`. Any existing CSP `<meta>` is replaced. |
| `--format <fmt>` | `meta` | Output format when not using `--inject` (see [export formats](../guides/export-formats)). |
| `--report-only` | `false` | Emit `Content-Security-Policy-Report-Only` instead of the enforcing header. |
| `--extra-script-elem <src>` | — | Extra source expression for `script-src-elem`. Repeatable. Use for runtime-injected inline scripts. |
| `--extra-style-elem <src>` | — | Extra source expression for `style-src-elem`. Repeatable. |
| `--extra-style-attr <src>` | — | Extra source expression for `style-src-attr`. Repeatable. |
| `--extra-script-attr <src>` | — | Extra source expression for `script-src-attr`. Repeatable. |

## What it captures

For each HTML file under the given paths, `hash-static` extracts:

- `<script>...</script>` blocks without a `src` attribute → `script-src-elem`
- `<style>...</style>` blocks → `style-src-elem`
- Every `style="..."` attribute value (including empty strings) → `style-src-attr`
- Every `on*="..."` event handler attribute value (including empty strings) → `script-src-attr`

Empty-string values are included deliberately: browsers evaluate CSP against `<div style="">` and require the empty-string SHA-256 (`sha256-47DEQpj8...`) to be listed for the attribute to apply.

When any hashes end up under `style-src-attr` or `script-src-attr`, `'unsafe-hashes'` is added automatically — without it, the browser silently ignores attribute-context hashes (CSP3 §2.3.2).

## Output

The generated directive map always includes a secure baseline:

- `default-src 'self'`
- `base-uri 'self'`
- `form-action 'self'`
- `font-src 'self'`
- `img-src 'self' data:`
- `object-src 'none'`

Plus `script-src-elem` / `style-src-elem` / `style-src-attr` / `script-src-attr` populated from the scan.

## Examples

### Generate and print the meta tag

```bash
csp-analyser hash-static dist/
```

### Inject into every HTML file in the build output

```bash
csp-analyser hash-static dist/ --inject
```

### As a post-build step in `package.json`

```json
{
  "scripts": {
    "build": "vitepress build docs && csp-analyser hash-static docs/.vitepress/dist --inject"
  }
}
```

### Include runtime-injected hashes captured by a prior crawl

```bash
csp-analyser hash-static dist/ --inject \
  --extra-style-elem "'sha256-skqujXORqzxt1aE0NNXxujEanPTX6raoqSscTV/Ww/Y='" \
  --extra-script-elem "'sha256-someRuntimeInjectedScriptHash='"
```

### Export as Cloudflare Pages `_headers`

```bash
csp-analyser hash-static dist/ --format cloudflare-pages > dist/_headers
```

## Notes

- **HTML parsing is regex-based**, tuned for compliant machine-generated output (VitePress, Next.js, Astro, etc.). Hand-written HTML with unusual quoting may not parse cleanly.
- **Runs without a database** — it does not create a session and cannot be compared, scored, or diffed via the session-based commands.
- If you want to both hash static content *and* capture runtime-injected hashes automatically, run `crawl` against a local preview instead.

## When to use this command

Use `hash-static` as a post-build step for static sites (VitePress, Hugo, Jekyll, Astro, etc.) where you control the HTML output. It scans your built HTML files, computes SHA-256 hashes for every inline `<script>`, `<style>`, `style="..."` attribute, and `on*="..."` event handler, and emits a Content Security Policy that allows exactly those inline resources. No browser or network access required — it works entirely from the filesystem. Choose this over [`crawl`](/cli/crawl) when your site is static and you want deterministic, hash-based CSP generation.

## Related commands

- [`crawl`](/cli/crawl) — Generate a CSP by crawling a live site with Playwright
- [`export`](/cli/export) — Export a policy in a specific deployment format
- [`score`](/cli/score) — Score the generated policy
