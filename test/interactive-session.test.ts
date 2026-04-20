import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/schema.js';
import { getSession, insertViolation, getPages } from '../src/db/repository.js';
import { runInteractiveSession, type SessionDeps } from '../src/session-manager.js';
import type { CrawlResult } from '../src/crawler.js';

// ── Mock factories ───────────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => void;

function createMockPage() {
  const eventHandlers = new Map<string, EventHandler[]>();
  return {
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    close: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn().mockResolvedValue([]),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('about:blank'),
    mainFrame: vi.fn().mockReturnValue({ url: () => 'http://localhost:3000' }),
    on: vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    }),
    _eventHandlers: eventHandlers,
  };
}

function createMockContext() {
  const mockPage = createMockPage();
  const pages = [mockPage];
  const eventHandlers = new Map<string, EventHandler[]>();
  return {
    _mockPage: mockPage,
    newPage: vi.fn().mockResolvedValue(mockPage),
    addCookies: vi.fn().mockResolvedValue(undefined),
    storageState: vi.fn().mockResolvedValue({ cookies: [] }),
    close: vi.fn().mockResolvedValue(undefined),
    pages: vi.fn().mockImplementation(() => pages),
    on: vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    }),
    _eventHandlers: eventHandlers,
  };
}

function createMockBrowser() {
  const ctx = createMockContext();
  const eventHandlers = new Map<string, EventHandler[]>();
  return {
    _mockContext: ctx,
    newContext: vi.fn().mockResolvedValue(ctx),
    newPage: vi.fn().mockResolvedValue(createMockPage()),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    }),
    _eventHandlers: eventHandlers,
  };
}

function createTestDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  const mockBrowser = createMockBrowser();

  return {
    launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
    startReportServer: vi.fn().mockResolvedValue({
      port: 9876,
      token: 'test-token-123',
      close: vi.fn().mockResolvedValue(undefined),
    }),
    createAuthenticatedContext: vi.fn().mockResolvedValue({
      context: mockBrowser._mockContext,
    }),
    crawl: vi.fn().mockResolvedValue({ pagesVisited: 0, errors: [] } satisfies CrawlResult),
    setupCspInjection: vi.fn().mockResolvedValue(vi.fn()),
    setupViolationListener: vi.fn().mockResolvedValue(undefined),
    extractInlineHashes: vi.fn().mockResolvedValue(0),
    setupInlineContentObserver: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Helper: creates deps where the browser 'disconnected' event fires
 * after a microtask, simulating the user closing the browser.
 */
function createAutoDisconnectDeps(overrides?: Partial<SessionDeps>): SessionDeps {
  const mockBrowser = createMockBrowser();

  // Override browser.on to auto-fire 'disconnected' after a microtask
  mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
    if (event === 'disconnected') {
      // Schedule disconnect to fire after the goto completes
      Promise.resolve().then(() => Promise.resolve()).then(() => handler());
    }
  });

  return {
    launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
    startReportServer: vi.fn().mockResolvedValue({
      port: 9876,
      token: 'test-token-123',
      close: vi.fn().mockResolvedValue(undefined),
    }),
    createAuthenticatedContext: vi.fn().mockResolvedValue({
      context: mockBrowser._mockContext,
    }),
    crawl: vi.fn().mockResolvedValue({ pagesVisited: 0, errors: [] } satisfies CrawlResult),
    setupCspInjection: vi.fn().mockResolvedValue(vi.fn()),
    setupViolationListener: vi.fn().mockResolvedValue(undefined),
    extractInlineHashes: vi.fn().mockResolvedValue(0),
    setupInlineContentObserver: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeDatabase(db);
});

// ── runInteractiveSession ────────────────────────────────────────────────

describe('runInteractiveSession', () => {
  it('launches browser in headed mode (headless: false)', async () => {
    const deps = createAutoDisconnectDeps();

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(deps.launchBrowser).toHaveBeenCalledWith({ headless: false });
  });

  it('does not call the crawler', async () => {
    const deps = createAutoDisconnectDeps();

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(deps.crawl).not.toHaveBeenCalled();
  });

  it('creates a session and returns result', async () => {
    const deps = createAutoDisconnectDeps();

    const result = await runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    expect(result.session).toBeDefined();
    expect(result.session.status).toBe('complete');
    expect(result.session.mode).toBe('local');
    expect(result.violationsFound).toBe(0);
  });

  it('starts report server', async () => {
    const deps = createAutoDisconnectDeps();

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(deps.startReportServer).toHaveBeenCalledWith(db, expect.any(String), expect.objectContaining({}));
  });

  it('sets up CSP injection on initial page in local mode', async () => {
    const deps = createAutoDisconnectDeps();

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(deps.setupCspInjection).toHaveBeenCalledWith(
      expect.anything(),
      9876,
      'test-token-123',
      expect.any(Function),
      'http://localhost:3000',
    );
  });

  it('sets up violation listener on initial page', async () => {
    const deps = createAutoDisconnectDeps();

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(deps.setupViolationListener).toHaveBeenCalledWith(
      expect.anything(),
      db,
      expect.any(String),
      expect.any(Function),
    );
  });

  it('navigates to the target URL', async () => {
    const deps = createAutoDisconnectDeps();
    const mockBrowser = await deps.launchBrowser({ headless: false });
    const mockContext = (mockBrowser as unknown as { _mockContext: ReturnType<typeof createMockContext> })._mockContext;
    const mockPage = mockContext._mockPage;

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000', { waitUntil: 'load' });
  });

  it('waits for browser disconnected event', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    // Give time for the function to reach the 'disconnected' listener
    await new Promise((r) => setTimeout(r, 10));

    expect(disconnectHandler).not.toBeNull();

    // Simulate browser close
    disconnectHandler!();

    const result = await promise;
    expect(result.session.status).toBe('complete');
  });

  it('listens for new pages on the context', async () => {
    const mockBrowser = createMockBrowser();
    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        Promise.resolve().then(() => Promise.resolve()).then(() => handler());
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    // Verify context.on('page', ...) was registered
    expect(mockBrowser._mockContext.on).toHaveBeenCalledWith('page', expect.any(Function));
  });

  it('sets up CSP injection on new pages opened by user', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Get the page handler registered on the context
    const contextOnCalls = mockBrowser._mockContext.on.mock.calls;
    const pageHandler = contextOnCalls.find(
      (c: unknown[]) => c[0] === 'page',
    )?.[1] as EventHandler | undefined;

    expect(pageHandler).toBeDefined();

    // Simulate a new page being opened
    const newPage = createMockPage();
    newPage.url = vi.fn().mockReturnValue('http://localhost:3000/about');
    await Promise.resolve(pageHandler?.(newPage));

    // Verify CSP injection and violation listener were set up on the new page
    expect(deps.setupCspInjection).toHaveBeenCalledTimes(2); // initial + new page
    expect(deps.setupViolationListener).toHaveBeenCalledTimes(2);

    disconnectHandler!();
    await promise;
  });

  it('calls onProgress at key stages', async () => {
    const deps = createAutoDisconnectDeps();
    const messages: string[] = [];

    await runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      { onProgress: (msg) => messages.push(msg) },
      deps,
    );

    expect(messages).toContainEqual(expect.stringContaining('Session created'));
    expect(messages).toContain('Launching browser...');
    expect(messages).toContain('Starting report server...');
    expect(messages).toContain('Browser open — browse freely, close the browser when done');
  });

  it('counts violations captured during interactive browsing', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Simulate violations being captured during browsing
    const session = (await db.prepare('SELECT id FROM sessions LIMIT 1').get()) as { id: string };
    insertViolation(db, {
      sessionId: session.id,
      pageId: null,
      documentUri: 'http://localhost:3000/',
      blockedUri: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
    });
    insertViolation(db, {
      sessionId: session.id,
      pageId: null,
      documentUri: 'http://localhost:3000/',
      blockedUri: 'https://fonts.example.com/font.woff',
      violatedDirective: 'font-src',
      effectiveDirective: 'font-src',
      capturedVia: 'report_uri',
    });

    disconnectHandler!();
    const result = await promise;

    expect(result.violationsFound).toBe(2);
  });

  it('cleans up on success', async () => {
    const mockBrowser = createMockBrowser();
    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        Promise.resolve().then(() => Promise.resolve()).then(() => handler());
      }
    });
    const reportClose = vi.fn().mockResolvedValue(undefined);

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      startReportServer: vi.fn().mockResolvedValue({
        port: 9876,
        token: 'test-token',
        close: reportClose,
      }),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    await runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps);

    expect(mockBrowser._mockContext.close).toHaveBeenCalled();
    expect(reportClose).toHaveBeenCalled();
    expect(mockBrowser.close).toHaveBeenCalled();
  });

  it('cleans up on browser launch failure', async () => {
    const deps = createTestDeps({
      launchBrowser: vi.fn().mockRejectedValue(new Error('Browser not found')),
    });

    await expect(
      runInteractiveSession(db, { targetUrl: 'http://localhost:3000' }, {}, deps),
    ).rejects.toThrow('Browser not found');

    // Report server was started before browser, so it should be cleaned up
    expect(deps.startReportServer).toHaveBeenCalled();
  });

  it('sets session status to failed on error', async () => {
    const deps = createTestDeps({
      launchBrowser: vi.fn().mockRejectedValue(new Error('Launch failed')),
    });

    let sessionId: string | undefined;
    try {
      await runInteractiveSession(
        db,
        { targetUrl: 'http://localhost:3000' },
        {
          onProgress: (msg) => {
            const match = msg.match(/Session created: (.+)/);
            if (match) sessionId = match[1];
          },
        },
        deps,
      );
    } catch {
      // expected
    }

    expect(sessionId).toBeDefined();
    const session = getSession(db, sessionId!);
    expect(session!.status).toBe('failed');
  });

  it('handles error in new page setup gracefully', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    let setupCallCount = 0;
    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
      // Fail on the second page setup (new tab)
      setupViolationListener: vi.fn().mockImplementation(() => {
        setupCallCount++;
        if (setupCallCount > 1) {
          throw new Error('Listener setup failed');
        }
        return Promise.resolve();
      }),
    });

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Trigger new page event
    const contextOnCalls = mockBrowser._mockContext.on.mock.calls;
    const pageHandler = contextOnCalls.find(
      (c: unknown[]) => c[0] === 'page',
    )?.[1] as EventHandler | undefined;

    const newPage = createMockPage();
    newPage.url = vi.fn().mockReturnValue('http://localhost:3000/error-page');

    // Should not throw — error is caught and logged
    await Promise.resolve(pageHandler?.(newPage));

    disconnectHandler!();
    const result = await promise;
    expect(result.session.status).toBe('complete');

    stderrWrite.mockRestore();
  });

  it('uses local mode for remote HTTPS URLs', async () => {
    const deps = createAutoDisconnectDeps();

    const result = await runInteractiveSession(
      db,
      { targetUrl: 'https://example.com' },
      {},
      deps,
    );

    expect(result.session.mode).toBe('local');
  });

  it('tracks page navigations via the load event handler', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    const progressMessages: string[] = [];

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      { onProgress: (msg) => progressMessages.push(msg) },
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Get the initial page and find the event handlers
    const mockPage = mockBrowser._mockContext._mockPage;
    const framenavHandlers = mockPage._eventHandlers.get('framenavigated');
    const loadHandlers = mockPage._eventHandlers.get('load');
    expect(framenavHandlers).toBeDefined();
    expect(loadHandlers).toBeDefined();

    // Simulate page navigation to a real URL.
    // framenavigated fires first (creates/looks up the page record),
    // then load fires (triggers progress callback + inline hash extraction).
    mockPage.url.mockReturnValue('http://localhost:3000/dashboard');
    const mainFrame = mockPage.mainFrame();
    framenavHandlers![0]!(mainFrame);
    loadHandlers![0]!();

    // Verify the page was recorded in the DB
    const session = (await db.prepare('SELECT id FROM sessions LIMIT 1').get()) as { id: string };
    const pages = getPages(db, session.id);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages.some((p) => p.url === 'http://localhost:3000/dashboard')).toBe(true);

    // Verify progress callback was called
    expect(progressMessages).toContainEqual('Visited: http://localhost:3000/dashboard');

    disconnectHandler!();
    await promise;
  });

  it('load handler skips about:blank pages', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
    });

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Get the load handler
    const mockPage = mockBrowser._mockContext._mockPage;
    const loadHandlers = mockPage._eventHandlers.get('load');
    expect(loadHandlers).toBeDefined();

    // Simulate about:blank load (should be skipped)
    mockPage.url.mockReturnValue('about:blank');
    loadHandlers![0]!();

    const session = (await db.prepare('SELECT id FROM sessions LIMIT 1').get()) as { id: string };
    const pages = getPages(db, session.id);
    expect(pages).toHaveLength(0);

    disconnectHandler!();
    await promise;
  });

  it('extracts inline hashes on page load', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const extractSpy = vi.fn().mockResolvedValue(0);
    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
      extractInlineHashes: extractSpy,
    });

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    // Trigger framenavigated first (creates page record), then load
    const mockPage = mockBrowser._mockContext._mockPage;
    const framenavHandlers = mockPage._eventHandlers.get('framenavigated');
    const loadHandlers = mockPage._eventHandlers.get('load');
    mockPage.url.mockReturnValue('http://localhost:3000/page');
    const mainFrame = mockPage.mainFrame();
    framenavHandlers![0]!(mainFrame);
    loadHandlers![0]!();

    // Allow the async extractor call to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(extractSpy).toHaveBeenCalled();
    const session = (await db.prepare('SELECT id FROM sessions LIMIT 1').get()) as { id: string };
    expect(extractSpy).toHaveBeenCalledWith(
      mockPage,
      db,
      session.id,
      expect.any(String),
    );

    disconnectHandler!();
    await promise;
  });

  it('does not fail the session if inline hash extraction throws', async () => {
    const mockBrowser = createMockBrowser();
    let disconnectHandler: EventHandler | null = null;

    mockBrowser.on = vi.fn().mockImplementation((event: string, handler: EventHandler) => {
      if (event === 'disconnected') {
        disconnectHandler = handler;
      }
    });

    const deps = createTestDeps({
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      createAuthenticatedContext: vi.fn().mockResolvedValue({
        context: mockBrowser._mockContext,
      }),
      extractInlineHashes: vi.fn().mockRejectedValue(new Error('extractor crashed')),
    });

    const promise = runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    await new Promise((r) => setTimeout(r, 10));

    const mockPage = mockBrowser._mockContext._mockPage;
    const loadHandlers = mockPage._eventHandlers.get('load');
    mockPage.url.mockReturnValue('http://localhost:3000/page');
    loadHandlers![0]!();

    await new Promise((r) => setTimeout(r, 10));

    disconnectHandler!();
    const result = await promise;
    expect(result.session.status).toBe('complete');
  });

  it('exports storage state when saveStorageStatePath is provided', async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const os = await import('node:os');
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'csp-test-'));
    const statePath = join(tmpDir, 'auth.json');

    const mockStorageState = { cookies: [{ name: 'session', value: 'abc' }], origins: [] };
    const deps = createAutoDisconnectDeps();
    // Override storageState to return mock data
    const mockBrowser = await deps.launchBrowser({ headless: false });
    const mockCtx = await mockBrowser.newContext();
    (mockCtx.storageState as ReturnType<typeof vi.fn>).mockResolvedValue(mockStorageState);

    const result = await runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      { saveStorageStatePath: statePath },
      deps,
    );

    expect(result.storageStatePath).toBe(statePath);
    expect(existsSync(statePath)).toBe(true);
    const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(saved.cookies).toEqual([{ name: 'session', value: 'abc' }]);

    // Cleanup
    const { rmSync } = await import('node:fs');
    rmSync(tmpDir, { recursive: true });
  });

  it('returns undefined storageStatePath when not requested', async () => {
    const deps = createAutoDisconnectDeps();

    const result = await runInteractiveSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      {},
      deps,
    );

    expect(result.storageStatePath).toBeUndefined();
  });
});
