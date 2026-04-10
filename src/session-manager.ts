import type { Browser, BrowserContext, Page } from 'playwright';
import type Database from 'better-sqlite3';
import type { Session, SessionConfig, CrawlConfig, SessionMode } from './types.js';
import { createSession, updateSession, getSession, getViolations } from './db/repository.js';
import { startReportServer } from './report-server.js';
import { setupCspInjection } from './csp-injector.js';
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
};

const DEFAULT_DATA_DIR = '.csp-analyser';

// ── Public types ─────────────────────────────────────────────────────────

export interface SessionResult {
  session: Session;
  pagesVisited: number;
  violationsFound: number;
  errors: Array<{ url: string; error: string }>;
}

export interface RunSessionOptions {
  onProgress?: (msg: string) => void;
  headless?: boolean;
  dataDir?: string;
}

/**
 * Injectable dependencies for testing — production code uses the real imports.
 */
export interface SessionDeps {
  launchBrowser: (options: { headless: boolean }) => Promise<Browser>;
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
  const _launchBrowser = deps?.launchBrowser ?? (async (opts: { headless: boolean }) => {
    const { chromium } = await import('playwright');
    return chromium.launch({ headless: opts.headless });
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
  let reportServer: { port: number; close: () => Promise<void> } | null = null;
  let mitmProxy: MitmProxyInstance | null = null;
  let context: BrowserContext | null = null;

  try {
    // 2. Launch browser
    progress('Launching browser...');
    browser = await _launchBrowser({ headless });

    // 3. Start report server
    progress('Starting report server...');
    reportServer = await _startReportServer(db, sessionId);
    const reportServerPort = reportServer.port;
    updateSession(db, sessionId, { reportServerPort });
    logger.info('Report server started', { port: reportServerPort });

    // 4. Start MITM proxy if needed
    let proxyPort: number | null = null;
    if (mode === 'mitm') {
      progress('Starting MITM proxy...');
      const certPaths = await ensureCACertificate(dataDir);
      mitmProxy = await _startMitmProxy({ reportServerPort, certPaths });
      secureCertFiles(certPaths);
      proxyPort = mitmProxy.port;
      updateSession(db, sessionId, { proxyPort });
      logger.info('MITM proxy started', { port: proxyPort });
    }

    // 5. Create authenticated context
    progress('Setting up browser context...');
    const authOptions: AuthOptions | undefined =
      config.storageStatePath || config.cookies
        ? { storageStatePath: config.storageStatePath, cookies: config.cookies }
        : undefined;

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

    const callbacks: CrawlCallbacks = {
      onPageCreated: async (page: Page, url: string) => {
        if (mode === 'local') {
          await _setupCspInjection(page, reportServerPort);
        }
        await _setupViolationListener(page, db, sessionId, null);
      },
      onPageLoaded: async (_page: Page, url: string, pageId: string) => {
        progress(`Visited: ${url}`);
      },
    };

    // 8. Crawl
    const crawlResult = await _crawl(context, db, sessionId, config.targetUrl, crawlConfig, callbacks);

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
    // Try to mark session as failed — but we don't have a 'failed' status,
    // so just leave it in whatever state it was in
    throw err;
  } finally {
    // Cleanup in reverse order
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
    if (mitmProxy) {
      try { mitmProxy.close(); } catch { /* ignore */ }
    }
    if (reportServer) {
      try { await reportServer.close(); } catch { /* ignore */ }
    }
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    logger.info('Session cleanup complete', { sessionId });
  }
}
