import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/schema.js';
import { getSession, getViolations, insertViolation } from '../src/db/repository.js';
import { runSession, runInteractiveSession, type SessionDeps } from '../src/session-manager.js';
import type { SessionConfig, CrawlConfig } from '../src/types.js';
import type { CrawlCallbacks, CrawlResult } from '../src/crawler.js';

// ── Mock factories ───────────────────────────────────────────────────────

function createMockPage() {
  return {
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    close: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn().mockResolvedValue([]),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockContext() {
  const mockPage = createMockPage();
  return {
    _mockPage: mockPage,
    newPage: vi.fn().mockResolvedValue(mockPage),
    addCookies: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({ cookies: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockBrowser() {
  const ctx = createMockContext();
  return {
    _mockContext: ctx,
    newContext: vi.fn().mockResolvedValue(ctx),
    newPage: vi.fn().mockResolvedValue(createMockPage()),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createTestDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  const mockBrowser = createMockBrowser();

  return {
    launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
    startReportServer: vi.fn().mockResolvedValue({
      port: 9876,
      token: 'test-token',
      close: vi.fn().mockResolvedValue(undefined),
    }),
    startMitmProxy: vi.fn().mockResolvedValue({
      port: 8080,
      caCertPath: '/tmp/ca.pem',
      close: vi.fn(),
    }),
    createAuthenticatedContext: vi.fn().mockResolvedValue({
      context: mockBrowser._mockContext,
    }),
    crawl: vi.fn().mockResolvedValue({ pagesVisited: 3, errors: [] } satisfies CrawlResult),
    setupCspInjection: vi.fn().mockResolvedValue(vi.fn()),
    setupViolationListener: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeDatabase(db);
});

// ── runSession ───────────────────────────────────────────────────────────

describe('runSession', () => {
  it('runs a local-mode session end-to-end', async () => {
    const config: SessionConfig = {
      targetUrl: 'http://localhost:3000',
    };
    const deps = createTestDeps();

    const result = await runSession(db, config, {}, deps);

    expect(result.session.status).toBe('complete');
    expect(result.session.mode).toBe('local');
    expect(result.pagesVisited).toBe(3);
    expect(result.violationsFound).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('auto-detects MITM mode for remote HTTPS URLs', async () => {
    const config: SessionConfig = {
      targetUrl: 'https://example.com',
    };
    const deps = createTestDeps();

    const result = await runSession(db, config, {}, deps);

    expect(result.session.mode).toBe('mitm');
    expect(deps.startMitmProxy).toHaveBeenCalled();
  });

  it('respects explicit mode override', async () => {
    const config: SessionConfig = {
      targetUrl: 'https://example.com',
      mode: 'local',
    };
    const deps = createTestDeps();

    const result = await runSession(db, config, {}, deps);

    expect(result.session.mode).toBe('local');
    expect(deps.startMitmProxy).not.toHaveBeenCalled();
  });

  it('launches browser with headless option', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    await runSession(db, config, { headless: false }, deps);

    expect(deps.launchBrowser).toHaveBeenCalledWith({ headless: false });
  });

  it('defaults to headless mode', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    await runSession(db, config, {}, deps);

    expect(deps.launchBrowser).toHaveBeenCalledWith({ headless: true });
  });

  it('starts report server and updates session', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    const result = await runSession(db, config, {}, deps);

    expect(deps.startReportServer).toHaveBeenCalledWith(db, result.session.id);
    expect(result.session.reportServerPort).toBe(9876);
  });

  it('passes auth options from config', async () => {
    const config: SessionConfig = {
      targetUrl: 'http://localhost:3000',
      storageStatePath: '/tmp/state.json',
    };
    const deps = createTestDeps();

    await runSession(db, config, {}, deps);

    expect(deps.createAuthenticatedContext).toHaveBeenCalledWith(
      expect.anything(),
      'http://localhost:3000',
      { storageStatePath: '/tmp/state.json', cookies: undefined, headless: true },
    );
  });

  it('passes cookie auth options from config', async () => {
    const config: SessionConfig = {
      targetUrl: 'http://localhost:3000',
      cookies: [{ name: 'session', value: 'abc' }],
    };
    const deps = createTestDeps();

    await runSession(db, config, {}, deps);

    expect(deps.createAuthenticatedContext).toHaveBeenCalledWith(
      expect.anything(),
      'http://localhost:3000',
      { storageStatePath: undefined, cookies: [{ name: 'session', value: 'abc' }], headless: true },
    );
  });

  it('creates unauthenticated context when no auth config', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    await runSession(db, config, {}, deps);

    expect(deps.createAuthenticatedContext).toHaveBeenCalledWith(
      expect.anything(),
      'http://localhost:3000',
      undefined,
    );
  });

  it('passes crawl config to crawler', async () => {
    const config: SessionConfig = {
      targetUrl: 'http://localhost:3000',
      crawlConfig: { depth: 5, maxPages: 100 },
    };
    const deps = createTestDeps();

    await runSession(db, config, {}, deps);

    expect(deps.crawl).toHaveBeenCalledWith(
      expect.anything(), // context
      db,
      expect.any(String), // sessionId
      'http://localhost:3000',
      expect.objectContaining({ depth: 5, maxPages: 100, waitStrategy: 'load', settlementDelay: 500 }),
      expect.any(Object), // callbacks
    );
  });

  it('uses default crawl config when none provided', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    await runSession(db, config, {}, deps);

    expect(deps.crawl).toHaveBeenCalledWith(
      expect.anything(),
      db,
      expect.any(String),
      'http://localhost:3000',
      { depth: 2, maxPages: 50, waitStrategy: 'load', settlementDelay: 500 },
      expect.any(Object),
    );
  });

  it('calls onProgress callback at key stages', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();
    const onProgress = vi.fn();

    await runSession(db, config, { onProgress }, deps);

    const messages = onProgress.mock.calls.map((c) => c[0] as string);
    expect(messages).toContainEqual(expect.stringContaining('Session created'));
    expect(messages).toContain('Launching browser...');
    expect(messages).toContain('Starting report server...');
    expect(messages).toContain('Crawling...');
    expect(messages).toContain('Analysis complete');
  });

  it('sets up CSP injection in local mode via callbacks', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    // Capture the callbacks passed to crawl
    let capturedCallbacks: CrawlCallbacks | undefined;
    deps.crawl = vi.fn().mockImplementation(
      async (_ctx, _db, _sid, _url, _config, callbacks) => {
        capturedCallbacks = callbacks;
        // Simulate calling onPageCreated
        if (callbacks?.onPageCreated) {
          await callbacks.onPageCreated({} as any, 'http://localhost:3000');
        }
        return { pagesVisited: 1, errors: [] };
      },
    );

    await runSession(db, config, {}, deps);

    expect(deps.setupCspInjection).toHaveBeenCalled();
    expect(deps.setupViolationListener).toHaveBeenCalled();
  });

  it('skips CSP injection in MITM mode (proxy handles it)', async () => {
    const config: SessionConfig = { targetUrl: 'https://example.com' };
    const deps = createTestDeps();

    deps.crawl = vi.fn().mockImplementation(
      async (_ctx, _db, _sid, _url, _config, callbacks) => {
        if (callbacks?.onPageCreated) {
          await callbacks.onPageCreated({} as any, 'https://example.com');
        }
        return { pagesVisited: 1, errors: [] };
      },
    );

    await runSession(db, config, {}, deps);

    expect(deps.setupCspInjection).not.toHaveBeenCalled();
    expect(deps.setupViolationListener).toHaveBeenCalled();
  });

  it('counts violations in the result', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    // Pre-populate — we need to first run to get a session ID, so use crawl to insert violations
    deps.crawl = vi.fn().mockImplementation(
      async (_ctx: any, db: Database.Database, sessionId: string) => {
        insertViolation(db, {
          sessionId,
          pageId: null,
          documentUri: 'http://localhost:3000',
          blockedUri: 'http://evil.com/script.js',
          violatedDirective: 'script-src',
          effectiveDirective: 'script-src',
          capturedVia: 'dom_event',
        });
        insertViolation(db, {
          sessionId,
          pageId: null,
          documentUri: 'http://localhost:3000',
          blockedUri: 'http://evil.com/style.css',
          violatedDirective: 'style-src',
          effectiveDirective: 'style-src',
          capturedVia: 'dom_event',
        });
        return { pagesVisited: 1, errors: [] };
      },
    );

    const result = await runSession(db, config, {}, deps);

    expect(result.violationsFound).toBe(2);
  });

  it('returns crawl errors in the result', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();
    deps.crawl = vi.fn().mockResolvedValue({
      pagesVisited: 2,
      errors: [{ url: 'http://localhost:3000/broken', error: 'Navigation timeout' }],
    });

    const result = await runSession(db, config, {}, deps);

    expect(result.errors).toEqual([
      { url: 'http://localhost:3000/broken', error: 'Navigation timeout' },
    ]);
  });

  it('cleans up on success', async () => {
    const config: SessionConfig = { targetUrl: 'https://example.com' };
    const mockBrowser = createMockBrowser();
    const reportClose = vi.fn().mockResolvedValue(undefined);
    const proxyClose = vi.fn();

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      startReportServer: vi.fn().mockResolvedValue({ port: 9876, token: 'test-token', close: reportClose }),
      startMitmProxy: vi.fn().mockResolvedValue({ port: 8080, caCertPath: '/tmp/ca.pem', close: proxyClose }),
      createAuthenticatedContext: vi.fn().mockResolvedValue({ context: mockBrowser._mockContext }),
    });

    await runSession(db, config, {}, deps);

    expect(mockBrowser._mockContext.close).toHaveBeenCalled();
    expect(proxyClose).toHaveBeenCalled();
    expect(reportClose).toHaveBeenCalled();
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('cleans up on crawl failure', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const mockBrowser = createMockBrowser();
    const reportClose = vi.fn().mockResolvedValue(undefined);

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      startReportServer: vi.fn().mockResolvedValue({ port: 9876, token: 'test-token', close: reportClose }),
      createAuthenticatedContext: vi.fn().mockResolvedValue({ context: mockBrowser._mockContext }),
      crawl: vi.fn().mockRejectedValue(new Error('Crawl failed')),
    });

    await expect(runSession(db, config, {}, deps)).rejects.toThrow('Crawl failed');

    expect(mockBrowser._mockContext.close).toHaveBeenCalled();
    expect(reportClose).toHaveBeenCalled();
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('sets session status to failed on error', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps({
      crawl: vi.fn().mockRejectedValue(new Error('Crawl failed')),
    });

    await expect(runSession(db, config, {}, deps)).rejects.toThrow('Crawl failed');

    // Find the session created by runSession
    const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1').all() as Array<{ id: string; status: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('failed');
  });

  it('cleans up on browser launch failure', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps({
      launchBrowser: vi.fn().mockRejectedValue(new Error('Browser not found')),
    });

    await expect(runSession(db, config, {}, deps)).rejects.toThrow('Browser not found');

    // Report server and proxy should not have been started
    expect(deps.startReportServer).not.toHaveBeenCalled();
  });

  it('updates session status through the lifecycle', async () => {
    const config: SessionConfig = { targetUrl: 'http://localhost:3000' };
    const deps = createTestDeps();

    const statuses: string[] = [];
    deps.crawl = vi.fn().mockImplementation(async (_ctx: any, db: Database.Database, sessionId: string) => {
      const session = getSession(db, sessionId);
      if (session) statuses.push(session.status);
      return { pagesVisited: 1, errors: [] };
    });

    const result = await runSession(db, config, {}, deps);

    // During crawl, status should be 'crawling'
    expect(statuses).toContain('crawling');
    // Final status should be 'complete'
    expect(result.session.status).toBe('complete');
  });
});
