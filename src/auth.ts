import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './utils/logger.js';
import type { CookieParam } from './types.js';

const logger = createLogger();

// ── Lightweight Playwright interfaces ────────────────────────────────────

/** Minimal representation of Playwright's StorageState object. */
export interface StorageStateObject {
  cookies: Array<Record<string, unknown>>;
  origins?: Array<Record<string, unknown>>;
}

export interface PlaywrightBrowserContext {
  addCookies(cookies: PlaywrightCookie[]): Promise<void>;
  storageState(options?: { path?: string }): Promise<StorageStateObject>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(options?: {
    storageState?: string | StorageStateObject;
  }): Promise<PlaywrightBrowserContext>;
  newPage(): Promise<PlaywrightBrowserPage>;
}

export interface PlaywrightBrowserPage {
  goto(url: string): Promise<void>;
  waitForEvent(event: string): Promise<void>;
  close(): Promise<void>;
  context(): PlaywrightBrowserContext;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

// ── Auth options ─────────────────────────────────────────────────────────

export interface AuthOptions {
  storageStatePath?: string;
  cookies?: CookieParam[];
  manualLogin?: boolean;
  /** Whether the browser is running in headless mode. Used to prevent manual login in headless mode. */
  headless?: boolean;
}

/**
 * Validates a storageStatePath: resolves it through symlinks, checks .json extension,
 * and verifies it exists. Uses fs.realpathSync() to prevent symlink-based path traversal.
 * Throws a descriptive error for invalid paths.
 */
export function validateStorageStatePath(storageStatePath: string): string {
  const resolved = path.resolve(storageStatePath);

  if (!resolved.endsWith('.json')) {
    throw new Error(`Invalid storageStatePath: must have .json extension (got "${resolved}")`);
  }

  if (!fs.existsSync(resolved)) {
    throw new Error(`Invalid storageStatePath: file does not exist ("${resolved}")`);
  }

  // Resolve symlinks to get the real path — prevents symlink-based traversal
  const realPath = fs.realpathSync(resolved);

  if (!realPath.endsWith('.json')) {
    throw new Error(
      `Invalid storageStatePath: symlink target must have .json extension (got "${realPath}")`,
    );
  }

  return realPath;
}

// ── Cookie validation (RFC 6265) ─────────────────────────────────────────

/**
 * Validates a cookie name per RFC 6265 §4.1.1.
 * Cookie names must be valid HTTP tokens: no CTLs, spaces, tabs, or separators.
 */
const INVALID_COOKIE_NAME = /[\x00-\x1f\x7f\s"(),/:;<=>?@[\\\]{}]/;

/**
 * Validates a cookie value per RFC 6265 §4.1.1.
 * Values must not contain CTLs, semicolons, spaces, double quotes, commas, or backslashes.
 */
const INVALID_COOKIE_VALUE = /[\x00-\x1f\x7f;"\\ ,]/;

export function validateCookieParam(cookie: CookieParam): void {
  if (!cookie.name || INVALID_COOKIE_NAME.test(cookie.name)) {
    throw new Error(
      `Invalid cookie name: "${cookie.name}" — must be a valid HTTP token (RFC 6265)`,
    );
  }
  if (INVALID_COOKIE_VALUE.test(cookie.value)) {
    throw new Error(
      `Invalid cookie value for "${cookie.name}" — contains disallowed characters (RFC 6265)`,
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Creates an authenticated browser context based on the provided auth options.
 *
 * - storageStatePath: restores a previously saved session
 * - cookies: injects cookies into a fresh context
 * - manualLogin: opens a headed browser for interactive login, then exports state
 * - No auth: creates a plain context
 */
export async function createAuthenticatedContext(
  browser: PlaywrightBrowser,
  targetUrl: string,
  auth?: AuthOptions,
): Promise<{ context: PlaywrightBrowserContext; storageState?: string | StorageStateObject }> {
  if (!auth || (!auth.storageStatePath && !auth.cookies && !auth.manualLogin)) {
    logger.info('Creating unauthenticated browser context');
    const context = await browser.newContext();
    return { context };
  }

  if (auth.storageStatePath) {
    const resolvedPath = validateStorageStatePath(auth.storageStatePath);
    logger.info('Creating context from storage state', { path: resolvedPath });
    const context = await browser.newContext({ storageState: resolvedPath });
    return { context, storageState: resolvedPath };
  }

  if (auth.cookies) {
    logger.info('Creating context with injected cookies', { count: auth.cookies.length });
    for (const cookie of auth.cookies) {
      validateCookieParam(cookie);
    }
    const context = await browser.newContext();
    const hostname = extractHostname(targetUrl);
    const playwrightCookies = mapCookies(auth.cookies, hostname);
    await context.addCookies(playwrightCookies);
    return { context };
  }

  // manualLogin
  if (auth.headless !== false) {
    throw new Error(
      'Manual login requires headed mode (headless: false). The browser must be visible for user interaction.',
    );
  }
  logger.info('Manual login requested — waiting for user interaction');
  const storageState = await performManualLogin(browser, targetUrl);
  const context = await browser.newContext({ storageState });
  return { context, storageState };
}

/**
 * Opens a headed browser page for manual login.
 * Navigates to the target URL and waits for the page to close.
 * Returns the storage state object (compatible with browser.newContext).
 */
export async function performManualLogin(
  browser: PlaywrightBrowser,
  targetUrl: string,
): Promise<StorageStateObject> {
  const page = await browser.newPage();
  await page.goto(targetUrl);
  logger.info('Waiting for manual login — close the page when done');
  await page.waitForEvent('close');
  const storageState = await page.context().storageState();
  return storageState;
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Extracts the hostname from a URL string.
 */
export function extractHostname(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname;
}

/**
 * Maps CookieParam[] to Playwright's cookie format,
 * defaulting domain to the target URL's hostname.
 */
export function mapCookies(cookies: CookieParam[], defaultDomain: string): PlaywrightCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain ?? defaultDomain,
    path: c.path ?? '/',
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}
