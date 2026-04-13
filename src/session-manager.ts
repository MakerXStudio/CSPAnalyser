import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { Session, SessionConfig, CrawlConfig } from './types.js';
import {
  createSession,
  updateSession,
  getSession,
  getViolations,
  insertPage,
  getPages,
  insertPermissionsPolicy,
} from './db/repository.js';
import { startReportServer } from './report-server.js';
import { setupCspInjection, type CapturedPermissionsPolicy } from './csp-injector.js';
import { parsePermissionsPolicyHeaders } from './permissions-policy.js';
import { setupViolationListener } from './violation-listener.js';
import { crawl, type CrawlCallbacks } from './crawler.js';
import { extractOrigin } from './utils/url-utils.js';
import { createAuthenticatedContext, type AuthOptions } from './auth.js';
import { extractInlineHashes } from './inline-content-extractor.js';
import { setupInlineContentObserver } from './inline-content-observer.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  depth: 2,
  maxPages: 50,
  waitStrategy: 'load',
  settlementDelay: 500,
};

// ── Public types ─────────────────────────────────────────────────────────

export interface SessionResult {
  session: Session;
  pagesVisited: number;
  violationsFound: number;
  errors: Array<{ url: string; error: string }>;
}

export interface InteractiveSessionResult {
  session: Session;
  pagesVisited: number;
  violationsFound: number;
  /** Path where browser storage state was saved, if requested */
  storageStatePath?: string;
}

export interface RunSessionOptions {
  onProgress?: (msg: string) => void;
  headless?: boolean;
}

export interface InteractiveSessionOptions {
  onProgress?: (msg: string) => void;
  /** If set, export browser storage state (cookies, localStorage) to this path on session end */
  saveStorageStatePath?: string;
}

/**
 * Injectable dependencies for testing — production code uses the real imports.
 */
export interface SessionDeps {
  launchBrowser: (options: { headless: boolean }) => Promise<Browser>;
  startReportServer: typeof startReportServer;
  createAuthenticatedContext: typeof createAuthenticatedContext;
  crawl: typeof crawl;
  setupCspInjection: typeof setupCspInjection;
  setupViolationListener: typeof setupViolationListener;
  extractInlineHashes: typeof extractInlineHashes;
  setupInlineContentObserver: typeof setupInlineContentObserver;
}

// ── Main orchestrator ────────────────────────────────────────────────────

/**
 * Runs a complete CSP analysis session.
 *
 * 1. Creates session in DB
 * 2. Starts report server + launches browser
 * 3. Authenticates if configured
 * 4. Crawls pages, injecting CSP via Playwright route API and capturing violations
 * 5. Cleans up and returns results
 */
export async function runSession(
  db: Database.Database,
  config: SessionConfig,
  options?: RunSessionOptions,
  deps?: Partial<SessionDeps>,
): Promise<SessionResult> {
  const headless = options?.headless ?? true;
  const progress = options?.onProgress ?? (() => {});

  // Resolve dependencies (allow injection for testing)
  const _launchBrowser =
    deps?.launchBrowser ??
    (async (opts: { headless: boolean }) => {
      const { chromium } = await import('playwright');
      return chromium.launch({ headless: opts.headless });
    });
  const _startReportServer = deps?.startReportServer ?? startReportServer;
  const _createAuthContext = deps?.createAuthenticatedContext ?? createAuthenticatedContext;
  const _crawl = deps?.crawl ?? crawl;
  const _setupCspInjection = deps?.setupCspInjection ?? setupCspInjection;
  const _setupViolationListener = deps?.setupViolationListener ?? setupViolationListener;
  const _extractInlineHashes = deps?.extractInlineHashes ?? extractInlineHashes;
  const _setupInlineContentObserver =
    deps?.setupInlineContentObserver ?? setupInlineContentObserver;

  // 1. Create session
  const session = createSession(db, config);
  const sessionId = session.id;
  progress(`Session created: ${sessionId}`);
  logger.info('Session created', { sessionId, targetUrl: config.targetUrl });

  let browser: Browser | null = null;
  let reportServer: { port: number; token: string; close: () => Promise<void> } | null = null;
  let context: BrowserContext | null = null;

  try {
    const targetOrigin = extractOrigin(config.targetUrl);

    // 2. Start report server
    progress('Starting report server...');
    reportServer = await _startReportServer(db, sessionId, {
      violationLimit: config.violationLimit,
    });
    const reportServerPort = reportServer.port;
    const reportToken = reportServer.token;
    updateSession(db, sessionId, { reportServerPort });
    logger.info('Report server started', { port: reportServerPort });

    // 3. Launch browser
    progress('Launching browser...');
    browser = await _launchBrowser({ headless });

    // 4. Create authenticated context
    progress('Setting up browser context...');
    const authOptions: AuthOptions = {
      storageStatePath: config.storageStatePath,
      cookies: config.cookies,
      headless,
    };

    const authResult = await _createAuthContext(
      browser as unknown as Parameters<typeof createAuthenticatedContext>[0],
      config.targetUrl,
      authOptions,
    );
    context = authResult.context as unknown as BrowserContext;

    // 6. Update status to crawling
    updateSession(db, sessionId, { status: 'crawling' });
    progress('Crawling...');

    // 7. Set up crawl callbacks
    const crawlConfig: CrawlConfig = {
      ...DEFAULT_CRAWL_CONFIG,
      ...config.crawlConfig,
    };

    const onPermissionsPolicy = (
      captured: CapturedPermissionsPolicy[],
      requestUrl: string,
      pageId: string,
    ) => {
      const headers: Record<string, string> = {};
      for (const c of captured) {
        headers[c.headerName] = c.headerValue;
      }
      const parsed = parsePermissionsPolicyHeaders(headers);
      for (const p of parsed) {
        insertPermissionsPolicy(db, {
          sessionId,
          pageId,
          directive: p.directive,
          allowlist: p.allowlist,
          headerType: p.headerType,
          sourceUrl: requestUrl,
        });
      }
    };

    const callbacks: CrawlCallbacks = {
      onPageCreated: async (page: Page, _url: string, pageId: string) => {
        await _setupCspInjection(page, reportServerPort, reportToken, (captured, reqUrl) => {
          onPermissionsPolicy(captured, reqUrl, pageId);
        }, targetOrigin);
        await _setupViolationListener(page, db, sessionId, pageId);
        await _setupInlineContentObserver(page, db, sessionId, pageId);
      },
      onPageLoaded: async (page: Page, url: string, pageId: string) => {
        progress(`Visited: ${url}`);
        await _extractInlineHashes(page, db, sessionId, pageId);
      },
    };

    // 8. Crawl
    const crawlResult = await _crawl(
      context,
      db,
      sessionId,
      config.targetUrl,
      crawlConfig,
      callbacks,
    );

    // 9. Update to analyzing then complete
    updateSession(db, sessionId, { status: 'analyzing' });
    progress('Analysis complete');
    updateSession(db, sessionId, { status: 'complete' });

    // 10. Build result
    const violations = getViolations(db, sessionId);
    const finalSession = getSession(db, sessionId);
    if (!finalSession) {
      throw new Error(`Session ${sessionId} not found after completion`);
    }

    return {
      session: finalSession,
      pagesVisited: crawlResult.pagesVisited,
      violationsFound: violations.length,
      errors: crawlResult.errors,
    };
  } catch (err) {
    logger.error('Session failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      updateSession(db, sessionId, { status: 'failed' });
    } catch {
      // Best-effort — don't mask the original error
    }
    throw err;
  } finally {
    // Cleanup in reverse order
    if (context) {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }
    if (reportServer) {
      try {
        await reportServer.close();
      } catch {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    logger.info('Session cleanup complete', { sessionId });
  }
}

// ── Interactive session orchestrator ────────────────────────────────────

/**
 * Runs an interactive CSP analysis session.
 *
 * Unlike runSession, this opens a headed browser and lets the user browse
 * freely. CSP injection and violation capture are set up on every page
 * the user opens. The session ends when the browser is closed.
 */
export async function runInteractiveSession(
  db: Database.Database,
  config: SessionConfig,
  options?: InteractiveSessionOptions,
  deps?: Partial<SessionDeps>,
): Promise<InteractiveSessionResult> {
  const progress = options?.onProgress ?? (() => {});

  const _launchBrowser =
    deps?.launchBrowser ??
    (async (opts: { headless: boolean }) => {
      const { chromium } = await import('playwright');
      return chromium.launch({ headless: opts.headless });
    });
  const _startReportServer = deps?.startReportServer ?? startReportServer;
  const _createAuthContext = deps?.createAuthenticatedContext ?? createAuthenticatedContext;
  const _setupCspInjection = deps?.setupCspInjection ?? setupCspInjection;
  const _setupViolationListener = deps?.setupViolationListener ?? setupViolationListener;
  const _extractInlineHashes = deps?.extractInlineHashes ?? extractInlineHashes;
  const _setupInlineContentObserver =
    deps?.setupInlineContentObserver ?? setupInlineContentObserver;

  // 1. Create session
  const session = createSession(db, config);
  const sessionId = session.id;
  progress(`Session created: ${sessionId}`);
  logger.info('Interactive session created', { sessionId, targetUrl: config.targetUrl });

  let browser: Browser | null = null;
  let reportServer: { port: number; token: string; close: () => Promise<void> } | null = null;
  let context: BrowserContext | null = null;

  try {
    const targetOrigin = extractOrigin(config.targetUrl);

    // 2. Start report server
    progress('Starting report server...');
    reportServer = await _startReportServer(db, sessionId, {
      violationLimit: config.violationLimit,
    });
    const reportServerPort = reportServer.port;
    const reportToken = reportServer.token;
    updateSession(db, sessionId, { reportServerPort });

    // 3. Launch headed browser
    progress('Launching browser...');
    browser = await _launchBrowser({ headless: false });

    // 4. Create authenticated context
    progress('Setting up browser context...');
    const authOptions: AuthOptions = {
      storageStatePath: config.storageStatePath,
      cookies: config.cookies,
      headless: false,
    };
    const authResult = await _createAuthContext(
      browser as unknown as Parameters<typeof createAuthenticatedContext>[0],
      config.targetUrl,
      authOptions,
    );
    context = authResult.context as unknown as BrowserContext;

    updateSession(db, sessionId, { status: 'crawling' });

    // 5. Helper: set up CSP injection + violation capture on a page
    const setupPage = async (page: Page): Promise<void> => {
      await _setupCspInjection(page, reportServerPort, reportToken, (captured, reqUrl) => {
        const headers: Record<string, string> = {};
        for (const c of captured) {
          headers[c.headerName] = c.headerValue;
        }
        const parsed = parsePermissionsPolicyHeaders(headers);
        for (const p of parsed) {
          insertPermissionsPolicy(db, {
            sessionId,
            pageId: null,
            directive: p.directive,
            allowlist: p.allowlist,
            headerType: p.headerType,
            sourceUrl: reqUrl,
          });
        }
      }, targetOrigin);
      await _setupViolationListener(page, db, sessionId, null);
      await _setupInlineContentObserver(page, db, sessionId, null);

      // Track page navigations as page records and extract inline hashes
      page.on('load', () => {
        const url = page.url();
        if (url === 'about:blank') return;
        const record = insertPage(db, sessionId, url, null);
        if (record) {
          progress(`Visited: ${url}`);
        }
        _extractInlineHashes(page, db, sessionId, record?.id ?? null).catch((err: unknown) => {
          logger.warn('Failed to extract inline hashes in interactive mode', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });
    };

    // 6. Create initial page, set up, and navigate
    const initialPage = await context.newPage();
    await setupPage(initialPage);

    // 7. Listen for additional pages (new tabs opened by the user)
    context.on('page', (page: Page) => {
      setupPage(page).catch((err: unknown) => {
        logger.error('Failed to set up interactive page', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    progress('Browser open — browse freely, close the browser when done');
    await initialPage.goto(config.targetUrl, { waitUntil: 'load' });

    // 8. Wait for browser to close (user closes window or browser process exits)
    const launchedBrowser = browser;
    const launchedContext = context;
    await new Promise<void>((resolve) => {
      // Browser process exited
      launchedBrowser.on('disconnected', () => resolve());
      // All pages/tabs closed (user closed the window but process may linger)
      const checkAllClosed = () => {
        if (launchedContext.pages().length === 0) resolve();
      };
      launchedContext.on('close', () => resolve());
      launchedContext.on('page', (page: Page) => {
        page.on('close', () => checkAllClosed());
      });
      // Also watch the initial page
      for (const page of launchedContext.pages()) {
        page.on('close', () => checkAllClosed());
      }
    });

    // 9. Export storage state if requested (before context closes)
    let savedStorageStatePath: string | undefined;
    if (options?.saveStorageStatePath) {
      try {
        const outPath = resolvePath(options.saveStorageStatePath);
        mkdirSync(dirname(outPath), { recursive: true });
        const state = await context.storageState();
        writeFileSync(outPath, JSON.stringify(state, null, 2), { mode: 0o600 });
        savedStorageStatePath = outPath;
        progress(`Storage state saved to ${outPath}`);
        logger.info('Storage state exported', { path: outPath });
      } catch (err) {
        logger.error('Failed to export storage state', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 10. Build result
    updateSession(db, sessionId, { status: 'complete' });
    const violations = getViolations(db, sessionId);
    const pages = getPages(db, sessionId);
    const finalSession = getSession(db, sessionId);
    if (!finalSession) {
      throw new Error(`Session ${sessionId} not found after completion`);
    }

    progress(
      `Session complete. Visited ${pages.length} pages, found ${violations.length} violations`,
    );

    return {
      session: finalSession,
      pagesVisited: pages.length,
      violationsFound: violations.length,
      storageStatePath: savedStorageStatePath,
    };
  } catch (err) {
    logger.error('Interactive session failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      updateSession(db, sessionId, { status: 'failed' });
    } catch {
      // Best-effort
    }
    throw err;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        /* ignore */
      }
    }
    if (reportServer) {
      try {
        await reportServer.close();
      } catch {
        /* ignore */
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
    logger.info('Interactive session cleanup complete', { sessionId });
  }
}
