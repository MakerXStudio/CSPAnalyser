import type { BrowserContext, Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { CrawlConfig } from './types.js';
import { isSameOrigin } from './utils/url-utils.js';
import { insertPage } from './db/repository.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

export interface CrawlResult {
  pagesVisited: number;
  errors: Array<{ url: string; error: string }>;
}

export interface CrawlCallbacks {
  onPageCreated?: (page: Page, url: string) => Promise<void>;
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
    const [url, depth] = queue.shift()!;

    let page: Page | null = null;
    try {
      page = await context.newPage();
      if (callbacks?.onPageCreated) {
        await callbacks.onPageCreated(page, url);
      }
      const response = await page.goto(url, { waitUntil: config.waitStrategy });
      const statusCode = response?.status() ?? null;

      const pageRecord = insertPage(db, sessionId, url, statusCode);
      pagesVisited++;

      logger.info('Crawled page', { url, statusCode, depth });

      if (pageRecord && callbacks?.onPageLoaded) {
        await callbacks.onPageLoaded(page, url, pageRecord.id);
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
