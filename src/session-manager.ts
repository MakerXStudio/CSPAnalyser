import type { Browser, BrowserContext, Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { Session, SessionConfig, CrawlConfig, SessionMode } from './types.js';
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
import { shouldUseMitmMode } from './utils/url-utils.js';
import { createAuthenticatedContext, type AuthOptions } from './auth.js';
import { startMitmProxy, type MitmProxyInstance, type MitmProxyOptions } from './mitm-proxy.js';
import { ensureCACertificate, secureCertFiles } from './cert-manager.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

const DEFAULT_CRAWL_CONFIG: CrawlConfig = {
  depth: 2,
  maxPages: 50,
  waitStrategy: 'load',
  settlementDelay: 500,
};

const DEFAULT_DATA_DIR = '.csp-analyser';

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
}

export interface RunSessionOptions {
  onProgress?: (msg: string) => void;
  headless?: boolean;
  dataDir?: string;
}

export interface InteractiveSessionOptions {
  onProgress?: (msg: string) => void;
  dataDir?: string;
}

/**
 * Injectable dependencies for testing — production code uses the real imports.
 */
export interface SessionDeps {
  launchBrowser: (options: { headless: boolean; args?: string[] }) => Promise<Browser>;
  startReportServer: typeof startReportServer;
  startMitmProxy: (options: MitmProxyOptions) => Promise<MitmProxyInstance>;
  createAuthenticatedContext: typeof createAuthenticatedContext;
  crawl: typeof crawl;
  setupCspInjection: typeof setupCspInjection;
  setupViolationListener: typeof setupViolationListener;
}

// ── Main orchestrator ────────────────────────────────────────────────────

/**
 * Runs a complete CSP analysis session.
 *
 * 1. Creates session in DB
 * 2. Launches browser + report server
 * 3. Optionally starts MITM proxy for remote HTTPS sites
 * 4. Authenticates if configured
 * 5. Crawls pages, injecting CSP and capturing violations
 * 6. Cleans up and returns results
 */
export async function runSession(
  db: Database.Database,
  config: SessionConfig,
  options?: RunSessionOptions,
  deps?: Partial<SessionDeps>,
): Promise<SessionResult> {
  const headless = options?.headless ?? true;
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  const progress = options?.onProgress ?? (() => {});

  // Resolve dependencies (allow injection for testing)
  const _launchBrowser =
    deps?.launchBrowser ??
    (async (opts: { headless: boolean; args?: string[] }) => {
      const { chromium } = await import('playwright');
      return chromium.launch({ headless: opts.headless, args: opts.args });
    });
  const _startReportServer = deps?.startReportServer ?? startReportServer;
  const _startMitmProxy = deps?.startMitmProxy ?? startMitmProxy;
  const _createAuthContext = deps?.createAuthenticatedContext ?? createAuthenticatedContext;
  const _crawl = deps?.crawl ?? crawl;
  const _setupCspInjection = deps?.setupCspInjection ?? setupCspInjection;
  const _setupViolationListener = deps?.setupViolationListener ?? setupViolationListener;

  // 1. Create session
  const mode: SessionMode = config.mode ?? (shouldUseMitmMode(config.targetUrl) ? 'mitm' : 'local');
  const sessionConfig: SessionConfig = { ...config, mode };
  const session = createSession(db, sessionConfig);
  const sessionId = session.id;
  progress(`Session created: ${sessionId}`);
  logger.info('Session created', { sessionId, mode, targetUrl: config.targetUrl });

  let browser: Browser | null = null;
  let reportServer: { port: number; token: string; close: () => Promise<void> } | null = null;
  let mitmProxy: MitmProxyInstance | null = null;
  let context: BrowserContext | null = null;

  try {
    // 2. Launch browser (trust MITM proxy's self-signed CA in MITM mode)
    progress('Launching browser...');
    const launchArgs = mode === 'mitm' ? ['--ignore-certificate-errors'] : undefined;
    browser = await _launchBrowser({ headless, args: launchArgs });

    // 3. Start report server
    progress('Starting report server...');
    reportServer = await _startReportServer(db, sessionId, {
      violationLimit: config.violationLimit,
    });
    const reportServerPort = reportServer.port;
    const reportToken = reportServer.token;
    updateSession(db, sessionId, { reportServerPort });
    logger.info('Report server started', { port: reportServerPort });

    // 4. Start MITM proxy if needed
    let proxyPort: number | null = null;
    if (mode === 'mitm') {
      progress('Starting MITM proxy...');
      const certPaths = await ensureCACertificate(dataDir);
      mitmProxy = await _startMitmProxy({ reportServerPort, reportToken, certPaths });
      secureCertFiles(certPaths);
      proxyPort = mitmProxy.port;
      updateSession(db, sessionId, { proxyPort });
      logger.info('MITM proxy started', { port: proxyPort });
    }

    // 5. Create authenticated context
    progress('Setting up browser context...');
    const proxyServer = mitmProxy ? `http://127.0.0.1:${mitmProxy.port}` : undefined;
    const authOptions: AuthOptions = {
      storageStatePath: config.storageStatePath,
      cookies: config.cookies,
      headless,
      proxyServer,
    };

    // For MITM mode, we need to cast the browser to the auth module's interface
    // The auth module uses lightweight interfaces compatible with real Playwright
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
        if (mode === 'local') {
          await _setupCspInjection(page, reportServerPort, reportToken, (captured, reqUrl) => {
            onPermissionsPolicy(captured, reqUrl, pageId);
          });
        }
        await _setupViolationListener(page, db, sessionId, pageId);
      },
      onPageLoaded: async (_page: Page, url: string, _pageId: string) => {
        progress(`Visited: ${url}`);
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
    const finalSession = getSession(db, sessionId)!;

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
    if (mitmProxy) {
      try {
        mitmProxy.close();
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
  const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
  const progress = options?.onProgress ?? (() => {});

  const _launchBrowser =
    deps?.launchBrowser ??
    (async (opts: { headless: boolean; args?: string[] }) => {
      const { chromium } = await import('playwright');
      return chromium.launch({ headless: opts.headless, args: opts.args });
    });
  const _startReportServer = deps?.startReportServer ?? startReportServer;
  const _startMitmProxy = deps?.startMitmProxy ?? startMitmProxy;
  const _createAuthContext = deps?.createAuthenticatedContext ?? createAuthenticatedContext;
  const _setupCspInjection = deps?.setupCspInjection ?? setupCspInjection;
  const _setupViolationListener = deps?.setupViolationListener ?? setupViolationListener;

  // 1. Create session
  const mode: SessionMode = config.mode ?? (shouldUseMitmMode(config.targetUrl) ? 'mitm' : 'local');
  const sessionConfig: SessionConfig = { ...config, mode };
  const session = createSession(db, sessionConfig);
  const sessionId = session.id;
  progress(`Session created: ${sessionId}`);
  logger.info('Interactive session created', { sessionId, mode, targetUrl: config.targetUrl });

  let browser: Browser | null = null;
  let reportServer: { port: number; token: string; close: () => Promise<void> } | null = null;
  let mitmProxy: MitmProxyInstance | null = null;
  let context: BrowserContext | null = null;

  try {
    // 2. Launch headed browser (trust MITM proxy's self-signed CA in MITM mode)
    progress('Launching browser...');
    const launchArgs = mode === 'mitm' ? ['--ignore-certificate-errors'] : undefined;
    browser = await _launchBrowser({ headless: false, args: launchArgs });

    // 3. Start report server
    progress('Starting report server...');
    reportServer = await _startReportServer(db, sessionId, {
      violationLimit: config.violationLimit,
    });
    const reportServerPort = reportServer.port;
    const reportToken = reportServer.token;
    updateSession(db, sessionId, { reportServerPort });

    // 4. Start MITM proxy if needed
    if (mode === 'mitm') {
      progress('Starting MITM proxy...');
      const certPaths = await ensureCACertificate(dataDir);
      mitmProxy = await _startMitmProxy({ reportServerPort, reportToken, certPaths });
      secureCertFiles(certPaths);
      updateSession(db, sessionId, { proxyPort: mitmProxy.port });
    }

    // 5. Create authenticated context
    progress('Setting up browser context...');
    const proxyServer = mitmProxy ? `http://127.0.0.1:${mitmProxy.port}` : undefined;
    const authOptions: AuthOptions = {
      storageStatePath: config.storageStatePath,
      cookies: config.cookies,
      headless: false,
      proxyServer,
    };
    const authResult = await _createAuthContext(
      browser as unknown as Parameters<typeof createAuthenticatedContext>[0],
      config.targetUrl,
      authOptions,
    );
    context = authResult.context as unknown as BrowserContext;

    updateSession(db, sessionId, { status: 'crawling' });

    // 6. Helper: set up CSP injection + violation capture on a page
    const setupPage = async (page: Page): Promise<void> => {
      if (mode === 'local') {
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
        });
      }
      await _setupViolationListener(page, db, sessionId, null);

      // Track page navigations as page records
      page.on('load', () => {
        const url = page.url();
        if (url === 'about:blank') return;
        const record = insertPage(db, sessionId, url, null);
        if (record) {
          progress(`Visited: ${url}`);
        }
      });
    };

    // 7. Create initial page, set up, and navigate
    const initialPage = await context.newPage();
    await setupPage(initialPage);

    // 8. Listen for additional pages (new tabs opened by the user)
    context.on('page', (page: Page) => {
      setupPage(page).catch((err: unknown) => {
        logger.error('Failed to set up interactive page', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    progress('Browser open — browse freely, close the browser when done');
    await initialPage.goto(config.targetUrl, { waitUntil: 'load' });

    // 9. Wait for browser to disconnect (user closes browser)
    await new Promise<void>((resolve) => {
      browser!.on('disconnected', () => resolve());
    });

    // 10. Build result
    updateSession(db, sessionId, { status: 'complete' });
    const violations = getViolations(db, sessionId);
    const pages = getPages(db, sessionId);
    const finalSession = getSession(db, sessionId)!;

    progress(
      `Session complete. Visited ${pages.length} pages, found ${violations.length} violations`,
    );

    return {
      session: finalSession,
      pagesVisited: pages.length,
      violationsFound: violations.length,
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
    if (mitmProxy) {
      try {
        mitmProxy.close();
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
