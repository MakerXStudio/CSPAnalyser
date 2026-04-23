/**
 * Integration tests for the audit_policy pipeline.
 *
 * Covers the full audit flow with a real Chromium browser:
 *  - CSP passthrough (Report-Only + enforced capture)
 *  - Violations attributed to the correct disposition
 *  - Redirect-chain parity with injection mode (OAuth-style 302 back to app)
 *  - Audit diff: existing policy vs merged policy with violation-driven
 *    additions
 *
 * Requires Playwright browsers (`npx playwright install chromium`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  getExistingCspHeaders,
  getViolations,
  insertExistingCspHeader,
} from '../../src/db/repository.js';
import { setupCspPassthrough } from '../../src/csp-passthrough.js';
import { setupViolationListener } from '../../src/violation-listener.js';
import { startReportServer } from '../../src/report-server.js';
import { generateAuditResult } from '../../src/audit.js';
import type { Violation } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

interface TestServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

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
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

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

async function setupAuditHarness(browser: Browser, targetUrl: string) {
  const db = createDatabase(':memory:');
  const session = createSession(db, { targetUrl });
  const reportServer = await startReportServer(db, session.id);
  const context = await browser.newContext();
  const page = await context.newPage();
  await setupCspPassthrough(
    page,
    reportServer.port,
    reportServer.token,
    (captured, requestUrl) => {
      for (const c of captured) {
        insertExistingCspHeader(db, {
          sessionId: session.id,
          pageId: null,
          headerType: c.headerType,
          headerValue: c.headerValue,
          sourceUrl: requestUrl,
        });
      }
    },
    undefined,
    targetUrl,
  );
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

/** HTML page that fires a blocked fetch() after load. */
function pageWithFetch(fetchUrl: string): string {
  return `<!DOCTYPE html>
<html><head><title>Audit Test</title></head>
<body>
  <script>
    setTimeout(function() {
      fetch('${fetchUrl}').catch(function() {});
    }, 100);
  </script>
</body></html>`;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('audit_policy pipeline', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
  });

  // ── CSP capture ────────────────────────────────────────────────────────

  describe('CSP header capture', () => {
    it('captures a Content-Security-Policy-Report-Only header', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy-Report-Only': "default-src 'self'",
        });
        res.end('<!DOCTYPE html><html><body>hi</body></html>');
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });

        const headers = getExistingCspHeaders(h.db, h.sessionId, 'report-only');
        expect(headers.length).toBeGreaterThanOrEqual(1);
        expect(headers[0].headerValue).toBe("default-src 'self'");

        const enforced = getExistingCspHeaders(h.db, h.sessionId, 'enforced');
        expect(enforced).toHaveLength(0);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    });

    it('captures an enforced Content-Security-Policy header', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'",
        });
        res.end('<!DOCTYPE html><html><body>hi</body></html>');
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });

        const enforced = getExistingCspHeaders(h.db, h.sessionId, 'enforced');
        expect(enforced.length).toBeGreaterThanOrEqual(1);
        expect(enforced[0].headerValue).toContain("default-src 'self'");
        expect(enforced[0].headerValue).toContain("script-src 'self' 'unsafe-inline'");
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    });

    it('captures both enforced and report-only headers on the same response', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'self'",
          'Content-Security-Policy-Report-Only': "script-src 'none'",
        });
        res.end('<!DOCTYPE html><html><body>hi</body></html>');
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });

        expect(
          getExistingCspHeaders(h.db, h.sessionId, 'enforced'),
        ).toHaveLength(1);
        expect(
          getExistingCspHeaders(h.db, h.sessionId, 'report-only'),
        ).toHaveLength(1);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    });

    it('records zero CSP headers for responses without CSP', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>hi</body></html>');
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });

        expect(getExistingCspHeaders(h.db, h.sessionId)).toHaveLength(0);
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    });
  });

  // ── Disposition attribution ────────────────────────────────────────────

  describe('violation disposition', () => {
    it('attributes violations to report disposition for Report-Only CSP', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy-Report-Only': "default-src 'self'",
        });
        res.end(pageWithFetch(apiServer.url + '/data'));
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId, {
          minCount: 1,
        });
        const connectSrc = violations.filter(
          (v) => v.effectiveDirective === 'connect-src',
        );

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        for (const v of connectSrc) {
          expect(v.disposition).toBe('report');
        }
      } finally {
        await h.cleanup();
        await appServer.close();
        await apiServer.close();
      }
    });

    it('attributes violations to enforce disposition for enforced CSP', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      const appServer = await startTestServer((_req, res) => {
        // Enforced CSP must allow 'unsafe-inline' script so the test page's
        // inline setTimeout() actually runs — otherwise the fetch never fires
        // and no connect-src violation can be attributed at all.
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'",
        });
        res.end(pageWithFetch(apiServer.url + '/data'));
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        const violations = await waitForViolations(h.db, h.sessionId, {
          minCount: 1,
        });
        const connectSrc = violations.filter(
          (v) => v.effectiveDirective === 'connect-src',
        );

        expect(connectSrc.length).toBeGreaterThanOrEqual(1);
        for (const v of connectSrc) {
          expect(v.disposition).toBe('enforce');
        }
      } finally {
        await h.cleanup();
        await appServer.close();
        await apiServer.close();
      }
    });
  });

  // ── Redirect-chain parity ──────────────────────────────────────────────

  describe('OAuth-style redirect chain', () => {
    it('captures CSP on /auth/callback after a non-target 302 back to target', async () => {
      // Simulates an OAuth IdP that 302s back to the app's /auth/callback.
      // Without the shared route-redirect-rewriter, the audit route handler
      // would miss the CSP header on the callback page entirely — audit
      // mode used to call route.continue() for non-target origins, so the
      // post-redirect request never re-entered the handler.
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      let appUrl = '';
      const authServer = await startTestServer((req, res) => {
        if (req.url === '/authorize') {
          res.writeHead(302, { Location: `${appUrl}/auth/callback?code=xyz` });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      const appServer = await startTestServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            `<!DOCTYPE html><html><body><script>window.location.href='${authServer.url}/authorize'</script></body></html>`,
          );
        } else if (url.pathname === '/auth/callback') {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Security-Policy-Report-Only': "default-src 'self'",
          });
          res.end(pageWithFetch(apiServer.url + '/after-auth'));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      appUrl = appServer.url;

      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await h.page.waitForURL('**/auth/callback**', { timeout: 10_000 });
        await waitForViolations(h.db, h.sessionId, {
          minCount: 1,
          timeoutMs: 10_000,
        });

        const headers = getExistingCspHeaders(h.db, h.sessionId, 'report-only');
        const callbackSources = headers.filter((c) =>
          c.sourceUrl.includes('/auth/callback'),
        );
        expect(callbackSources.length).toBeGreaterThanOrEqual(1);
        expect(callbackSources[0].headerValue).toContain("default-src 'self'");
      } finally {
        await h.cleanup();
        await appServer.close();
        await authServer.close();
        await apiServer.close();
      }
    }, 20_000);
  });

  // ── Audit result generation ────────────────────────────────────────────

  describe('audit result', () => {
    it('produces a diff that merges violation-driven additions into existing policy', async () => {
      const apiServer = await startTestServer((_req, res) => {
        res.writeHead(200);
        res.end('{}');
      });
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy-Report-Only': "default-src 'self'",
        });
        res.end(pageWithFetch(apiServer.url + '/data'));
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });
        await waitForViolations(h.db, h.sessionId, { minCount: 1 });

        const result = generateAuditResult(h.db, h.sessionId, {
          strictness: 'moderate',
        });

        expect(result.reportOnly).not.toBeNull();
        expect(result.reportOnly?.existingDirectives['default-src']).toContain(
          "'self'",
        );

        // The merged policy must include the API origin somewhere — either
        // as an explicit connect-src source (the usual case) or folded into
        // default-src if the optimizer factored it up.
        const merged = result.reportOnly?.mergedDirectives ?? {};
        // Moderate strictness generates wildcard domain sources for private
        // IPs (e.g. `*.0.0.1` for 127.0.0.x) rather than exact origins — so
        // instead of matching the literal apiServer URL, assert the merged
        // connect-src has gained a source beyond the existing `'self'`.
        const mergedConnect = merged['connect-src'] ?? [];
        expect(mergedConnect.length).toBeGreaterThan(1);
        expect(mergedConnect).toContain("'self'");

        // The diff must register at least one non-empty change — the violation
        // on connect-src cannot be satisfied by the existing default-src 'self'
        // alone, so something has to move.
        const diff = result.reportOnly?.diff;
        const totalChanges =
          (diff?.addedDirectives.length ?? 0) +
          (diff?.changedDirectives.length ?? 0);
        expect(totalChanges).toBeGreaterThan(0);
      } finally {
        await h.cleanup();
        await appServer.close();
        await apiServer.close();
      }
    });

    it('returns null for both enforced and reportOnly when no CSP headers seen', async () => {
      const appServer = await startTestServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>hi</body></html>');
      });
      const h = await setupAuditHarness(browser, appServer.url);

      try {
        await h.page.goto(appServer.url, { waitUntil: 'load' });

        const result = generateAuditResult(h.db, h.sessionId, {
          strictness: 'strict',
        });

        expect(result.enforced).toBeNull();
        expect(result.reportOnly).toBeNull();
      } finally {
        await h.cleanup();
        await appServer.close();
      }
    });
  });
});
