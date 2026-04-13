import type { BrowserContext, Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { CrawlConfig } from './types.js';
import { isSameOrigin } from './utils/url-utils.js';
import { insertPage, updatePageStatusCode } from './db/repository.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

export interface CrawlResult {
  pagesVisited: number;
  errors: Array<{ url: string; error: string }>;
}

export interface CrawlCallbacks {
  onPageCreated?: (page: Page, url: string, pageId: string) => Promise<void>;
  onPageLoaded?: (page: Page, url: string, pageId: string) => Promise<void>;
}

/**
 * Strips internal file paths and Playwright internals from error messages
 * to prevent information disclosure in the public CrawlResult API.
 */
function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\/[^\s:]+/g, '<path>')
    .replace(/<path>(:<path>)+/g, '<path>')
    .substring(0, 200);
}

/**
 * Triggers late-loading resources that headless browsers often skip or that
 * load asynchronously after initial page load. Without this, common violations
 * for favicons and lazy-loaded images are missed.
 *
 * - Explicitly requests declared favicon/icon link hrefs (plus /favicon.ico as
 *   a fallback) via Image() to trigger img-src violations. Headless Chromium
 *   does not always request favicons, and even when it does, the request may
 *   fire after the page is closed.
 * - Scrolls to the bottom of the page to trigger IntersectionObserver-based
 *   lazy-loading for images, iframes, and other deferred resources.
 *
 * Runs entirely in the page context. Failures are swallowed — we only care
 * about triggering the requests so violations get reported.
 */
async function triggerLateResources(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // 1. Probe favicons so CSP img-src violations fire even if the headless
      //    browser skipped the implicit favicon request.
      const iconHrefs = new Set<string>();
      document
        .querySelectorAll<HTMLLinkElement>('link[rel~="icon"], link[rel~="shortcut"], link[rel~="apple-touch-icon"]')
        .forEach((l) => {
          if (l.href) iconHrefs.add(l.href);
        });
      // Always try the default path as well
      iconHrefs.add(new URL('/favicon.ico', location.href).href);

      for (const href of iconHrefs) {
        try {
          const img = new Image();
          img.src = href;
        } catch {
          // ignore
        }
      }

      // 2. Scroll to bottom to trigger IntersectionObserver lazy-loading,
      //    then back to top so later screenshots/interactions start at the top.
      try {
        window.scrollTo(0, document.documentElement.scrollHeight);
        window.scrollTo(0, 0);
      } catch {
        // ignore
      }
    });
  } catch {
    // Page may have navigated or closed — ignore.
  }
}

/**
 * Normalizes a URL by stripping the fragment and trailing whitespace.
 */
function normalizeUrl(url: string, baseUrl?: string): string | null {
  try {
    const resolved = baseUrl ? new URL(url, baseUrl) : new URL(url);
    resolved.hash = '';
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * BFS crawler that discovers and visits pages within the same origin.
 */
export async function crawl(
  context: BrowserContext,
  db: Database.Database,
  sessionId: string,
  targetUrl: string,
  config: CrawlConfig,
  callbacks?: CrawlCallbacks,
): Promise<CrawlResult> {
  const visited = new Set<string>();
  const errors: Array<{ url: string; error: string }> = [];

  // BFS queue: each entry is [url, depth]
  const queue: Array<[string, number]> = [];

  const startUrl = normalizeUrl(targetUrl);
  if (!startUrl) {
    errors.push({ url: targetUrl, error: 'Invalid start URL' });
    return { pagesVisited: 0, errors };
  }

  queue.push([startUrl, 0]);
  visited.add(startUrl);

  let pagesVisited = 0;

  while (queue.length > 0 && pagesVisited < config.maxPages) {
    const entry = queue.shift();
    if (!entry) break;
    const [url, depth] = entry;

    let page: Page | null = null;
    try {
      page = await context.newPage();

      // Insert page record before navigation so violations can reference it
      const pageRecord = insertPage(db, sessionId, url, null);

      if (pageRecord && callbacks?.onPageCreated) {
        await callbacks.onPageCreated(page, url, pageRecord.id);
      }

      const response = await page.goto(url, { waitUntil: config.waitStrategy });
      const statusCode = response?.status() ?? null;
      pagesVisited++;

      // Update the page record with the actual status code
      if (pageRecord) {
        updatePageStatusCode(db, pageRecord.id, statusCode);
      }

      logger.info('Crawled page', { url, statusCode, depth });

      if (pageRecord && callbacks?.onPageLoaded) {
        await callbacks.onPageLoaded(page, url, pageRecord.id);
      }

      // Trigger late-loading resources (favicons, lazy-loaded images). These
      // frequently produce violations that are otherwise missed because the
      // headless browser skips favicon fetches or IntersectionObserver-based
      // content never enters the viewport during a typical crawl.
      await triggerLateResources(page);

      // After triggering probes and lazy-load, wait for network to go idle
      // so the resulting requests complete (and any violations are reported)
      // before we close the page. Short timeout so a perpetually-busy page
      // doesn't stall the crawl.
      try {
        await page.waitForLoadState('networkidle', { timeout: 3000 });
      } catch {
        // Timeout is fine — we proceed to the settlement delay.
      }

      // Extract links if we haven't reached max depth
      if (depth < config.depth) {
        const hrefs = await page.$$eval('a[href]', (anchors) =>
          anchors.map((a) => a.getAttribute('href')).filter(Boolean),
        );

        for (const href of hrefs) {
          const normalized = normalizeUrl(href as string, url);
          if (!normalized) continue;
          if (visited.has(normalized)) continue;
          if (!isSameOrigin(normalized, targetUrl)) continue;

          visited.add(normalized);
          queue.push([normalized, depth + 1]);
        }
      }

      // Wait for late-arriving violations (lazy-loaded resources, deferred scripts, async fetches)
      if (config.settlementDelay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, config.settlementDelay));
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      logger.warn('Navigation error', { url, error: rawMessage });
      errors.push({ url, error: sanitizeErrorMessage(rawMessage) });
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  return { pagesVisited, errors };
}
