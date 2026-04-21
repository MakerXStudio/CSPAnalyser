import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './utils/logger.js';
import { getDataDir } from './utils/file-utils.js';
import type { CookieParam } from './types.js';

const logger = createLogger();

// ── Lightweight Playwright interfaces ────────────────────────────────────

/** Minimal representation of Playwright's StorageState object. */
export interface StorageStateObject {
  cookies: Array<Record<string, unknown>>;
  origins?: Array<StorageStateOrigin>;
}

export interface StorageStateOrigin {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
  /** Extension: sessionStorage captured by CSP Analyser (not part of Playwright's format) */
  sessionStorage?: Array<{ name: string; value: string }>;
}

export interface PlaywrightBrowserContext {
  addCookies(cookies: PlaywrightCookie[]): Promise<void>;
  addInitScript<A>(script: ((arg: A) => void) | string, arg?: A): Promise<void>;
  storageState(options?: { path?: string }): Promise<StorageStateObject>;
  pages(): PlaywrightBrowserPage[];
  newPage(): Promise<PlaywrightBrowserPage>;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(options?: {
    storageState?: string | StorageStateObject;
    /**
     * Viewport size override. `null` disables the fixed viewport so the page
     * follows the browser window size — used in headed/interactive mode so
     * that resizing the window reflows the site.
     */
    viewport?: { width: number; height: number } | null;
  }): Promise<PlaywrightBrowserContext>;
  newPage(): Promise<PlaywrightBrowserPage>;
}

export interface PlaywrightBrowserPage {
  goto(url: string): Promise<void>;
  waitForEvent(event: string): Promise<void>;
  close(): Promise<void>;
  context(): PlaywrightBrowserContext;
  url(): string;
  on(event: string, listener: (...args: unknown[]) => void): void;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  evaluate<R>(fn: (...args: any[]) => R, ...args: unknown[]): Promise<R>;
  exposeFunction(name: string, callback: (...args: unknown[]) => unknown): Promise<void>;
  addInitScript(script: (() => void) | string): Promise<void>;
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
 * verifies it exists, and ensures it is contained within an allowed directory (CWD or
 * the CSP Analyser data directory). Uses fs.realpathSync() to prevent symlink-based
 * path traversal. Throws a descriptive error for invalid paths.
 */
export function validateStorageStatePath(
  storageStatePath: string,
  allowedDirs?: readonly string[],
): string {
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

  // Directory containment: the resolved path must be under CWD or the data directory.
  // This prevents an MCP client from reading arbitrary .json files on disk.
  const dirs = allowedDirs ?? [process.cwd(), getDataDir()];
  const isContained = dirs.some((dir) => {
    const normalizedDir = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return realPath.startsWith(normalizedDir) || realPath === dir;
  });

  if (!isContained) {
    throw new Error(
      'Invalid storageStatePath: file must be within the current working directory or the CSP Analyser data directory',
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
  // In headed/interactive mode, set viewport to null so the page follows the
  // browser window size — otherwise Playwright pins the viewport to 1280x720
  // and the site doesn't reflow when the user resizes the window.
  const baseContextOptions: { viewport?: null } =
    auth?.headless === false ? { viewport: null } : {};

  if (!auth || (!auth.storageStatePath && !auth.cookies && !auth.manualLogin)) {
    logger.info('Creating unauthenticated browser context');
    const context = await browser.newContext(baseContextOptions);
    return { context };
  }

  if (auth.storageStatePath) {
    const resolvedPath = validateStorageStatePath(auth.storageStatePath);
    logger.info('Creating context from storage state', { path: resolvedPath });
    const context = await browser.newContext({
      ...baseContextOptions,
      storageState: resolvedPath,
    });

    // Restore sessionStorage if the state file contains our extension.
    // Playwright only restores cookies + localStorage; MSAL/Azure AD B2C
    // tokens in sessionStorage are lost without this.
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf-8');
      const stateData = JSON.parse(raw) as StorageStateObject;
      const restored = await restoreSessionStorage(context, stateData, targetUrl);
      if (restored > 0) {
        logger.info('Restored sessionStorage entries from storage state', { count: restored });
      }
    } catch (err) {
      logger.debug('Could not restore sessionStorage from storage state', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { context, storageState: resolvedPath };
  }

  if (auth.cookies) {
    logger.info('Creating context with injected cookies', { count: auth.cookies.length });
    for (const cookie of auth.cookies) {
      validateCookieParam(cookie);
    }
    const context = await browser.newContext(baseContextOptions);
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
  const context = await browser.newContext({ ...baseContextOptions, storageState });

  // Restore sessionStorage captured during manual login
  const restored = await restoreSessionStorage(context, storageState, targetUrl);
  if (restored > 0) {
    logger.info('Restored sessionStorage from manual login', { count: restored });
  }

  return { context, storageState };
}

/**
 * Opens a headed browser page for manual login.
 * Navigates to the target URL and waits for the page to close.
 * Returns an extended storage state that includes sessionStorage.
 *
 * sessionStorage is captured on every page load event (to catch MSAL
 * token writes after auth redirects) and merged into the final state.
 * This must happen before the page closes because sessionStorage is
 * inaccessible once the page is gone.
 */
export async function performManualLogin(
  browser: PlaywrightBrowser,
  targetUrl: string,
): Promise<StorageStateObject> {
  const page = await browser.newPage();
  const sessionStorageSnapshots = new Map<string, Array<{ name: string; value: string }>>();

  // Expose a bridge function that the page can call to push sessionStorage
  // to the Node process. This is used by the beforeunload handler to
  // capture the final state right before the page is destroyed — the only
  // reliable way to avoid losing tokens on close.
  await page.exposeFunction(
    '__cspReportSessionStorage',
    (origin: unknown, json: unknown) => {
      try {
        const entries = JSON.parse(String(json)) as Array<{ name: string; value: string }>;
        if (entries.length > 0) {
          sessionStorageSnapshots.set(String(origin), entries);
        }
      } catch {
        // Malformed data from browser — ignore
      }
    },
  );

  // Install in-page reporters via addInitScript so they survive navigation.
  // page.evaluate() only runs on the current document and is lost when the
  // page navigates (e.g. from about:blank to the login page to the app).
  // addInitScript re-runs on every new document, ensuring the reporters
  // are always present on the authenticated page.
  await page.addInitScript(() => {
    const report = () => {
      const items: Array<{ name: string; value: string }> = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key !== null) {
          items.push({ name: key, value: sessionStorage.getItem(key) ?? '' });
        }
      }
      /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
      (window as any).__cspReportSessionStorage(window.location.origin, JSON.stringify(items));
      /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
    };
    window.addEventListener('beforeunload', report);
    window.addEventListener('load', () => setTimeout(report, 1_000));
  });

  // Also capture via page.evaluate on load events as a fallback
  // (beforeunload may not fire in all edge cases)
  const captureFromPage = async () => {
    try {
      const url = page.url();
      if (!url || url === 'about:blank') return;
      const origin = new URL(url).origin;
      const entries: Array<{ name: string; value: string }> = await page.evaluate(() => {
        const items: Array<{ name: string; value: string }> = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key !== null) {
            items.push({ name: key, value: sessionStorage.getItem(key) ?? '' });
          }
        }
        return items;
      });
      if (entries.length > 0) {
        sessionStorageSnapshots.set(origin, entries);
      }
    } catch {
      // Page may be navigating or closing — ignore
    }
  };

  page.on('load', () => { captureFromPage().catch(() => {}); });

  const snapshotInterval = setInterval(() => {
    captureFromPage().catch(() => {});
  }, 5_000);

  try {
    await page.goto(targetUrl);
    logger.info('Waiting for manual login — close the page when done');
    await page.waitForEvent('close');
  } finally {
    clearInterval(snapshotInterval);
  }

  const storageState = await page.context().storageState();

  // Merge captured sessionStorage into the state
  if (sessionStorageSnapshots.size > 0) {
    const origins: StorageStateOrigin[] = [...(storageState.origins ?? [])];
    for (const [origin, entries] of sessionStorageSnapshots) {
      const existing = origins.find((o) => o.origin === origin);
      if (existing) {
        existing.sessionStorage = entries;
      } else {
        // Playwright didn't capture this origin (no localStorage), but the
        // page did have sessionStorage. Create the entry with an empty
        // localStorage array — Playwright requires it to be present.
        origins.push({ origin, localStorage: [], sessionStorage: entries });
      }
    }
    storageState.origins = origins;
    logger.info('Captured sessionStorage during manual login', {
      origins: sessionStorageSnapshots.size,
    });
  }

  return storageState;
}

// ── Session storage capture/restore ──────────────────────────────────────

/**
 * Captures sessionStorage from all open pages and merges it into a
 * Playwright StorageStateObject. Playwright's built-in storageState()
 * only captures cookies and localStorage — sessionStorage is lost.
 *
 * This is critical for MSAL/Azure AD B2C flows where tokens live in
 * sessionStorage. The result uses an `sessionStorage` extension key
 * on each origin entry, which Playwright ignores on restore but CSP
 * Analyser reads via `restoreSessionStorage`.
 */
export async function captureSessionStorage(
  pages: PlaywrightBrowserPage[],
  state: StorageStateObject,
): Promise<StorageStateObject> {
  const sessionStorageByOrigin = new Map<string, Array<{ name: string; value: string }>>();

  for (const page of pages) {
    try {
      const url = page.url();
      if (!url || url === 'about:blank') continue;

      const origin = new URL(url).origin;
      const entries = await page.evaluate(() => {
        const items: Array<{ name: string; value: string }> = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key !== null) {
            items.push({ name: key, value: sessionStorage.getItem(key) ?? '' });
          }
        }
        return items;
      });

      if (entries.length > 0) {
        const existing = sessionStorageByOrigin.get(origin);
        if (existing) {
          // Merge, dedup by name (later page wins)
          const merged = new Map(existing.map((e) => [e.name, e.value]));
          for (const entry of entries) {
            merged.set(entry.name, entry.value);
          }
          sessionStorageByOrigin.set(
            origin,
            [...merged.entries()].map(([name, value]) => ({ name, value })),
          );
        } else {
          sessionStorageByOrigin.set(origin, entries);
        }
      }
    } catch (err) {
      // Page may have been closed or navigated away — skip silently
      logger.debug('Failed to capture sessionStorage from page', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (sessionStorageByOrigin.size === 0) {
    return state;
  }

  // Merge into origins array
  const origins: StorageStateOrigin[] = [...(state.origins ?? [])];
  for (const [origin, entries] of sessionStorageByOrigin) {
    const existing = origins.find((o) => o.origin === origin);
    if (existing) {
      existing.sessionStorage = entries;
    } else {
      origins.push({ origin, localStorage: [], sessionStorage: entries });
    }
  }

  return { ...state, origins };
}

/**
 * Restores sessionStorage entries from an extended StorageStateObject
 * into a browser context using `addInitScript`. The script runs before
 * any page JavaScript, so tokens are available when frameworks like
 * MSAL initialize — no temporary page or navigation required.
 *
 * Only entries for the target origin's hostname are injected.
 */
export async function restoreSessionStorage(
  context: PlaywrightBrowserContext,
  state: StorageStateObject,
  targetUrl: string,
): Promise<number> {
  const origins = state.origins ?? [];
  const originsWithSessionStorage = origins.filter(
    (o): o is StorageStateOrigin & { sessionStorage: Array<{ name: string; value: string }> } =>
      Array.isArray(o.sessionStorage) && o.sessionStorage.length > 0,
  );

  if (originsWithSessionStorage.length === 0) {
    return 0;
  }

  let restored = 0;
  // Compare full origin (scheme + host + port) — sessionStorage is
  // origin-scoped, so https://example.com and http://example.com are
  // distinct. Comparing hostname alone could inject tokens across
  // protocol or port boundaries.
  const targetOrigin = new URL(targetUrl).origin;

  for (const origin of originsWithSessionStorage) {
    if (origin.origin !== targetOrigin) {
      logger.debug('Skipping sessionStorage restore for non-target origin', {
        origin: origin.origin,
        targetOrigin,
      });
      continue;
    }

    const entries = origin.sessionStorage;
    // Convert to a plain object for the init script argument
    const storageMap: Record<string, string> = {};
    for (const { name, value } of entries) {
      storageMap[name] = value;
    }

    await context.addInitScript((storage: Record<string, string>) => {
      for (const [key, value] of Object.entries(storage)) {
        window.sessionStorage.setItem(key, value);
      }
    }, storageMap);

    restored += entries.length;
    logger.info('Registered sessionStorage init script', {
      origin: origin.origin,
      count: entries.length,
    });
  }

  return restored;
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
