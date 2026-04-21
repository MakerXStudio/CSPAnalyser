import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createAuthenticatedContext,
  performManualLogin,
  captureSessionStorage,
  restoreSessionStorage,
  extractHostname,
  mapCookies,
  validateStorageStatePath,
  validateCookieParam,
  type PlaywrightBrowser,
  type PlaywrightBrowserContext,
  type PlaywrightBrowserPage,
  type StorageStateObject,
} from '../src/auth.js';
import type { CookieParam } from '../src/types.js';

// ── Mock factories ───────────────────────────────────────────────────────

function createMockContext(overrides?: Partial<PlaywrightBrowserContext>): PlaywrightBrowserContext {
  return {
    addCookies: vi.fn<PlaywrightBrowserContext['addCookies']>().mockResolvedValue(undefined),
    addInitScript: vi.fn<PlaywrightBrowserContext['addInitScript']>().mockResolvedValue(undefined),
    storageState: vi.fn<PlaywrightBrowserContext['storageState']>().mockResolvedValue({ cookies: [] }),
    pages: vi.fn<PlaywrightBrowserContext['pages']>().mockReturnValue([]),
    newPage: vi.fn<PlaywrightBrowserContext['newPage']>().mockImplementation(async () => createMockPage()),
    close: vi.fn<PlaywrightBrowserContext['close']>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createMockBrowser(context?: PlaywrightBrowserContext): PlaywrightBrowser {
  const ctx = context ?? createMockContext();
  return {
    newContext: vi.fn<PlaywrightBrowser['newContext']>().mockResolvedValue(ctx),
    newPage: vi.fn<PlaywrightBrowser['newPage']>().mockResolvedValue(createMockPage(ctx)),
  };
}

function createMockPage(context?: PlaywrightBrowserContext, pageUrl = 'about:blank'): PlaywrightBrowserPage {
  const ctx = context ?? createMockContext();
  return {
    goto: vi.fn<PlaywrightBrowserPage['goto']>().mockResolvedValue(undefined),
    waitForEvent: vi.fn<PlaywrightBrowserPage['waitForEvent']>().mockResolvedValue(undefined),
    close: vi.fn<PlaywrightBrowserPage['close']>().mockResolvedValue(undefined),
    context: vi.fn<PlaywrightBrowserPage['context']>().mockReturnValue(ctx),
    url: vi.fn().mockReturnValue(pageUrl),
    on: vi.fn(),
    evaluate: vi.fn().mockResolvedValue([]),
    exposeFunction: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
  };
}

// ── extractHostname ──────────────────────────────────────────────────────

describe('extractHostname', () => {
  it('extracts hostname from https URL', () => {
    expect(extractHostname('https://example.com/path')).toBe('example.com');
  });

  it('extracts hostname from http URL with port', () => {
    expect(extractHostname('http://localhost:3000/path')).toBe('localhost');
  });

  it('extracts hostname from URL with subdomain', () => {
    expect(extractHostname('https://app.staging.example.com')).toBe('app.staging.example.com');
  });

  it('throws on invalid URL', () => {
    expect(() => extractHostname('not-a-url')).toThrow();
  });
});

// ── mapCookies ───────────────────────────────────────────────────────────

describe('mapCookies', () => {
  it('maps cookies with all fields', () => {
    const cookies: CookieParam[] = [
      {
        name: 'session',
        value: 'abc123',
        domain: '.example.com',
        path: '/app',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      },
    ];

    const result = mapCookies(cookies, 'fallback.com');

    expect(result).toEqual([
      {
        name: 'session',
        value: 'abc123',
        domain: '.example.com',
        path: '/app',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      },
    ]);
  });

  it('defaults domain to provided hostname', () => {
    const cookies: CookieParam[] = [{ name: 'token', value: 'xyz' }];

    const result = mapCookies(cookies, 'example.com');

    expect(result[0].domain).toBe('example.com');
  });

  it('defaults path to /', () => {
    const cookies: CookieParam[] = [{ name: 'token', value: 'xyz' }];

    const result = mapCookies(cookies, 'example.com');

    expect(result[0].path).toBe('/');
  });

  it('handles empty cookie array', () => {
    expect(mapCookies([], 'example.com')).toEqual([]);
  });
});

// ── validateCookieParam ─────────────────────────────────────────────────

describe('validateCookieParam', () => {
  it('accepts valid cookie name and value', () => {
    expect(() => validateCookieParam({ name: 'session_id', value: 'abc123' })).not.toThrow();
  });

  it('accepts cookie values with typical characters', () => {
    expect(() => validateCookieParam({ name: 'token', value: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiMSJ9.abc' })).not.toThrow();
  });

  it('rejects empty cookie name', () => {
    expect(() => validateCookieParam({ name: '', value: 'ok' })).toThrow('Invalid cookie name');
  });

  it('rejects cookie name with semicolons', () => {
    expect(() => validateCookieParam({ name: 'bad;name', value: 'ok' })).toThrow('Invalid cookie name');
  });

  it('rejects cookie name with spaces', () => {
    expect(() => validateCookieParam({ name: 'bad name', value: 'ok' })).toThrow('Invalid cookie name');
  });

  it('rejects cookie name with control characters', () => {
    expect(() => validateCookieParam({ name: 'bad\x00name', value: 'ok' })).toThrow('Invalid cookie name');
  });

  it('rejects cookie value with semicolons', () => {
    expect(() => validateCookieParam({ name: 'ok', value: 'bad;value' })).toThrow('Invalid cookie value');
  });

  it('rejects cookie value with control characters', () => {
    expect(() => validateCookieParam({ name: 'ok', value: 'bad\x01value' })).toThrow('Invalid cookie value');
  });
});

// ── validateStorageStatePath ─────────────────────────────────────────────

describe('validateStorageStatePath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-')));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns resolved path for a valid .json file in an allowed directory', () => {
    const filePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(filePath, '{}');

    expect(validateStorageStatePath(filePath, [tempDir])).toBe(filePath);
  });

  it('resolves relative paths', () => {
    const filePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(filePath, '{}');

    const result = validateStorageStatePath(filePath, [tempDir]);
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('throws if file does not have .json extension', () => {
    const filePath = path.join(tempDir, 'state.txt');
    fs.writeFileSync(filePath, '{}');

    expect(() => validateStorageStatePath(filePath, [tempDir])).toThrow('.json extension');
  });

  it('throws if file does not exist', () => {
    const filePath = path.join(tempDir, 'nonexistent.json');

    expect(() => validateStorageStatePath(filePath, [tempDir])).toThrow('does not exist');
  });

  it('throws for path traversal attempts with non-.json result', () => {
    expect(() => validateStorageStatePath('/etc/passwd', [tempDir])).toThrow('.json extension');
  });

  it('throws if file is outside all allowed directories', () => {
    const filePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(filePath, '{}');

    const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-other-')));
    try {
      expect(() => validateStorageStatePath(filePath, [otherDir])).toThrow(
        'must be within the current working directory',
      );
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('allows file in any of multiple allowed directories', () => {
    const filePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(filePath, '{}');

    const otherDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auth-other-')));
    try {
      expect(validateStorageStatePath(filePath, [otherDir, tempDir])).toBe(filePath);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ── createAuthenticatedContext ────────────────────────────────────────────

describe('createAuthenticatedContext', () => {
  const targetUrl = 'https://example.com';
  let tempDir: string;

  beforeEach(() => {
    // Create temp dir under CWD so storage state files pass directory containment checks
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(process.cwd(), '.tmp-auth-ctx-test-')));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates unauthenticated context when no auth options', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);

    const result = await createAuthenticatedContext(browser, targetUrl);

    expect(browser.newContext).toHaveBeenCalledWith({});
    expect(result.context).toBe(ctx);
    expect(result.storageState).toBeUndefined();
  });

  it('creates unauthenticated context when auth is undefined', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);

    const result = await createAuthenticatedContext(browser, targetUrl, undefined);

    expect(browser.newContext).toHaveBeenCalledWith({});
    expect(result.context).toBe(ctx);
  });

  it('creates unauthenticated context when auth options are all falsy', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);

    const result = await createAuthenticatedContext(browser, targetUrl, {});

    expect(browser.newContext).toHaveBeenCalledWith({});
    expect(result.context).toBe(ctx);
  });

  it('passes viewport: null in headed mode so the page follows the window size', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);

    await createAuthenticatedContext(browser, targetUrl, { headless: false });

    expect(browser.newContext).toHaveBeenCalledWith({ viewport: null });
  });

  it('uses storageStatePath when provided', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(statePath, '{}');

    const result = await createAuthenticatedContext(browser, targetUrl, {
      storageStatePath: statePath,
    });

    expect(browser.newContext).toHaveBeenCalledWith({ storageState: statePath });
    expect(result.storageState).toBe(statePath);
  });

  it('injects cookies when provided', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);
    const cookies: CookieParam[] = [
      { name: 'session', value: 'abc' },
      { name: 'token', value: 'xyz', domain: '.custom.com' },
    ];

    const result = await createAuthenticatedContext(browser, targetUrl, { cookies });

    expect(browser.newContext).toHaveBeenCalledWith({});
    expect(ctx.addCookies).toHaveBeenCalledWith([
      { name: 'session', value: 'abc', domain: 'example.com', path: '/', httpOnly: undefined, secure: undefined, sameSite: undefined },
      { name: 'token', value: 'xyz', domain: '.custom.com', path: '/', httpOnly: undefined, secure: undefined, sameSite: undefined },
    ]);
    expect(result.context).toBe(ctx);
    expect(result.storageState).toBeUndefined();
  });

  it('prefers storageStatePath over cookies', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(statePath, '{}');

    const result = await createAuthenticatedContext(browser, targetUrl, {
      storageStatePath: statePath,
      cookies: [{ name: 'session', value: 'abc' }],
    });

    expect(browser.newContext).toHaveBeenCalledWith({ storageState: statePath });
    expect(ctx.addCookies).not.toHaveBeenCalled();
    expect(result.storageState).toBe(statePath);
  });

  it('throws for invalid storageStatePath', async () => {
    const browser = createMockBrowser();

    await expect(
      createAuthenticatedContext(browser, targetUrl, {
        storageStatePath: '/nonexistent/state.json',
      }),
    ).rejects.toThrow('does not exist');
  });

  it('throws for storageStatePath without .json extension', async () => {
    const browser = createMockBrowser();
    const badPath = path.join(tempDir, 'state.txt');
    fs.writeFileSync(badPath, '{}');

    await expect(
      createAuthenticatedContext(browser, targetUrl, {
        storageStatePath: badPath,
      }),
    ).rejects.toThrow('.json extension');
  });

  it('handles manual login flow with headed mode', async () => {
    const storageStateObj: StorageStateObject = { cookies: [{ name: 'auth', value: 'ok' }] };
    const ctx = createMockContext({
      storageState: vi.fn<PlaywrightBrowserContext['storageState']>().mockResolvedValue(storageStateObj),
    });
    const browser = createMockBrowser(ctx);

    const result = await createAuthenticatedContext(browser, targetUrl, {
      manualLogin: true,
      headless: false,
    });

    // Should have opened a new page
    expect(browser.newPage).toHaveBeenCalled();
    // Should have created a context from the exported storage state object
    expect(browser.newContext).toHaveBeenCalledWith({ viewport: null, storageState: storageStateObj });
    expect(result.storageState).toBe(storageStateObj);
  });

  it('throws when manual login requested without explicit headed mode', async () => {
    const browser = createMockBrowser();

    await expect(
      createAuthenticatedContext(browser, targetUrl, { manualLogin: true }),
    ).rejects.toThrow('headed mode');
  });

  it('throws when manual login requested with headless: true', async () => {
    const browser = createMockBrowser();

    await expect(
      createAuthenticatedContext(browser, targetUrl, { manualLogin: true, headless: true }),
    ).rejects.toThrow('headed mode');
  });

  it('rejects cookies with invalid names', async () => {
    const browser = createMockBrowser();

    await expect(
      createAuthenticatedContext(browser, targetUrl, {
        cookies: [{ name: 'bad;name', value: 'ok' }],
      }),
    ).rejects.toThrow('Invalid cookie name');
  });
});

// ── performManualLogin ───────────────────────────────────────────────────

describe('performManualLogin', () => {
  it('navigates to target URL and waits for page close', async () => {
    const storageStateObj: StorageStateObject = { cookies: [] };
    const ctx = createMockContext({
      storageState: vi.fn<PlaywrightBrowserContext['storageState']>().mockResolvedValue(storageStateObj),
    });
    const page = createMockPage(ctx);
    const browser: PlaywrightBrowser = {
      newContext: vi.fn<PlaywrightBrowser['newContext']>().mockResolvedValue(ctx),
      newPage: vi.fn<PlaywrightBrowser['newPage']>().mockResolvedValue(page),
    };

    const result = await performManualLogin(browser, 'https://app.example.com/login');

    expect(page.goto).toHaveBeenCalledWith('https://app.example.com/login');
    expect(page.waitForEvent).toHaveBeenCalledWith('close');
    expect(ctx.storageState).toHaveBeenCalled();
    expect(result).toBe(storageStateObj);
  });

  it('sets up exposeFunction for sessionStorage capture', async () => {
    const storageStateObj: StorageStateObject = {
      cookies: [],
      origins: [{ origin: 'https://app.example.com', localStorage: [] }],
    };
    const ctx = createMockContext({
      storageState: vi.fn<PlaywrightBrowserContext['storageState']>().mockResolvedValue(storageStateObj),
      pages: vi.fn().mockReturnValue([]),
    });
    const page = createMockPage(ctx, 'https://app.example.com/');
    const browser: PlaywrightBrowser = {
      newContext: vi.fn<PlaywrightBrowser['newContext']>().mockResolvedValue(ctx),
      newPage: vi.fn<PlaywrightBrowser['newPage']>().mockResolvedValue(page),
    };

    await performManualLogin(browser, 'https://app.example.com/');

    // exposeFunction should be called with '__cspReportSessionStorage'
    expect(page.exposeFunction).toHaveBeenCalledWith(
      '__cspReportSessionStorage',
      expect.any(Function),
    );

    // addInitScript (not evaluate) should be called to install the
    // beforeunload handler — addInitScript survives navigation,
    // evaluate does not
    expect(page.addInitScript).toHaveBeenCalled();
  });

  it('merges sessionStorage captured via exposeFunction into returned state', async () => {
    const storageStateObj: StorageStateObject = {
      cookies: [],
      origins: [{ origin: 'https://app.example.com', localStorage: [] }],
    };
    const ctx = createMockContext({
      storageState: vi.fn<PlaywrightBrowserContext['storageState']>().mockResolvedValue(storageStateObj),
      pages: vi.fn().mockReturnValue([]),
    });
    const page = createMockPage(ctx, 'https://app.example.com/');

    // When exposeFunction is called, capture the callback so we can simulate
    // the browser calling it (as beforeunload would)
    let reportCallback: (origin: unknown, json: unknown) => void = () => {};
    (page.exposeFunction as ReturnType<typeof vi.fn>).mockImplementation(
      async (_name: string, cb: (...args: unknown[]) => unknown) => {
        reportCallback = cb as (origin: unknown, json: unknown) => void;
      },
    );

    const browser: PlaywrightBrowser = {
      newContext: vi.fn<PlaywrightBrowser['newContext']>().mockResolvedValue(ctx),
      newPage: vi.fn<PlaywrightBrowser['newPage']>().mockResolvedValue(page),
    };

    // Simulate the browser calling the exposed function during the login flow
    // We need to do this before waitForEvent resolves, so hook into goto
    (page.goto as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Simulate beforeunload firing and reporting sessionStorage
      reportCallback(
        'https://app.example.com',
        JSON.stringify([
          { name: 'msal.token', value: 'abc123' },
          { name: 'msal.idtoken', value: 'def456' },
        ]),
      );
    });

    const result = await performManualLogin(browser, 'https://app.example.com/');

    // sessionStorage should be merged into the returned state
    const appOrigin = result.origins?.find((o) => o.origin === 'https://app.example.com');
    expect(appOrigin).toBeDefined();
    expect(appOrigin!.sessionStorage).toHaveLength(2);
    expect(appOrigin!.sessionStorage![0].name).toBe('msal.token');
  });
});

// ── captureSessionStorage ──────────────────────────────────────────────

describe('captureSessionStorage', () => {
  it('captures sessionStorage from pages and merges into state', async () => {
    const page = createMockPage(undefined, 'https://app.example.com/dashboard');
    (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'msal.token', value: 'abc123' },
      { name: 'msal.idtoken', value: 'def456' },
    ]);

    const state: StorageStateObject = {
      cookies: [],
      origins: [{ origin: 'https://app.example.com', localStorage: [] }],
    };

    const result = await captureSessionStorage([page], state);

    expect(result.origins).toHaveLength(1);
    const origin = result.origins![0];
    expect(origin.origin).toBe('https://app.example.com');
    expect(origin.sessionStorage).toHaveLength(2);
    expect(origin.sessionStorage![0].name).toBe('msal.token');
  });

  it('returns state unchanged when no pages have sessionStorage', async () => {
    const page = createMockPage(undefined, 'https://app.example.com/');
    (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const state: StorageStateObject = { cookies: [{ name: 'a' }] };
    const result = await captureSessionStorage([page], state);

    expect(result).toBe(state); // Same reference, no modification
  });

  it('handles about:blank pages', async () => {
    const page = createMockPage(undefined, 'about:blank');

    const state: StorageStateObject = { cookies: [] };
    const result = await captureSessionStorage([page], state);

    expect(result).toBe(state);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('creates new origin entry when not present in state', async () => {
    const page = createMockPage(undefined, 'https://auth.example.com/');
    (page.evaluate as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'session', value: 'xyz' },
    ]);

    const state: StorageStateObject = { cookies: [], origins: [] };
    const result = await captureSessionStorage([page], state);

    expect(result.origins).toHaveLength(1);
    expect(result.origins![0].origin).toBe('https://auth.example.com');
    expect(result.origins![0].sessionStorage).toHaveLength(1);
  });

  it('handles evaluate errors gracefully', async () => {
    const page = createMockPage(undefined, 'https://app.example.com/');
    (page.evaluate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Page closed'));

    const state: StorageStateObject = { cookies: [] };
    const result = await captureSessionStorage([page], state);

    expect(result).toBe(state);
  });
});

// ── restoreSessionStorage ──────────────────────────────────────────────

describe('restoreSessionStorage', () => {
  it('registers addInitScript for the target origin', async () => {
    const ctx = createMockContext();

    const state: StorageStateObject = {
      cookies: [],
      origins: [
        {
          origin: 'https://app.example.com',
          localStorage: [],
          sessionStorage: [
            { name: 'msal.token', value: 'abc123' },
            { name: 'msal.idtoken', value: 'def456' },
          ],
        },
      ],
    };

    const count = await restoreSessionStorage(ctx, state, 'https://app.example.com/dashboard');
    expect(count).toBe(2);
    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
    // The second argument to addInitScript is the storage map
    const storageArg = (ctx.addInitScript as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, string>;
    expect(storageArg['msal.token']).toBe('abc123');
    expect(storageArg['msal.idtoken']).toBe('def456');
  });

  it('skips origins that do not match the target', async () => {
    const ctx = createMockContext();

    const state: StorageStateObject = {
      cookies: [],
      origins: [
        {
          origin: 'https://auth.example.com',
          sessionStorage: [{ name: 'token', value: 'xyz' }],
        },
      ],
    };

    const count = await restoreSessionStorage(ctx, state, 'https://app.example.com/');
    expect(count).toBe(0);
    expect(ctx.addInitScript).not.toHaveBeenCalled();
  });

  it('compares full origin, not just hostname — different protocol is rejected', async () => {
    const ctx = createMockContext();

    const state: StorageStateObject = {
      cookies: [],
      origins: [
        {
          origin: 'http://app.example.com',
          sessionStorage: [{ name: 'token', value: 'xyz' }],
        },
      ],
    };

    // Target is https, stored origin is http — must not match
    const count = await restoreSessionStorage(ctx, state, 'https://app.example.com/');
    expect(count).toBe(0);
    expect(ctx.addInitScript).not.toHaveBeenCalled();
  });

  it('compares full origin, not just hostname — different port is rejected', async () => {
    const ctx = createMockContext();

    const state: StorageStateObject = {
      cookies: [],
      origins: [
        {
          origin: 'https://app.example.com:8443',
          sessionStorage: [{ name: 'token', value: 'xyz' }],
        },
      ],
    };

    // Target is default port, stored origin has :8443 — must not match
    const count = await restoreSessionStorage(ctx, state, 'https://app.example.com/');
    expect(count).toBe(0);
    expect(ctx.addInitScript).not.toHaveBeenCalled();
  });

  it('returns 0 when no origins have sessionStorage', async () => {
    const ctx = createMockContext();

    const state: StorageStateObject = {
      cookies: [],
      origins: [{ origin: 'https://app.example.com', localStorage: [] }],
    };

    const count = await restoreSessionStorage(ctx, state, 'https://app.example.com/');
    expect(count).toBe(0);
  });

  it('returns 0 for empty state', async () => {
    const ctx = createMockContext();
    const count = await restoreSessionStorage(ctx, { cookies: [] }, 'https://app.example.com/');
    expect(count).toBe(0);
  });
});
