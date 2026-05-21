---
title: Playwright Test Integration
description: Instrument existing Playwright end-to-end tests to capture CSP violations and generate CI artifacts.
---

# Playwright Test Integration

Use the Playwright integration when you already have end-to-end tests that cover the important user journeys. CSP Analyser instruments those pages in-place: it does not launch a second browser and it does not run the crawler.

## Fixture-first setup

Create a shared test fixture and import it from your specs:

```ts
// tests/csp-test.ts
import { test as base } from '@playwright/test';
import { createCspTest } from '@makerx/csp-analyser/playwright';

export const test = createCspTest(base, {
  targetUrl: 'http://localhost:3000',
  outputDir: 'test-results/csp-analyser',
  format: 'json',
  strictness: 'moderate',
  includeHashes: true,
});

export { expect } from '@playwright/test';
```

Then update specs to import the shared fixture:

```ts
import { test, expect } from './csp-test';

test('checkout flow', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
});
```

The `context` and `page` fixtures attach CSP routing, violation listeners, and inline hash observers before the test body runs, so `page.goto()`, popups, and newly-created pages are instrumented. The worker fixture finalizes one capture per worker and writes per-worker JSON artifacts that are safe for parallel CI runs. Set `targetUrl` or Playwright `use.baseURL` so CSP injection is origin-scoped to your app; if neither is available, CSP Analyser cannot safely infer a localhost port and will not restrict injection by origin.

## Manual API

If you do not use Playwright Test fixtures, attach the capture before navigation:

```ts
import { chromium } from 'playwright';
import { createPlaywrightCspCapture } from '@makerx/csp-analyser/playwright';

const browser = await chromium.launch();
const context = await browser.newContext();
const capture = createPlaywrightCspCapture({
  targetUrl: 'http://localhost:3000',
  outputFile: 'test-results/csp-analyser/manual.json',
});

await capture.attachToContext(context);
const page = await context.newPage();
await page.goto('http://localhost:3000');

const result = await capture.finalize();
console.log(result.policy);

await capture.close();
await browser.close();
```

For an existing page, call `await capture.attachToPage(page)` before the next navigation.

## Aggregate artifacts with a reporter

The reporter only merges fixture artifacts. It cannot instrument pages by itself.

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  reporter: [
    ['list'],
    [
      '@makerx/csp-analyser/playwright/reporter',
      {
        artifactsDir: 'test-results/csp-analyser',
        outputDir: 'test-results/csp-analyser',
        useHashes: true,
      },
    ],
  ],
});
```

It writes:

- `csp-policy.json` — merged, re-optimized directive map and policy string
- `csp-header.txt` — deployment-ready `Content-Security-Policy` header

## Complete Vite + React example

For a full fixture, reporter, and baseline comparison setup, see the [Vite React CSP scenario sample](https://github.com/MakerXStudio/CSPAnalyser/tree/main/examples/vite-react-client). The sample runs a deterministic Vite preview server, captures same-origin and cross-origin CSP scenarios through Playwright, and compares the generated policy with a checked-in baseline:

```bash
npm run example:vite-react:csp
```

When a policy change is intentional, update the sample baseline with:

```bash
npm run example:vite-react:csp:update
```

## Options

The fixture and manual API support the same policy options as the CLI generation path where applicable:

- `strictness`: `strict`, `moderate`, or `permissive` (default: `moderate`)
- `format`: artifact format (default: `json`)
- `reportOnly`: emit a report-only policy artifact
- `includeHashes`: include captured inline hashes during generation (default: `true`)
- `useHashes`: remove `unsafe-inline` when hash sources are present
- `nonce`, `strictDynamic`, `stripUnsafeEval`
- `collapseHashThreshold`, `staticSiteMode`, `staticProfile`
- `violationLimit`, `project`
- `outputDir`, `artifactName`, or exact `outputFile`
- `db` or `dbPath` for externally managed storage

::: warning
`outputFile` is treated as a trusted local path controlled by your test configuration. Prefer `outputDir` plus `artifactName` for shared CI fixtures; `artifactName` is validated as a filename and cannot contain path separators.
:::

Keep the reporter in aggregation mode and the fixture in instrumentation mode. This separation preserves original test failures and avoids a second crawl that would miss authenticated or stateful journeys covered by your existing tests.
