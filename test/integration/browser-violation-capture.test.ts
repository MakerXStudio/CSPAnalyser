/**
 * Browser integration tests for CSP violation capture.
 *
 * These tests spin up real HTTP servers and a real Chromium browser via
 * Playwright to verify that violations are captured correctly — including
 * the tricky scenarios that mock-based tests can't cover, such as:
 *
 * - connect-src violations from fetch() after cross-origin redirect chains
 * - HTTP 302 redirects that bypass Playwright's route handler
 * - Set-Cookie preservation across the 302→JS-redirect workaround
 * - violation capture on window vs document event targets
 * - SPA client-side navigation without full page reloads
 * - CSP header stripping on target-origin responses
 * - non-target-origin subresource requests passing through unmodified
 *
 * Requires Playwright browsers to be installed (`npx playwright install chromium`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import Database from 'better-sqlite3';
import { createDatabase, createSession, getViolations } from '../../src/db/repository.js';
import { setupCspInjection } from '../../src/csp-injector.js';
import { setupViolationListener } from '../../src/violation-listener.js';
import { startReportServer, type ReportServerResult } from '../../src/report-server.js';
import type { Violation } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Start an HTTP server on a random port and return its URL + close handle. */
function startTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

/** HTML page that makes a fetch() to a given URL after a short delay. */
function pageWithFetch(fetchUrl: string, title = 'Test Page'): string {
  return `<!DOCTYPE html>
<html><head><title>${title}</title></head>
<body>
  <h1>${title}</h1>
  <script>
    setTimeout(function() {
      fetch('${fetchUrl}').catch(function() {});
    }, 100);
  </script>
</body></html>`;
}

/** HTML page that makes a fetch() AND loads an image. */
function pageWithMultipleViolations(fetchUrl: string, imgUrl: string): string {
  return `<!DOCTYPE html>
<html><head><title>Multi-violation Page</title></head>
<body>
  <img src="${imgUrl}" onerror="/* expected */">
  <script>
    fetch('${fetchUrl}').catch(function() {});
  </script>
</body></html>`;
}

/** Minimal page with no violations. */
function emptyPage(): string {
  return '<!DOCTYPE html><html><head><title>Empty</title></head><body></body></html>';
}

/** Filter violations to a specific directive. */
function violationsFor(violations: Violation[], directive: string): Violation[] {
  return violations.filter((v) => v.effectiveDirective === directive);
}

/** Wait for violations to settle (stop arriving). */
async function waitForViolations(
  db: Database.Database,
  sessionId: string,
  opts?: { minCount?: number; timeoutMs?: number; quietMs?: number },
): Promise<Violation[]> {
  const timeout = opts?.timeoutMs ?? 10_000;
  const quiet = opts?.quietMs ?? 1_000;
  const minCount = opts?.minCount ?? 1;
  const start = Date.now();
  let lastCount = 0;
  let lastChangeAt = start;

  while (Date.now() - start < timeout) {
    const violations = getViolations(db, sessionId);
    if (violations.length !== lastCount) {
      lastCount = violations.length;
      lastChangeAt = Date.now();
    }
    if (violations.length >= minCount && Date.now() - lastChangeAt >= quiet) {
      return violations;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return getViolations(db, sessionId);
}

/** Set up a full test harness: DB, session, report server, browser page with CSP + listener. */
async function setupHarness(browser: Browser, targetUrl: string) {
  const db = createDatabase(':memory:');
  const session = createSession(db, { targetUrl });
  const reportServer = await startReportServer(db, session.id);
  const context = await browser.newContext();
  const page = await context.newPage();
  await setupCspInjection(page, reportServer.port, reportServer.token, undefined, targetUrl);
  await setupViolationListener(page, db, session.id, null);
  return {
    db,
    sessionId: session.id,
    reportServer,
    context,
    page,
    async cleanup() {
      await page.close();
      await context.close();
      await reportServer.close();
      db.close();
    },
  };
}

// ── Test suite ───────────────────────────────────────────────────────────

describe('browser violation capture', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  // ── Basic violation capture ──────────────────────────────────────────

  describe('basic violation capture', () => {
    it('captures connect-src violations from fetch()', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(pageWithFetch(apiServer.url + '/graphql'));
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await apiServer.close();
      }
    }, 15_000);

    it('captures multiple directive types simultaneously', async () => {
      const externalServer = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(pageWithMultipleViolations(
          externalServer.url + '/api',
          externalServer.url + '/image.png',
        ));
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId, { minCount: 2 });

        expect(violationsFor(violations, 'connect-src').length).toBeGreaterThanOrEqual(1);
        expect(violationsFor(violations, 'img-src').length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
        await externalServer.close();
      }
    }, 15_000);

    it('captures script-src violations from inline scripts', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head></head><body><script>console.log("inline")</script></body></html>');
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);

        expect(violationsFor(violations, 'script-src-elem').length).toBeGreaterThanOrEqual(1);
        const inlineViolation = violations.find((v) => v.blockedUri.includes('inline'));
        expect(inlineViolation).toBeDefined();
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    }, 15_000);

    it('captures style-src violations from inline styles', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><style>body { color: red; }</style></head><body></body></html>');
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);

        expect(violationsFor(violations, 'style-src-elem').length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    }, 15_000);

    it('captures font-src violations from external fonts', async () => {
      const fontServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'font/woff2' });
        res.end(Buffer.alloc(10)); // dummy font data
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head>
          <style>@font-face { font-family: 'Test'; src: url('${fontServer.url}/font.woff2'); } body { font-family: 'Test'; }</style>
        </head><body>Text</body></html>`);
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);

        // Should have both style-src-elem (inline style) and font-src violations
        expect(violationsFor(violations, 'font-src').length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
        await fontServer.close();
      }
    }, 15_000);

    it('produces no violations for a page with no external resources', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(emptyPage());
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        // Wait briefly — there should be nothing to capture
        const violations = await waitForViolations(h.db, h.sessionId, {
          minCount: 1,
          timeoutMs: 2_000,
          quietMs: 1_000,
        });

        expect(violations.length).toBe(0);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    }, 10_000);
  });

  // ── Cross-origin redirect handling ───────────────────────────────────

  describe('connect-src capture after cross-origin redirect', () => {
    it('captures connect-src after JS-based cross-origin redirect chain', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"data":"ok"}');
      });
      let appUrl = '';
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/login') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><body><script>
            setTimeout(function() { window.location.href = '${appUrl}/callback?token=abc'; }, 200);
          </script></body></html>`);
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', appUrl);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/login'</script></body></html>`);
        } else if (url.pathname === '/callback') {
          res.end(pageWithFetch(apiServer.url + '/graphql', 'Post-Auth'));
        } else { res.end(emptyPage()); }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('captures connect-src after HTTP 302 redirect from auth provider', async () => {
      // Playwright's route handler doesn't re-intercept requests from 302
      // redirects. The CSP injector works around this by replacing the 302
      // with a JS redirect page that forwards all original headers.
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      let appUrl = '';
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/authorize') {
          res.writeHead(302, { Location: `${appUrl}/callback?code=xyz` });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/authorize'</script></body></html>`);
        } else if (url.pathname === '/callback') {
          res.end(pageWithFetch(apiServer.url + '/data', 'Callback'));
        } else { res.end(emptyPage()); }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('preserves Set-Cookie headers across 302→JS redirect rewrite', async () => {
      let appUrl = '';
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/authorize') {
          res.writeHead(302, {
            Location: `${appUrl}/callback`,
            'Set-Cookie': 'auth_session=secret123; Path=/; HttpOnly',
          });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/authorize'</script></body></html>`);
        } else {
          res.end('<!DOCTYPE html><html><body>Callback</body></html>');
        }
      });
      appUrl = appServer.url;

      const db = createDatabase(':memory:');
      const session = createSession(db, { targetUrl: appServer.url });
      const reportServer = await startReportServer(db, session.id);
      const context = await browser.newContext();
      const page = await context.newPage();
      await setupCspInjection(page, reportServer.port, reportServer.token, undefined, appServer.url);

      try {
        await page.goto(appServer.url, { waitUntil: 'load' });
        await page.waitForURL('**/callback**', { timeout: 10_000 });

        // The auth server's Set-Cookie should have been forwarded
        const cookies = await context.cookies(authServer.url);
        const authCookie = cookies.find((c) => c.name === 'auth_session');
        expect(authCookie).toBeDefined();
        expect(authCookie?.value).toBe('secret123');
      } finally {
        await page.close();
        await context.close();
        await reportServer.close();
        await appServer.close();
        await authServer.close();
        db.close();
      }
    }, 20_000);

    it('captures connect-src after multi-hop 302 chain (auth → intermediate → app)', async () => {
      // Some auth providers redirect through intermediate endpoints before
      // landing on the app callback. The CSP injector follows the chain
      // hop-by-hop to detect when it reaches the target origin.
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      let appUrl = '';
      const intermediateServer = await startTestServer((_req, res) => {
        // Second hop: 302 to the app callback
        res.writeHead(302, {
          Location: `${appUrl}/callback?code=final`,
          'Set-Cookie': 'intermediate_state=hop2; Path=/',
        });
        res.end();
      });
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/authorize') {
          // First hop: 302 to intermediate (non-target origin)
          res.writeHead(302, {
            Location: `${intermediateServer.url}/process`,
            'Set-Cookie': 'auth_state=hop1; Path=/',
          });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/authorize'</script></body></html>`);
        } else if (url.pathname === '/callback') {
          res.end(pageWithFetch(apiServer.url + '/api', 'Final Callback'));
        } else { res.end(emptyPage()); }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);

        // Cookies from both hops should be preserved
        const cookies = await h.context.cookies();
        expect(cookies.some((c) => c.name === 'auth_state')).toBe(true);
        expect(cookies.some((c) => c.name === 'intermediate_state')).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await intermediateServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('handles cookie-dependent intermediate hops in 302 chains', async () => {
      // Some auth providers set a cookie on the first redirect that the
      // intermediate endpoint requires. The route handler must ensure the
      // browser processes each hop's cookies before navigating to the next.
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      let appUrl = '';
      // Intermediate: requires 'auth_step' cookie set by the auth server.
      // If the cookie is missing, it returns 403 instead of redirecting.
      const intermediateServer = await startTestServer((req, res) => {
        const cookies = req.headers.cookie ?? '';
        if (cookies.includes('auth_step=done')) {
          res.writeHead(302, { Location: `${appUrl}/callback?code=ok` });
          res.end();
        } else {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Missing auth cookie');
        }
      });
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/start') {
          // Sets cookie and redirects to intermediate
          res.writeHead(302, {
            Location: `${intermediateServer.url}/verify`,
            'Set-Cookie': 'auth_step=done; Path=/',
          });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/start'</script></body></html>`);
        } else if (url.pathname === '/callback') {
          res.end(pageWithFetch(apiServer.url + '/data', 'Auth Callback'));
        } else { res.end(emptyPage()); }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        // The chain should complete successfully with the cookie flowing
        // from the auth server through to the intermediate server.
        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await intermediateServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('strips CSP headers from redirect responses so inline redirect script runs', async () => {
      // If the IdP includes a strict CSP on its 302 response, forwarding
      // those headers onto the synthetic JS redirect page would block the
      // inline script and stall the auth flow.
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      let appUrl = '';
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/authorize') {
          // 302 with a strict CSP that blocks inline scripts
          res.writeHead(302, {
            Location: `${appUrl}/callback?code=csp`,
            'Content-Security-Policy': "default-src 'none'; script-src 'none'",
            'Content-Security-Policy-Report-Only': "default-src 'none'",
          });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/authorize'</script></body></html>`);
        } else if (url.pathname === '/callback') {
          res.end(pageWithFetch(apiServer.url + '/data', 'CSP Callback'));
        } else { res.end(emptyPage()); }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });
        const violations = await waitForViolations(h.db, h.sessionId);

        // If the CSP headers were forwarded, the JS redirect would be
        // blocked and we'd never reach /callback.
        expect(violationsFor(violations, 'connect-src').length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('rewrites 307 redirects to target origin and captures violations', async () => {
      // 307/308 redirects preserve method and body, but a JS redirect
      // converts to GET. When the 307 targets the app origin, we accept
      // the GET conversion to ensure CSP is injected. The callback
      // endpoint receives GET instead of POST — acceptable for CSP
      // analysis. For intermediate non-target hops, 307/308 are passed
      // through to preserve method semantics.
      let callbackMethod = '';
      let appUrl = '';
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/submit') {
          res.writeHead(307, { Location: `${appUrl}/callback` });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        if (url.pathname === '/callback') {
          callbackMethod = req.method ?? '';
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(pageWithFetch(apiServer.url + '/data', '307 Callback'));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<!DOCTYPE html><html><body>
            <form id="f" method="POST" action="${authServer.url}/submit">
              <input type="hidden" name="data" value="test">
            </form>
            <script>document.getElementById('f').submit()</script>
          </body></html>`);
        }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });

        // The 307 was rewritten to a JS redirect (GET), so the callback
        // receives GET instead of POST. This is the accepted tradeoff.
        expect(callbackMethod).toBe('GET');

        // CSP IS injected on the callback page — violations are captured
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');
        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('passes through 307 redirects to non-target origins (preserves POST)', async () => {
      // 307/308 redirects between non-target origins are passed through
      // to preserve method and body for intermediate auth hops.
      let intermediateMethod = '';
      const intermediateServer = await startTestServer((req, res) => {
        intermediateMethod = req.method ?? '';
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>Intermediate</body></html>');
      });
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/submit') {
          // 307 to another non-target origin — should preserve POST
          res.writeHead(307, { Location: `${intermediateServer.url}/process` });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body>
          <form id="f" method="POST" action="${authServer.url}/submit">
            <input type="hidden" name="data" value="test">
          </form>
          <script>document.getElementById('f').submit()</script>
        </body></html>`);
      });

      const db = createDatabase(':memory:');
      const session = createSession(db, { targetUrl: appServer.url });
      const reportServer = await startReportServer(db, session.id);
      const context = await browser.newContext();
      const page = await context.newPage();
      await setupCspInjection(page, reportServer.port, reportServer.token, undefined, appServer.url);

      try {
        await page.goto(appServer.url, { waitUntil: 'load' });
        await page.waitForURL(`${intermediateServer.url}/**`, { timeout: 10_000 });

        // 307 to non-target origin was passed through — POST preserved
        expect(intermediateMethod).toBe('POST');
      } finally {
        await page.close();
        await context.close();
        await reportServer.close();
        await appServer.close();
        await authServer.close();
        await intermediateServer.close();
        db.close();
      }
    }, 20_000);

    it('handles relative Location headers in 302 redirects', async () => {
      // Some servers respond with relative Location headers like
      // "Location: /step2" instead of absolute URLs. The CSP injector
      // resolves these against the request URL via resolveLocation().
      // This test uses a relative redirect within the auth server that
      // then issues a second redirect (absolute) back to the app.
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      let appUrl = '';
      const authServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        if (url.pathname === '/authorize') {
          // Relative Location: "/step2" resolved against the auth server
          res.writeHead(302, { Location: '/step2?state=abc' });
          res.end();
        } else if (url.pathname === '/step2') {
          // Second hop: absolute redirect back to the app
          res.writeHead(302, { Location: `${appUrl}/callback?code=rel` });
          res.end();
        } else { res.writeHead(404); res.end(); }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/authorize'</script></body></html>`);
        } else if (url.pathname === '/callback') {
          res.end(pageWithFetch(apiServer.url + '/data', 'Relative Callback'));
        } else { res.end(emptyPage()); }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/callback**', { timeout: 10_000 });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        // The relative redirect /step2 should have been resolved to the
        // auth server origin and rewritten as a JS redirect. The second
        // hop from /step2 to app/callback should then also be captured.
        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await apiServer.close();
      }
    }, 20_000);

    it('does not double-fetch non-redirect responses from external origins', async () => {
      // When a non-target navigation doesn't redirect (e.g., an external
      // page that the user navigates to), the handler should fulfill with
      // the already-fetched response, not issue a second request.
      let requestCount = 0;
      const externalServer = await startTestServer((_req, res) => {
        requestCount++;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>External Page</body></html>');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body><script>window.location.href='${externalServer.url}/page'</script></body></html>`);
      });

      const db = createDatabase(':memory:');
      const session = createSession(db, { targetUrl: appServer.url });
      const reportServer = await startReportServer(db, session.id);
      const context = await browser.newContext();
      const page = await context.newPage();
      await setupCspInjection(page, reportServer.port, reportServer.token, undefined, appServer.url);

      try {
        await page.goto(appServer.url, { waitUntil: 'load' });
        await page.waitForURL(`${externalServer.url}/**`, { timeout: 5_000 });
        await new Promise((r) => setTimeout(r, 500));

        // The external server should have been hit exactly once (by the
        // route.fetch({ maxRedirects: 0 })), not twice.
        expect(requestCount).toBe(1);
      } finally {
        await page.close();
        await context.close();
        await reportServer.close();
        await appServer.close();
        await externalServer.close();
        db.close();
      }
    }, 15_000);

    it('does not double-fetch multi-hop non-target redirect chains', async () => {
      // When a non-target navigation 302s to another non-target origin that
      // doesn't eventually reach the target, each hop should be requested
      // only once. The route handler rewrites each 302 to a JS redirect,
      // so the browser navigates hop-by-hop through the route handler.
      const hitCounts = { hop1: 0, hop2: 0, final: 0 };
      const server2 = await startTestServer((req, res) => {
        hitCounts.hop2++;
        // Final destination: a non-target 200 page
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>Final external page</body></html>');
      });
      const server1 = await startTestServer((req, res) => {
        hitCounts.hop1++;
        // 302 to server2 (another non-target origin)
        res.writeHead(302, { Location: `${server2.url}/final` });
        res.end();
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body><script>window.location.href='${server1.url}/start'</script></body></html>`);
      });

      const db = createDatabase(':memory:');
      const session = createSession(db, { targetUrl: appServer.url });
      const reportServer = await startReportServer(db, session.id);
      const context = await browser.newContext();
      const page = await context.newPage();
      await setupCspInjection(page, reportServer.port, reportServer.token, undefined, appServer.url);

      try {
        await page.goto(appServer.url, { waitUntil: 'load' });
        await page.waitForURL(`${server2.url}/**`, { timeout: 5_000 });
        await new Promise((r) => setTimeout(r, 500));

        // Each hop hit exactly once — no duplicates
        expect(hitCounts.hop1).toBe(1);
        expect(hitCounts.hop2).toBe(1);
      } finally {
        await page.close();
        await context.close();
        await reportServer.close();
        await appServer.close();
        await server1.close();
        await server2.close();
        db.close();
      }
    }, 15_000);

    it('does not inject CSP on non-target-origin pages (no pollution)', async () => {
      let appUrl = '';
      const externalServer = await startTestServer((req, res) => {
        // External page with its own resources — should NOT get CSP injected
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><body>
          <script>
            // Navigate back to app after brief delay
            setTimeout(function() { window.location.href = '${appUrl}/home'; }, 300);
          </script>
        </body></html>`);
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://127.0.0.1`);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (url.pathname === '/') {
          res.end(`<!DOCTYPE html><html><body><script>window.location.href='${externalServer.url}/page'</script></body></html>`);
        } else {
          res.end('<!DOCTYPE html><html><body>Home</body></html>');
        }
      });
      appUrl = appServer.url;
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/home**', { timeout: 10_000 });

        // Wait briefly for any violations
        const violations = await waitForViolations(h.db, h.sessionId, {
          minCount: 1,
          timeoutMs: 3_000,
          quietMs: 1_000,
        });

        // No violations should come from the external page — only from app pages
        const externalViolations = violations.filter((v) =>
          v.documentUri.includes(externalServer.url),
        );
        expect(externalViolations.length).toBe(0);
      } finally {
        await h.cleanup();
        await appServer.close();
        await externalServer.close();
      }
    }, 15_000);
  });

  // ── SPA client-side navigation ───────────────────────────────────────

  describe('SPA client-side navigation', () => {
    it('captures connect-src from fetch after pushState route change', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head><title>SPA</title></head>
<body><div id="app"></div>
<script>
  function navigate(path) {
    history.pushState(null, '', path);
    if (path === '/dashboard') {
      fetch('${apiServer.url}/api/dashboard').catch(function() {});
      document.getElementById('app').textContent = 'Dashboard loaded';
    }
  }
  setTimeout(function() { navigate('/dashboard'); }, 300);
</script></body></html>`);
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);
        const connectSrc = violationsFor(violations, 'connect-src');

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        expect(connectSrc.some((v) => v.blockedUri.includes(apiServer.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await apiServer.close();
      }
    }, 15_000);

    it('captures violations from multiple sequential SPA navigations', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      const imgServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.alloc(10));
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head></head>
<body><div id="app"></div>
<script>
  var apiUrl = '${apiServer.url}';
  var imgUrl = '${imgServer.url}';
  function navigate(path) {
    history.pushState(null, '', path);
    if (path === '/page1') {
      fetch(apiUrl + '/api/page1').catch(function() {});
    } else if (path === '/page2') {
      var img = new Image();
      img.src = imgUrl + '/photo.png';
    }
  }
  setTimeout(function() { navigate('/page1'); }, 200);
  setTimeout(function() { navigate('/page2'); }, 600);
</script></body></html>`);
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId, { minCount: 2, quietMs: 1_500 });

        expect(violationsFor(violations, 'connect-src').length).toBeGreaterThanOrEqual(1);
        expect(violationsFor(violations, 'img-src').length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
        await apiServer.close();
        await imgServer.close();
      }
    }, 15_000);
  });

  // ── CSP header handling ──────────────────────────────────────────────

  describe('CSP header handling', () => {
    it('strips existing CSP headers from target-origin responses', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'self'",
          'Content-Security-Policy-Report-Only': "script-src 'none'",
        });
        res.end(emptyPage());
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        const response = await h.page.goto(appServer.url, { waitUntil: 'load' });
        const headers = response?.headers() ?? {};

        // The original CSP should be stripped
        expect(headers['content-security-policy']).toBeUndefined();
        // Our deny-all CSP-Report-Only should be injected
        expect(headers['content-security-policy-report-only']).toContain("default-src 'none'");
        expect(headers['content-security-policy-report-only']).toContain('report-uri');
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    }, 15_000);

    it('captures violations via both DOM listener and report-uri deduplication', async () => {
      // When both header CSP (with report-uri) and DOM listener are active,
      // the same violation may arrive via both paths. The UNIQUE index
      // in the DB deduplicates them.
      const externalServer = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head></head><body>
          <img src="${externalServer.url}/img.png">
        </body></html>`);
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId, { quietMs: 2_000 });

        // Should have img-src violation — deduplicated to 1 despite potentially
        // arriving via both DOM event and report-uri
        const imgViolations = violationsFor(violations, 'img-src');
        expect(imgViolations.length).toBe(1);
      } finally {
        await h.cleanup();
        await appServer.close();
        await externalServer.close();
      }
    }, 15_000);
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles pages that make multiple concurrent fetch() calls', async () => {
      const server1 = await startTestServer((_req, res) => { res.writeHead(200); res.end('{}'); });
      const server2 = await startTestServer((_req, res) => { res.writeHead(200); res.end('{}'); });
      const server3 = await startTestServer((_req, res) => { res.writeHead(200); res.end('{}'); });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head></head><body><script>
          Promise.all([
            fetch('${server1.url}/a'),
            fetch('${server2.url}/b'),
            fetch('${server3.url}/c'),
          ]).catch(function() {});
        </script></body></html>`);
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId, { minCount: 3 });
        const connectSrc = violationsFor(violations, 'connect-src');

        // All three different origins should produce distinct violations
        expect(connectSrc.length).toBeGreaterThanOrEqual(3);
        expect(connectSrc.some((v) => v.blockedUri.includes(server1.url))).toBe(true);
        expect(connectSrc.some((v) => v.blockedUri.includes(server2.url))).toBe(true);
        expect(connectSrc.some((v) => v.blockedUri.includes(server3.url))).toBe(true);
      } finally {
        await h.cleanup();
        await appServer.close();
        await server1.close();
        await server2.close();
        await server3.close();
      }
    }, 15_000);

    it('captures data: URI violations', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head></head><body><img src="data:image/png;base64,iVBORw0KGgo="></body></html>');
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);

        const dataViolations = violations.filter((v) => v.blockedUri === 'data:');
        expect(dataViolations.length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    }, 15_000);

    it('captures blob: URI violations', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html><html><head></head><body><script>
          var blob = new Blob(['test'], { type: 'text/plain' });
          var url = URL.createObjectURL(blob);
          fetch(url).catch(function() {});
        </script></body></html>`);
      });
      const h = await setupHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId);

        const blobViolations = violations.filter((v) => v.blockedUri === 'blob:');
        expect(blobViolations.length).toBeGreaterThanOrEqual(1);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    }, 15_000);
  });
});
