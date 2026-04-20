import { writeFileSync, mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { Session, SessionConfig, CrawlConfig } from './types.js';
import {
  createSession,
  updateSession,
  getSession,
  getViolations,
  getOrInsertPage,
  getPages,
  insertPermissionsPolicy,
  insertExistingCspHeader,
} from './db/repository.js';
import { startReportServer } from './report-server.js';
import { setupCspInjection, type CapturedPermissionsPolicy } from './csp-injector.js';
import { setupCspPassthrough } from './csp-passthrough.js';
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
  settlementDelay: 2000,
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
  setupCspPassthrough: typeof setupCspPassthrough;
  setupViolationListener: (
    page: Page,
    db: Database.Database,
    sessionId: string,
    pageId: string | null | (() => string | null),
  ) => Promise<void>;
  extractInlineHashes: typeof extractInlineHashes;
  setupInlineContentObserver: (
    page: Page,
    db: Database.Database,
    sessionId: string,
    pageId: string | null | (() => string | null),
  ) => Promise<void>;
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
        await _setupCspInjection(
          page,
          reportServerPort,
          reportToken,
          (captured, reqUrl) => {
            onPermissionsPolicy(captured, reqUrl, pageId);
          },
          targetOrigin,
        );
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

    // 5. Helper: set up CSP injection + violation capture on a page.
    //    We track the current pageId per tab so that violations/policies are
    //    attributed correctly. The page record is created eagerly from two
    //    sites to cover both the route-interception path (which fires before
    //    the browser commits navigation) and the DOM event path:
    //
    //    - The Permissions-Policy callback creates the record from reqUrl
    //      during response header interception (earliest possible moment).
    //    - The framenavigated handler updates currentPageId for the DOM
    //      event listeners that fire after navigation commits.
    //
    //    getOrInsertPage is idempotent, so both paths safely converge.
    const setupPage = async (page: Page): Promise<void> => {
      let currentPageId: string | null = null;

      // Resolve pageId from a URL, creating the page record if needed.
      // Called from both route interception and navigation events.
      const resolvePageId = (url: string): string | null => {
        if (url === 'about:blank' || !url) return currentPageId;
        const record = getOrInsertPage(db, sessionId, url, null);
        currentPageId = record.id;
        return currentPageId;
      };

      // Update currentPageId on navigation commit so that DOM event
      // listeners (violations, inline observer) see the correct page.
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        resolvePageId(page.url());
      });

      await _setupCspInjection(
        page,
        reportServerPort,
        reportToken,
        (captured, reqUrl) => {
          // Eagerly resolve the page record from the request URL so that
          // Permissions-Policy headers captured during route interception
          // (before framenavigated fires) are attributed correctly.
          const pageId = resolvePageId(reqUrl);

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
              sourceUrl: reqUrl,
            });
          }
        },
        targetOrigin,
      );
      await _setupViolationListener(page, db, sessionId, () => currentPageId);
      await _setupInlineContentObserver(page, db, sessionId, () => currentPageId);

      // Extract inline hashes after page fully loads
      page.on('load', () => {
        const url = page.url();
        if (url === 'about:blank') return;
        progress(`Visited: ${url}`);
        _extractInlineHashes(page, db, sessionId, currentPageId).catch((err: unknown) => {
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

        // Reject symlink targets to prevent writing secrets to unexpected locations
        try {
          const stat = lstatSync(outPath);
          if (stat.isSymbolicLink()) {
            throw new Error(`Refusing to write storage state to symlink target: ${outPath}`);
          }
        } catch (err) {
          // ENOENT is fine — file doesn't exist yet. Re-throw other errors.
          if (
            err instanceof Error &&
            'code' in err &&
            (err as NodeJS.ErrnoException).code !== 'ENOENT'
          ) {
            throw err;
          }
        }

        mkdirSync(dirname(outPath), { recursive: true });
        const state = await context.storageState();
        writeFileSync(outPath, JSON.stringify(state, null, 2), { mode: 0o600 });
        // Ensure 0600 even when overwriting an existing file with permissive mode
        chmodSync(outPath, 0o600);
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

// ── Audit session orchestrator ───────────────────────────────────────

/**
 * Runs an audit CSP analysis session.
 *
 * Unlike runSession, this preserves the site's existing CSP headers instead of
 * injecting a deny-all policy. Only violations triggered by the existing CSP
 * are captured. The existing CSP headers are stored in the database for later
 * comparison and merging.
 */
export async function runAuditSession(
  db: Database.Database,
  config: SessionConfig,
  options?: RunSessionOptions,
  deps?: Partial<SessionDeps>,
): Promise<SessionResult> {
  const headless = options?.headless ?? true;
  const progress = options?.onProgress ?? (() => {});

  const _launchBrowser =
    deps?.launchBrowser ??
    (async (opts: { headless: boolean }) => {
      const { chromium } = await import('playwright');
      return chromium.launch({ headless: opts.headless });
    });
  const _startReportServer = deps?.startReportServer ?? startReportServer;
  const _createAuthContext = deps?.createAuthenticatedContext ?? createAuthenticatedContext;
  const _crawl = deps?.crawl ?? crawl;
  const _setupCspPassthrough = deps?.setupCspPassthrough ?? setupCspPassthrough;
  const _setupViolationListener = deps?.setupViolationListener ?? setupViolationListener;
  const _extractInlineHashes = deps?.extractInlineHashes ?? extractInlineHashes;
  const _setupInlineContentObserver =
    deps?.setupInlineContentObserver ?? setupInlineContentObserver;

  // 1. Create session (with audit flag)
  const auditConfig: SessionConfig = { ...config, audit: true };
  const session = createSession(db, auditConfig);
  const sessionId = session.id;
  progress(`Audit session created: ${sessionId}`);
  logger.info('Audit session created', { sessionId, targetUrl: config.targetUrl });

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

    // 5. Update status to crawling
    updateSession(db, sessionId, { status: 'crawling' });
    progress('Auditing existing CSP...');

    // 6. Set up crawl callbacks
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
        // Use CSP passthrough instead of deny-all injection
        await _setupCspPassthrough(
          page,
          reportServerPort,
          reportToken,
          (capturedHeaders, reqUrl) => {
            for (const captured of capturedHeaders) {
              insertExistingCspHeader(db, {
                sessionId,
                pageId,
                headerType: captured.headerType,
                headerValue: captured.headerValue,
                sourceUrl: reqUrl,
              });
            }
          },
          (captured, reqUrl) => {
            onPermissionsPolicy(captured, reqUrl, pageId);
          },
          targetOrigin,
        );
        await _setupViolationListener(page, db, sessionId, pageId);
        await _setupInlineContentObserver(page, db, sessionId, pageId);
      },
      onPageLoaded: async (page: Page, url: string, pageId: string) => {
        progress(`Audited: ${url}`);
        await _extractInlineHashes(page, db, sessionId, pageId);
      },
    };

    // 7. Crawl
    const crawlResult = await _crawl(
      context,
      db,
      sessionId,
      config.targetUrl,
      crawlConfig,
      callbacks,
    );

    // 8. Update to analyzing then complete
    updateSession(db, sessionId, { status: 'analyzing' });
    progress('Analysis complete');
    updateSession(db, sessionId, { status: 'complete' });

    // 9. Build result
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
    logger.error('Audit session failed', {
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
    logger.info('Audit session cleanup complete', { sessionId });
  }
}
