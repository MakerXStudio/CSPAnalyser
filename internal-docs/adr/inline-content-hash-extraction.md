# Inline Content Hash Extraction

## Status

Accepted (commits `36e0a3d`, `53105fd`, April 2026).

## Context

To produce a CSP that removes `'unsafe-inline'` for `script-src` and `style-src`, the generated policy must include a SHA-256 (or 384/512) hash for every inline `<script>`, inline `<style>`, event-handler attribute (`onclick="..."`), and `style` attribute that the application legitimately uses. If a single hash is missing, the browser will block that inline content in production.

The original implementation (Phase 3) derived hashes from the `sample` field on the CSP violation report. This seemed natural — the browser already tells us what was blocked — but it is fundamentally broken for hashing:

- Browsers truncate the `sample` field at 256 characters (Chrome, Firefox, Safari all impose similar limits)
- The SHA-256 of a truncated sample never matches the SHA-256 of the full inline content the browser will compute at enforcement time
- As a defensive measure, the Phase 3 code only emitted hashes when the sample was under 256 chars, which in practice meant **almost no real inline scripts got hashed**

A separate, reliable source of the full inline content was required.

CSS-in-JS libraries (styled-components, emotion, Vanilla Extract), lazy-loaded widgets, analytics snippets, and any code that creates `<script>` or `<style>` elements at runtime add a second problem: a one-shot scan after page load misses content injected afterwards.

## Principles

- **Hash what the browser will hash** — any mechanism that cannot produce the full, exact bytes the browser sees is unfit for the purpose
- **Belt and suspenders for inline content** — it is cheaper to capture the same inline block twice (and deduplicate at the database layer) than to miss one
- **Observe, do not mutate** — the extraction mechanism must not alter the page's behaviour

## Requirements, Constraints, and Considerations

- Must extract the full content of every inline `<script>` and `<style>` element, every `on*` event-handler attribute, and every inline `style` attribute
- Must compute hashes over the exact bytes the browser will hash (no whitespace normalisation, no character-set conversion, no truncation)
- Must capture inline content that exists at page load **and** inline content injected at runtime (CSS-in-JS, lazy-loaded widgets, dynamically created nodes)
- Must deduplicate identical content across pages and across the two capture mechanisms
- Must work in both headless crawl mode and interactive mode (including new tabs opened during interactive browsing)
- Must not block or delay page navigation
- Must tolerate pages that never finish loading (`networkidle` never fires) without losing content

## Options

### Hash the CSP `sample` field

- Continue reading the `sample` field from violation reports and hashing it
- Simple; already implemented
- **Fatally broken** because of 256-char truncation — produces hashes that never match the browser's hash of the full content

### Post-load DOM scan only

- After each page fires `load` (or `domcontentloaded`), run `page.evaluate()` to enumerate `<script>`, `<style>`, `on*` attributes, and `style` attributes and serialise their full content
- Hash each in Node.js; store in an `inline_hashes` table keyed by `(session_id, kind, hash)` with a UNIQUE constraint
- Captures everything present at scan time
- Misses anything injected after the scan: CSS-in-JS libraries that inject styles as components mount, lazy-loaded widgets, runtime-created `<script>` elements

### MutationObserver from page init

- Inject an init script (`page.addInitScript`) that starts a `MutationObserver` observing `childList`, `subtree`, and `attributes` on `document.documentElement` from the earliest possible moment
- For every matched node (`<script>`, `<style>`, element with `on*` or `style` attributes), forward the full content to Node.js via an exposed function (`__cspInlineObserve`)
- Node.js hashes and inserts into `inline_hashes`; the UNIQUE constraint on `(session_id, kind, hash)` dedupes automatically
- Captures content injected at any point in the page lifecycle
- On its own, there is still a race between observer setup and early content parsed before the observer is attached; in practice Playwright's `addInitScript` runs before first paint but we should not assume it is infallible

### Post-load scan + MutationObserver (chosen)

- Run both mechanisms. The MutationObserver catches runtime injection; the post-load scan is the belt-and-suspenders safety net for anything the observer might have missed
- The UNIQUE constraint on `inline_hashes` drops duplicates silently
- Cost is a handful of extra `INSERT OR IGNORE` queries per page — negligible

### Comparison

| Criterion | `sample` hashing | Post-load scan | MutationObserver | Scan + Observer |
|-----------|------------------|----------------|-------------------|-----------------|
| Content covered | Short fragments only | Load-time snapshot | Lifecycle-wide | Lifecycle-wide + snapshot |
| Accuracy (matches browser hash) | No (truncated) | Yes | Yes | Yes |
| CSS-in-JS / runtime injection | No | No | Yes | Yes |
| Early-parse content (pre-observer) | No | Yes | Most | Yes |
| Dedup mechanism | N/A | Trivial | Required | UNIQUE constraint |
| Runtime cost | Zero | One `page.evaluate()` per page | One observer + callbacks | Both |

## Decision

Use **post-load DOM scan + MutationObserver-at-init**, with deduplication via a `UNIQUE(session_id, kind, hash)` constraint on the `inline_hashes` table.

Concretely:

1. `src/inline-content-observer.ts` installs an init script via `page.addInitScript()`. The script wires a `MutationObserver` that watches `document.documentElement` from the earliest moment Playwright permits, and forwards any matched inline content through `page.exposeFunction('__cspInlineObserve', ...)` to Node.js for hashing.
2. `src/inline-content-extractor.ts` runs a post-load `page.evaluate()` scan (triggered from the crawler's `onPageLoaded` callback and from `page.on('load')` in interactive mode, including new tabs) that enumerates every inline `<script>`, `<style>`, `on*` attribute, and `style` attribute and emits the full content.
3. Both paths hash the content in Node.js (SHA-256) and call `repository.insertInlineHash({...})`, which uses `INSERT OR IGNORE` against `UNIQUE(session_id, kind, hash)`.
4. `policy-generator.ts` merges the hashes into the directive map when `includeHashes` is set (`--hash` flag), so `--hash` now produces policies that actually cover inline content rather than the handful of short fragments that slipped past the old 256-char guard.

The previous `sample`-based hash path is retained only as a fallback for violations where no inline content was captured; the guard that refused to emit hashes from truncated samples remains in place.

## Consequences

- Two new modules (`inline-content-observer.ts`, `inline-content-extractor.ts`) and a new DB table (`inline_hashes`)
- `--hash` becomes a practically useful flag for the first time — policies can drop `'unsafe-inline'` for `script-src` and `style-src` on real applications
- A slight amount of Node.js work per page (hashing + DB writes) that scales with inline content volume; on tested apps this is sub-millisecond per page
- The exposed function `__cspInlineObserve` is a new in-page symbol; we accept the same trust-boundary concern that applies to the DOM violation listener (page-controlled data is treated as untrusted input at the Node.js boundary)
- Inline content is stored verbatim in the DB (in addition to its hash) to aid debugging; this is local data and does not leave the machine

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Observer setup misses content parsed before `addInitScript` executes | Low | Low | Post-load scan catches anything the observer missed; UNIQUE constraint dedupes overlaps |
| Malicious target page forwards fabricated content through `__cspInlineObserve` to poison the policy | Low | Medium | Treated as untrusted; kind is validated against a small enum, content is length-bounded, and the resulting policy is only as dangerous as the user's deployment decision. Same trust model as the violation listener |
| Large inline content (e.g. several MB of inline CSS) blows out DB size | Low | Low | Content is stored per unique hash, not per occurrence; a handful of large blobs is acceptable. Can add a size cap later if needed |
| Hash mismatch because the browser normalises content differently from our extractor | Low | High | Extractor reads `textContent` / attribute values directly — the same source the browser hashes. Validated end-to-end by generating a policy with `--hash` and confirming the browser does not violate it in enforce mode |
