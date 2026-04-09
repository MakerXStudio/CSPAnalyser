import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import Database from 'better-sqlite3';
import { createDatabase, createSession, getPages } from '../src/db/repository.js';
import { crawl, type CrawlCallbacks } from '../src/crawler.js';
import type { CrawlConfig, SessionConfig } from '../src/types.js';

const TEST_CONFIG: SessionConfig = {
  targetUrl: 'https://example.com',
  mode: 'local',
};

const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  depth: 1,
  maxPages: 10,
  waitStrategy: 'load',
};

// ── Mock helpers ──────────────────────────────────────────────────────────

function createMockPage(url: string, links: string[] = [], status = 200): Page {
  const page = {
    goto: vi.fn().mockResolvedValue({ status: () => status }),
    $$eval: vi.fn().mockResolvedValue(links),
    close: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(url),
  } as unknown as Page;
  return page;
}

function createMockContext(pagesByUrl: Record<string, { links?: string[]; status?: number; error?: Error }>): BrowserContext {
  const context = {
    newPage: vi.fn().mockImplementation(() => {
      const page: Record<string, unknown> = {
        close: vi.fn().mockResolvedValue(undefined),
        $$eval: vi.fn().mockResolvedValue([]),
        goto: vi.fn().mockImplementation((url: string) => {
          const entry = pagesByUrl[url];
          if (entry?.error) {
            return Promise.reject(entry.error);
          }
          // Set $$eval to return links for this URL
          (page['$$eval'] as ReturnType<typeof vi.fn>).mockResolvedValue(entry?.links ?? []);
          return Promise.resolve({ status: () => entry?.status ?? 200 });
        }),
      };
      return Promise.resolve(page as unknown as Page);
    }),
  } as unknown as BrowserContext;
  return context;
}

describe('crawl', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    sessionId = createSession(db, TEST_CONFIG).id;
  });
  afterEach(() => {
    db.close();
  });

  it('visits the start URL and records it in the database', async () => {
    const context = createMockContext({
      'https://example.com/': { links: [] },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(1);
    expect(result.errors).toEqual([]);

    const pages = getPages(db, sessionId);
    expect(pages).toHaveLength(1);
    expect(pages[0].url).toBe('https://example.com/');
    expect(pages[0].statusCode).toBe(200);
  });

  it('follows same-origin links via BFS', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/about', 'https://example.com/contact'] },
      'https://example.com/about': { links: [] },
      'https://example.com/contact': { links: [] },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(3);
    const pages = getPages(db, sessionId);
    const urls = pages.map((p) => p.url).sort();
    expect(urls).toEqual([
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/contact',
    ]);
  });

  it('respects maxPages limit', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] },
      'https://example.com/a': { links: [] },
      'https://example.com/b': { links: [] },
      'https://example.com/c': { links: [] },
    });

    const config: CrawlConfig = { ...DEFAULT_CRAWL_CONFIG, maxPages: 2 };
    const result = await crawl(context, db, sessionId, 'https://example.com/', config);

    expect(result.pagesVisited).toBe(2);
  });

  it('respects depth limit', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/level1'] },
      'https://example.com/level1': { links: ['https://example.com/level2'] },
      'https://example.com/level2': { links: [] },
    });

    // depth=1 means: visit start (depth 0), follow links at depth 0 -> depth 1, but don't follow links at depth 1
    const config: CrawlConfig = { ...DEFAULT_CRAWL_CONFIG, depth: 1 };
    const result = await crawl(context, db, sessionId, 'https://example.com/', config);

    expect(result.pagesVisited).toBe(2);
    const pages = getPages(db, sessionId);
    const urls = pages.map((p) => p.url).sort();
    expect(urls).toEqual(['https://example.com/', 'https://example.com/level1']);
  });

  it('does not follow cross-origin links', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/about', 'https://evil.com/phish'] },
      'https://example.com/about': { links: [] },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(2);
    const pages = getPages(db, sessionId);
    const urls = pages.map((p) => p.url);
    expect(urls).not.toContain('https://evil.com/phish');
  });

  it('does not visit the same URL twice', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/about', 'https://example.com/about'] },
      'https://example.com/about': { links: ['https://example.com/'] },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(2);
  });

  it('strips fragments for URL normalization', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/page#section1', 'https://example.com/page#section2'] },
      'https://example.com/page': { links: [] },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    // page#section1 and page#section2 both normalize to /page, so only visited once
    expect(result.pagesVisited).toBe(2);
    const pages = getPages(db, sessionId);
    expect(pages).toHaveLength(2);
  });

  it('handles relative URLs', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['/about', './contact'] },
      'https://example.com/about': { links: [] },
      'https://example.com/contact': { links: [] },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(3);
  });

  it('handles navigation errors gracefully', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/broken'] },
      'https://example.com/broken': { error: new Error('net::ERR_CONNECTION_REFUSED') },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].url).toBe('https://example.com/broken');
    expect(result.errors[0].error).toContain('ERR_CONNECTION_REFUSED');
  });

  it('sanitizes error messages to strip internal file paths', async () => {
    const context = createMockContext({
      'https://example.com/': {
        links: ['https://example.com/broken'],
      },
      'https://example.com/broken': {
        error: new Error('Browser closed: /home/user/.cache/ms-playwright/chromium-1234/chrome crashed'),
      },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.errors).toHaveLength(1);
    // File paths should be replaced, not exposed
    expect(result.errors[0].error).not.toContain('/home/user');
    expect(result.errors[0].error).not.toContain('.cache');
    expect(result.errors[0].error).toContain('<path>');
  });

  it('truncates long error messages in CrawlResult', async () => {
    const context = createMockContext({
      'https://example.com/': {
        links: ['https://example.com/broken'],
      },
      'https://example.com/broken': {
        error: new Error('x'.repeat(500)),
      },
    });

    const result = await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error.length).toBeLessThanOrEqual(200);
  });

  it('invokes onPageLoaded callback with page, url, and pageId', async () => {
    const context = createMockContext({
      'https://example.com/': { links: [] },
    });

    const onPageLoaded = vi.fn().mockResolvedValue(undefined);
    const callbacks: CrawlCallbacks = { onPageLoaded };

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG, callbacks);

    expect(onPageLoaded).toHaveBeenCalledTimes(1);
    const [page, url, pageId] = onPageLoaded.mock.calls[0];
    expect(url).toBe('https://example.com/');
    expect(pageId).toBeTruthy();
    expect(page).toBeDefined();
  });

  it('invokes onPageCreated callback before navigation', async () => {
    const callOrder: string[] = [];

    const context = {
      newPage: vi.fn().mockImplementation(() => {
        const page = {
          goto: vi.fn().mockImplementation(() => {
            callOrder.push('goto');
            return Promise.resolve({ status: () => 200 });
          }),
          $$eval: vi.fn().mockResolvedValue([]),
          close: vi.fn().mockResolvedValue(undefined),
        };
        return Promise.resolve(page as unknown as Page);
      }),
    } as unknown as BrowserContext;

    const onPageCreated = vi.fn().mockImplementation(() => {
      callOrder.push('onPageCreated');
      return Promise.resolve();
    });

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG, { onPageCreated });

    expect(onPageCreated).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['onPageCreated', 'goto']);
  });

  it('passes page and url to onPageCreated callback', async () => {
    const context = createMockContext({
      'https://example.com/': { links: [] },
    });

    const onPageCreated = vi.fn().mockResolvedValue(undefined);

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG, { onPageCreated });

    expect(onPageCreated).toHaveBeenCalledTimes(1);
    const [page, url] = onPageCreated.mock.calls[0];
    expect(page).toBeDefined();
    expect(url).toBe('https://example.com/');
  });

  it('invokes onPageCreated for every page in BFS traversal', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/about'] },
      'https://example.com/about': { links: [] },
    });

    const onPageCreated = vi.fn().mockResolvedValue(undefined);

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG, { onPageCreated });

    expect(onPageCreated).toHaveBeenCalledTimes(2);
    expect(onPageCreated.mock.calls[0][1]).toBe('https://example.com/');
    expect(onPageCreated.mock.calls[1][1]).toBe('https://example.com/about');
  });

  it('closes each page after processing', async () => {
    const closeFns: Array<ReturnType<typeof vi.fn>> = [];
    const context = {
      newPage: vi.fn().mockImplementation(() => {
        const closeFn = vi.fn().mockResolvedValue(undefined);
        closeFns.push(closeFn);
        return Promise.resolve({
          goto: vi.fn().mockResolvedValue({ status: () => 200 }),
          $$eval: vi.fn().mockResolvedValue([]),
          close: closeFn,
        } as unknown as Page);
      }),
    } as unknown as BrowserContext;

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(closeFns).toHaveLength(1);
    expect(closeFns[0]).toHaveBeenCalledTimes(1);
  });

  it('closes page even when navigation fails', async () => {
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const context = {
      newPage: vi.fn().mockImplementation(() => {
        return Promise.resolve({
          goto: vi.fn().mockRejectedValue(new Error('timeout')),
          $$eval: vi.fn().mockResolvedValue([]),
          close: closeFn,
        } as unknown as Page);
      }),
    } as unknown as BrowserContext;

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    expect(closeFn).toHaveBeenCalledTimes(1);
  });

  it('returns zero pages for invalid start URL', async () => {
    const context = createMockContext({});

    const result = await crawl(context, db, sessionId, 'not-a-url', DEFAULT_CRAWL_CONFIG);

    expect(result.pagesVisited).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  it('records status codes from responses', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/not-found'] },
      'https://example.com/not-found': { status: 404, links: [] },
    });

    await crawl(context, db, sessionId, 'https://example.com/', DEFAULT_CRAWL_CONFIG);

    const pages = getPages(db, sessionId);
    const notFoundPage = pages.find((p) => p.url === 'https://example.com/not-found');
    expect(notFoundPage?.statusCode).toBe(404);
  });

  it('depth 0 only visits the start URL', async () => {
    const context = createMockContext({
      'https://example.com/': { links: ['https://example.com/other'] },
      'https://example.com/other': { links: [] },
    });

    const config: CrawlConfig = { ...DEFAULT_CRAWL_CONFIG, depth: 0 };
    const result = await crawl(context, db, sessionId, 'https://example.com/', config);

    expect(result.pagesVisited).toBe(1);
  });
});
