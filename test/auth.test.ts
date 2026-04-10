import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createAuthenticatedContext,
  performManualLogin,
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
    storageState: vi.fn<PlaywrightBrowserContext['storageState']>().mockResolvedValue({ cookies: [] }),
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

function createMockPage(context?: PlaywrightBrowserContext): PlaywrightBrowserPage {
  const ctx = context ?? createMockContext();
  return {
    goto: vi.fn<PlaywrightBrowserPage['goto']>().mockResolvedValue(undefined),
    waitForEvent: vi.fn<PlaywrightBrowserPage['waitForEvent']>().mockResolvedValue(undefined),
    close: vi.fn<PlaywrightBrowserPage['close']>().mockResolvedValue(undefined),
    context: vi.fn<PlaywrightBrowserPage['context']>().mockReturnValue(ctx),
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns resolved path for a valid .json file', () => {
    const filePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(filePath, '{}');

    expect(validateStorageStatePath(filePath)).toBe(filePath);
  });

  it('resolves relative paths', () => {
    const filePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(filePath, '{}');

    // Use a relative path that resolves to the same location
    const result = validateStorageStatePath(filePath);
    expect(path.isAbsolute(result)).toBe(true);
  });

  it('throws if file does not have .json extension', () => {
    const filePath = path.join(tempDir, 'state.txt');
    fs.writeFileSync(filePath, '{}');

    expect(() => validateStorageStatePath(filePath)).toThrow('.json extension');
  });

  it('throws if file does not exist', () => {
    const filePath = path.join(tempDir, 'nonexistent.json');

    expect(() => validateStorageStatePath(filePath)).toThrow('does not exist');
  });

  it('throws for path traversal attempts with non-.json result', () => {
    expect(() => validateStorageStatePath('/etc/passwd')).toThrow('.json extension');
  });
});

// ── createAuthenticatedContext ────────────────────────────────────────────

describe('createAuthenticatedContext', () => {
  const targetUrl = 'https://example.com';
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-ctx-test-'));
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

  it('passes proxy server to browser context in MITM mode', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);

    const result = await createAuthenticatedContext(browser, targetUrl, {
      proxyServer: 'http://127.0.0.1:8080',
    });

    expect(browser.newContext).toHaveBeenCalledWith({ proxy: { server: 'http://127.0.0.1:8080' }, ignoreHTTPSErrors: true });
    expect(result.context).toBe(ctx);
  });

  it('passes proxy server with storageStatePath', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);
    const statePath = path.join(tempDir, 'state.json');
    fs.writeFileSync(statePath, '{}');

    await createAuthenticatedContext(browser, targetUrl, {
      storageStatePath: statePath,
      proxyServer: 'http://127.0.0.1:8080',
    });

    expect(browser.newContext).toHaveBeenCalledWith({
      storageState: statePath,
      proxy: { server: 'http://127.0.0.1:8080' },
      ignoreHTTPSErrors: true,
    });
  });

  it('passes proxy server with cookies', async () => {
    const ctx = createMockContext();
    const browser = createMockBrowser(ctx);

    await createAuthenticatedContext(browser, targetUrl, {
      cookies: [{ name: 'session', value: 'abc' }],
      proxyServer: 'http://127.0.0.1:8080',
    });

    expect(browser.newContext).toHaveBeenCalledWith({ proxy: { server: 'http://127.0.0.1:8080' }, ignoreHTTPSErrors: true });
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
    expect(browser.newContext).toHaveBeenCalledWith({ storageState: storageStateObj });
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
});
