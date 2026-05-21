# Vite React CSP Scenario Sample

This sample app exercises CSP Analyser's Playwright integration against a real Vite + React client without launching a second crawler. The Playwright tests drive normal user journeys while the CSP fixture records violations, inline hashes, pages, and policy artifacts.

## What It Covers

The app uses only localhost resources and deterministic inline content. The e2e test triggers scenarios for:

- script elements, dynamic imports, inline scripts, and inline event handlers
- style elements, dynamic style tags, and style attributes
- images, data images, local fonts, media, workers, frames, objects, forms, manifests, and base URI
- same-origin `connect-src` requests through a local JSON endpoint and cross-origin `connect-src` through a local beacon endpoint
- same-origin and cross-origin `frame-src` embeds through local HTML fixtures

`child-src` is covered through browser fallback behavior when a browser reports frame or worker loads that way; modern Chromium usually reports the more specific `frame-src` or `worker-src` directives. A manifest link is present in the HTML, but Chromium does not request manifests deterministically in Playwright, so `manifest-src` is documented rather than required in the raw directive assertion.

The `Legacy inline handler` button in `index.html` intentionally uses an HTML `onclick` attribute instead of a React `onClick` handler. It sets `data-legacy-inline-handler="ran"` on the body and gives CSP Analyser deterministic `script-src-attr` / `unsafe-hashes` coverage for legacy inline event handlers.

`frame-ancestors` is covered as a separate browser harness in the Playwright suite because it controls who may embed a page, not what the sample app may load. The generated policy snapshot does not include `frame-ancestors`; adding analyzer support for that directive would require product-level policy generation changes outside this sample.

## Commands

Run the full sample check:

```bash
npm run example:vite-react:csp
```

That command builds CSP Analyser, builds the sample app, starts the deterministic cross-origin fixture on `localhost:4174`, runs Playwright, writes current CSP artifacts, and compares them with the committed baseline.

Update the baseline after an intentional CSP change:

```bash
npm run example:vite-react:csp:update
```

## Outputs

Playwright worker and aggregate artifacts are written under:

```text
examples/vite-react-client/test-results/csp-analyser/
```

The committed baseline snapshot lives at:

```text
examples/vite-react-client/csp-baseline/csp-policy.json
```

The reporter writes `csp-policy.json` and `csp-header.txt`. The snapshot comparison normalizes directive and source ordering before checking for drift.
