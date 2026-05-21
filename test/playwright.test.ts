import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext, Page } from 'playwright';
import type { WorkerInfo } from 'playwright/test';
import {
  createCspFixtureDefinitions,
  createPlaywrightCspCapture,
  type PlaywrightCspCapture,
  type PlaywrightCspCaptureDeps,
  type PlaywrightCspCaptureOptions,
} from '../src/playwright.js';
import {
  createDatabase,
  createSession,
  getOrInsertPage,
  getPages,
  getViolations,
  insertPermissionsPolicy,
  insertPolicy,
  insertViolation,
  updateSession,
} from '../src/db/repository.js';
import { startReportServer } from '../src/report-server.js';
import { setupCspInjection } from '../src/csp-injector.js';
import { setupViolationListener } from '../src/violation-listener.js';
import { setupInlineContentObserver } from '../src/inline-content-observer.js';
import { extractInlineHashes } from '../src/inline-content-extractor.js';
import { generatePolicy } from '../src/policy-generator.js';
import { optimizePolicy } from '../src/policy-optimizer.js';
import { formatPolicy } from '../src/policy-formatter.js';
import { parsePermissionsPolicyHeaders } from '../src/permissions-policy.js';
import { extractOrigin } from '../src/utils/url-utils.js';

class FakePage {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(private currentUrl: string) {}

  url(): string {
    return this.currentUrl;
  }

  mainFrame(): { url: () => string } {
    return { url: () => this.currentUrl };
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

class FakeContext {
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(private readonly existingPages: Page[]) {}

  pages(): Page[] {
    return this.existingPages;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function makeDeps(
  order: string[],
  targetOrigins: Array<string | undefined> = [],
): Partial<PlaywrightCspCaptureDeps> {
  return {
    setupCspInjection: vi.fn(async (_page, _port, _token, _permissions, targetOrigin) => {
      order.push('route');
      targetOrigins.push(targetOrigin);
      return async () => {
        order.push('unroute');
      };
    }),
    setupViolationListener: vi.fn(async () => {
      order.push('violation-listener');
    }),
    setupInlineContentObserver: vi.fn(async () => {
      order.push('inline-observer');
    }),
    extractInlineHashes: vi.fn(async () => 0),
    startReportServer: vi.fn(async () => ({
      port: 43210,
      token: 'test-token',
      close: async () => {
        order.push('report-close');
      },
    })),
  };
}

interface DelayedDeps extends Partial<PlaywrightCspCaptureDeps> {
  routeStarted: Promise<void>;
  releaseRoute: () => void;
}

function delayedDeps(order: string[]): DelayedDeps {
  let releaseRoute: (() => void) | null = null;
  const routeGate = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  let markRouteStarted: (() => void) | null = null;
  const routeStartSignal = new Promise<void>((resolve) => {
    markRouteStarted = resolve;
  });

  return {
    setupCspInjection: vi.fn(async () => {
      order.push('route');
      markRouteStarted?.();
      await routeGate;
      return async () => {
        order.push('unroute');
      };
    }),
    setupViolationListener: vi.fn(async () => {
      order.push('violation-listener');
    }),
    setupInlineContentObserver: vi.fn(async () => {
      order.push('inline-observer');
    }),
    extractInlineHashes: vi.fn(async () => 0),
    startReportServer: vi.fn(async () => ({
      port: 43210,
      token: 'test-token',
      close: async () => {
        order.push('report-close');
      },
    })),
    generatePolicy: (db, sessionId, options) => {
      order.push('generate-policy');
      return generatePolicy(db, sessionId, options);
    },
    optimizePolicy,
    formatPolicy,
    get routeStarted() {
      return routeStartSignal;
    },
    releaseRoute: () => {
      releaseRoute?.();
    },
  };
}

async function runFixture<T>(
  fixture: (
    args: T,
    use: (value: PlaywrightCspCapture) => Promise<void>,
    workerInfo: WorkerInfo,
  ) => Promise<void>,
  args: Partial<T>,
  workerInfo: WorkerInfo,
): Promise<PlaywrightCspCapture> {
  let value: PlaywrightCspCapture | null = null;
  await fixture(
    args as T,
    async (capture) => {
      value = capture;
    },
    workerInfo,
  );
  if (!value) throw new Error('Fixture did not provide a capture');
  return value;
}

async function runValueFixture<T, R>(
  fixture: (args: T, use: (value: R) => Promise<void>) => Promise<void>,
  args: Partial<T>,
): Promise<void> {
  await fixture(args as T, async () => {});
}

function workerInfoWithBaseURL(baseURL?: string): WorkerInfo {
  return {
    workerIndex: 2,
    parallelIndex: 0,
    project: {
      name: 'chromium',
      testDir: '/tmp/tests',
      snapshotDir: '/tmp/tests',
      testIgnore: [],
      testMatch: [],
      timeout: 30_000,
      use: baseURL ? { baseURL } : {},
      dependencies: [],
      teardown: undefined,
      grep: /.*/,
      grepInvert: null,
      ignoreSnapshots: false,
      outputDir: '/tmp/playwright-output',
      repeatEach: 1,
      retries: 0,
      metadata: {},
    },
    config: {
      configFile: undefined,
      rootDir: '/tmp/tests',
      forbidOnly: false,
      fullyParallel: false,
      globalSetup: null,
      globalTeardown: null,
      globalTimeout: 0,
      grep: /.*/,
      grepInvert: null,
      maxFailures: 0,
      metadata: {},
      preserveOutput: 'always',
      projects: [],
      quiet: false,
      reporter: [],
      reportSlowTests: null,
      shard: null,
      tags: [],
      updateSnapshots: 'missing',
      updateSourceMethod: 'patch',
      version: 'test',
      workers: 1,
      webServer: null,
    },
  };
}

describe('createPlaywrightCspCapture', () => {
  it('finalizes a policy and writes a deterministic JSON artifact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-'));
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture({
      targetUrl: 'https://example.com',
      db,
      outputDir: dir,
      artifactName: 'worker-0',
      format: 'json',
    });

    insertViolation(db, {
      sessionId: capture.sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/app.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'report_uri',
    });

    const result = await capture.finalize();
    const second = await capture.finalize();

    expect(second).toBe(result);
    expect(result.artifactPath).toBe(join(dir, 'worker-0.json'));
    expect(JSON.parse(readFileSync(join(dir, 'worker-0.json'), 'utf8'))).toEqual({
      directives: {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'object-src': ["'none'"],
        'script-src': ['*.example.com'],
      },
      policyString:
        "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src *.example.com",
      isReportOnly: false,
    });

    await capture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('attaches routing before listeners and supports context pages', async () => {
    const order: string[] = [];
    const page = new FakePage('https://example.com/ready') as unknown as Page;
    const context = new FakeContext([page]) as unknown as BrowserContext;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture(
      { targetUrl: 'https://example.com', db },
      makeDeps(order),
    );

    await capture.attachToContext(context);
    await capture.close();

    expect(order.slice(0, 3)).toEqual(['route', 'violation-listener', 'inline-observer']);
    expect(getPages(db, capture.sessionId).map((storedPage) => storedPage.url)).toEqual([
      'https://example.com/ready',
    ]);
    expect(order).toContain('unroute');
    expect(order).toContain('report-close');
  });

  it('does not restrict CSP injection when targetUrl is omitted', async () => {
    const order: string[] = [];
    const targetOrigins: Array<string | undefined> = [];
    const page = new FakePage('http://127.0.0.1:5173/') as unknown as Page;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture({ db }, makeDeps(order, targetOrigins));

    await capture.attachToPage(page);
    await capture.close();

    expect(targetOrigins).toEqual([undefined]);
  });

  it('shares concurrent attachToPage calls for the same page', async () => {
    const order: string[] = [];
    const deps = delayedDeps(order);
    const page = new FakePage('https://example.com/concurrent') as unknown as Page;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture({ targetUrl: 'https://example.com', db }, deps);

    const firstAttach = capture.attachToPage(page);
    await deps.routeStarted;
    const secondAttach = capture.attachToPage(page);
    deps.releaseRoute();
    await Promise.all([firstAttach, secondAttach]);
    await capture.close();

    expect(order.filter((entry) => entry === 'route')).toHaveLength(1);
    expect(order.filter((entry) => entry === 'violation-listener')).toHaveLength(1);
    expect(order.filter((entry) => entry === 'inline-observer')).toHaveLength(1);
    expect(order.filter((entry) => entry === 'unroute')).toHaveLength(1);
  });

  it('tolerates route cleanup after Playwright has closed the page', async () => {
    const db = createDatabase(':memory:');
    const page = new FakePage('https://example.com/closed') as unknown as Page;
    const capture = createPlaywrightCspCapture(
      { targetUrl: 'https://example.com', db },
      {
        ...makeDeps([]),
        setupCspInjection: vi.fn(async () => async () => {
          throw new Error('page.unroute: Target page, context or browser has been closed');
        }),
      },
    );

    await capture.attachToPage(page);
    await expect(capture.close()).resolves.toBeUndefined();
  });

  it('attaches each context only once', async () => {
    const order: string[] = [];
    const page = new FakePage('https://example.com/context') as unknown as Page;
    const contextObject = new FakeContext([page]);
    const context = contextObject as unknown as BrowserContext;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture(
      { targetUrl: 'https://example.com', db },
      makeDeps(order),
    );

    await capture.attachToContext(context);
    await capture.attachToContext(context);
    await capture.close();

    expect(contextObject.listenerCount('page')).toBe(0);
    expect(order.filter((entry) => entry === 'route')).toHaveLength(1);
  });

  it('shares concurrent attachToContext calls for the same context', async () => {
    const order: string[] = [];
    const deps = delayedDeps(order);
    const page = new FakePage('https://example.com/context-concurrent') as unknown as Page;
    const contextObject = new FakeContext([page]);
    const context = contextObject as unknown as BrowserContext;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture({ targetUrl: 'https://example.com', db }, deps);

    const firstAttach = capture.attachToContext(context);
    await deps.routeStarted;
    const secondAttach = capture.attachToContext(context);
    deps.releaseRoute();
    await Promise.all([firstAttach, secondAttach]);

    expect(contextObject.listenerCount('page')).toBe(1);
    expect(order.filter((entry) => entry === 'route')).toHaveLength(1);
    await capture.close();
  });

  it('surfaces async page-event attachment errors from finalize', async () => {
    const order: string[] = [];
    const contextObject = new FakeContext([]);
    const context = contextObject as unknown as BrowserContext;
    const page = new FakePage('https://example.com/fail') as unknown as Page;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture(
      { targetUrl: 'https://example.com', db },
      {
        ...makeDeps(order),
        setupCspInjection: vi.fn(async () => {
          throw new Error('route failed');
        }),
      },
    );

    await capture.attachToContext(context);
    contextObject.emit('page', page);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(capture.finalize()).rejects.toThrow(
      'One or more Playwright page attachments failed',
    );
    await capture.close();
  });

  it('waits for page-event attachment before finalizing policy', async () => {
    const order: string[] = [];
    const deps = delayedDeps(order);
    const contextObject = new FakeContext([]);
    const context = contextObject as unknown as BrowserContext;
    const page = new FakePage('https://example.com/popup') as unknown as Page;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture({ targetUrl: 'https://example.com', db }, deps);

    await capture.attachToContext(context);
    contextObject.emit('page', page);
    await deps.routeStarted;
    const finalizePromise = capture.finalize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).not.toContain('generate-policy');
    deps.releaseRoute();
    await finalizePromise;
    await capture.close();

    expect(order).toEqual(
      expect.arrayContaining(['route', 'violation-listener', 'inline-observer', 'generate-policy']),
    );
    expect(order.indexOf('inline-observer')).toBeLessThan(order.indexOf('generate-policy'));
  });

  it('waits for load-triggered hash extraction before generating policy', async () => {
    const order: string[] = [];
    let releaseExtraction: () => void = () => {
      throw new Error('Extraction gate was not initialized');
    };
    const extractionGate = new Promise<void>((resolve) => {
      releaseExtraction = resolve;
    });
    const page = new FakePage('https://example.com/loaded') as unknown as Page;
    const db = createDatabase(':memory:');
    let extractionCount = 0;
    const capture = createPlaywrightCspCapture(
      { targetUrl: 'https://example.com', db },
      {
        ...makeDeps(order),
        extractInlineHashes: vi.fn(async () => {
          extractionCount++;
          if (extractionCount === 1) {
            order.push('load-extract-start');
            await extractionGate;
            order.push('load-extract-end');
          } else {
            order.push('final-extract');
          }
          return 0;
        }),
        generatePolicy: (database, sessionId, options) => {
          order.push('generate-policy');
          return generatePolicy(database, sessionId, options);
        },
      },
    );

    await capture.attachToPage(page);
    (page as unknown as FakePage).emit('load');
    const finalizePromise = capture.finalize();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(order).toContain('load-extract-start');
    expect(order).not.toContain('generate-policy');
    releaseExtraction();
    await finalizePromise;
    await capture.close();

    expect(order.indexOf('load-extract-end')).toBeLessThan(order.indexOf('generate-policy'));
  });

  it('fails finalize when load-triggered hash extraction fails', async () => {
    const order: string[] = [];
    const page = new FakePage('https://example.com/extract-fail') as unknown as Page;
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture(
      { targetUrl: 'https://example.com', db },
      {
        ...makeDeps(order),
        extractInlineHashes: vi.fn(async () => {
          throw new Error('extract failed');
        }),
      },
    );

    await capture.attachToPage(page);
    (page as unknown as FakePage).emit('load');

    await expect(capture.finalize()).rejects.toThrow('One or more inline hash extractions failed');
    await capture.close();
  });

  it('rejects unsafe artifactName values when using outputDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'csp-playwright-'));
    const db = createDatabase(':memory:');
    const capture = createPlaywrightCspCapture({
      targetUrl: 'https://example.com',
      db,
      outputDir: dir,
      artifactName: '../outside',
    });

    await expect(capture.finalize()).rejects.toThrow('Invalid CSP artifactName');
    await capture.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('createCspFixtureDefinitions', () => {
  it('infers targetUrl from worker project baseURL', async () => {
    const createdOptions: PlaywrightCspCaptureOptions[] = [];
    const capture = {
      sessionId: 'fixture-session',
      db: createDatabase(':memory:'),
      attachToPage: vi.fn(async () => {}),
      attachToContext: vi.fn(async () => {}),
      finalize: vi.fn(async () => ({
        sessionId: 'fixture-session',
        pages: [],
        violationsFound: 0,
        directives: {},
        policy: '{}',
        artifactPath: null,
      })),
      writeArtifacts: vi.fn(async () => null),
      close: vi.fn(async () => {}),
    } satisfies PlaywrightCspCapture;
    const fixtures = createCspFixtureDefinitions({}, (options) => {
      createdOptions.push(options ?? {});
      return capture;
    });
    const workerFixture = fixtures._cspWorkerCapture;
    if (!Array.isArray(workerFixture) || typeof workerFixture[0] !== 'function') {
      throw new Error('Worker fixture shape changed');
    }

    await runFixture(
      workerFixture[0],
      { _cspWorkerCapture: capture },
      workerInfoWithBaseURL('http://127.0.0.1:3000'),
    );

    expect(createdOptions[0]?.targetUrl).toBe('http://127.0.0.1:3000');
    expect(capture.finalize).toHaveBeenCalledTimes(1);
    expect(capture.close).toHaveBeenCalledTimes(1);
  });

  it('attaches both context and page fixtures idempotently', async () => {
    const attached: string[] = [];
    const capture = {
      sessionId: 'fixture-session',
      db: createDatabase(':memory:'),
      attachToPage: vi.fn(async () => {
        attached.push('page');
      }),
      attachToContext: vi.fn(async () => {
        attached.push('context');
      }),
      finalize: vi.fn(async () => ({
        sessionId: 'fixture-session',
        pages: [],
        violationsFound: 0,
        directives: {},
        policy: '{}',
        artifactPath: null,
      })),
      writeArtifacts: vi.fn(async () => null),
      close: vi.fn(async () => {}),
    } satisfies PlaywrightCspCapture;
    const fixtures = createCspFixtureDefinitions();
    const contextFixture = fixtures.context;
    const pageFixture = fixtures.page;
    if (typeof contextFixture !== 'function' || typeof pageFixture !== 'function') {
      throw new Error('Fixture shape changed');
    }
    const context = new FakeContext([]) as unknown as BrowserContext;
    const page = new FakePage('https://example.com/') as unknown as Page;

    const runContextFixture = contextFixture as unknown as (
      args: { context: BrowserContext; cspCapture: PlaywrightCspCapture },
      use: (value: BrowserContext) => Promise<void>,
    ) => Promise<void>;
    const runPageFixture = pageFixture as unknown as (
      args: { page: Page; cspCapture: PlaywrightCspCapture },
      use: (value: Page) => Promise<void>,
    ) => Promise<void>;

    await runValueFixture(runContextFixture, { context, cspCapture: capture });
    await runValueFixture(runPageFixture, { page, cspCapture: capture });

    expect(attached).toEqual(['context', 'page']);
  });

  it('closes capture but propagates finalize failures', async () => {
    const capture = {
      sessionId: 'fixture-session',
      db: createDatabase(':memory:'),
      attachToPage: vi.fn(async () => {}),
      attachToContext: vi.fn(async () => {}),
      finalize: vi.fn(async () => {
        throw new Error('finalize failed');
      }),
      writeArtifacts: vi.fn(async () => null),
      close: vi.fn(async () => {}),
    } satisfies PlaywrightCspCapture;
    const fixtures = createCspFixtureDefinitions({}, () => capture);
    const workerFixture = fixtures._cspWorkerCapture;
    if (!Array.isArray(workerFixture) || typeof workerFixture[0] !== 'function') {
      throw new Error('Worker fixture shape changed');
    }

    await expect(
      runFixture(workerFixture[0], { _cspWorkerCapture: capture }, workerInfoWithBaseURL()),
    ).rejects.toThrow('finalize failed');
    expect(capture.close).toHaveBeenCalledTimes(1);
  });
});

describe('playwright dependency surface', () => {
  it('keeps required primitive dependencies importable for integration wiring', () => {
    expect(createDatabase).toBeTypeOf('function');
    expect(createSession).toBeTypeOf('function');
    expect(updateSession).toBeTypeOf('function');
    expect(getOrInsertPage).toBeTypeOf('function');
    expect(getViolations).toBeTypeOf('function');
    expect(insertPermissionsPolicy).toBeTypeOf('function');
    expect(insertPolicy).toBeTypeOf('function');
    expect(startReportServer).toBeTypeOf('function');
    expect(setupCspInjection).toBeTypeOf('function');
    expect(setupViolationListener).toBeTypeOf('function');
    expect(setupInlineContentObserver).toBeTypeOf('function');
    expect(extractInlineHashes).toBeTypeOf('function');
    expect(generatePolicy).toBeTypeOf('function');
    expect(optimizePolicy).toBeTypeOf('function');
    expect(formatPolicy).toBeTypeOf('function');
    expect(parsePermissionsPolicyHeaders).toBeTypeOf('function');
    expect(extractOrigin).toBeTypeOf('function');
  });
});
