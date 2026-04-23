/**
 * Integration tests for runInteractiveSession.
 *
 * Interactive mode is normally driven by a human in a headed browser. These
 * tests override the `launchBrowser` dep to run headless Chromium, then
 * programmatically close pages to end the session. The goal is to exercise
 * the programmatic surface (lifecycle, storage state I/O, sessionStorage
 * capture, interactive→audit handoff) — not to simulate organic user clicks.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDatabase,
  getSession,
  getPages,
} from '../../src/db/repository.js';
import {
  runInteractiveSession,
  runAuditSession,
} from '../../src/session-manager.js';

// ── Test server ────────────────────────────────────────────────────────

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

/**
 * Start an interactive session, wait for the page to load, then close all
 * pages in the browser's contexts so the session's wait-for-close promise
 * resolves. Returns the session result.
 */
async function runInteractiveUntilPagesClosed(
  db: import('better-sqlite3').Database,
  config: Parameters<typeof runInteractiveSession>[1],
  options: Parameters<typeof runInteractiveSession>[2],
  waitAfterNavigateMs = 1500,
): Promise<Awaited<ReturnType<typeof runInteractiveSession>>> {
  const browser = await chromium.launch({ headless: true });

  const sessionPromise = runInteractiveSession(db, config, options, {
    launchBrowser: async () => browser,
  });

  // Wait for the session to open a page and navigate. A fixed delay is
  // the cheapest way to let the initial `page.goto(targetUrl)` complete
  // before we start closing things.
  await new Promise((r) => setTimeout(r, waitAfterNavigateMs));

  // Close every page across every context — the session's wait-for-close
  // promise resolves as soon as the last page goes.
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      await page.close().catch(() => {});
    }
  }

  const result = await sessionPromise;
  await browser.close().catch(() => {});
  return result;
}

describe('runInteractiveSession pipeline', () => {
  it('completes the session when all pages are closed', async () => {
    const appServer = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>hi</body></html>');
    });

    const db = createDatabase(':memory:');
    try {
      const result = await runInteractiveUntilPagesClosed(
        db,
        { targetUrl: appServer.url },
        {},
      );

      expect(result.session.status).toBe('complete');
      const final = getSession(db, result.session.id);
      expect(final?.status).toBe('complete');

      // The initial page load should have produced at least one page record
      const pages = getPages(db, result.session.id);
      expect(pages.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      await appServer.close();
    }
  }, 30_000);

  it('exports browser storage state to saveStorageStatePath', async () => {
    // Server sets a session cookie on the landing page
    const appServer = await startTestServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': 'session_id=abc123; Path=/; HttpOnly',
      });
      res.end('<!DOCTYPE html><html><body>hi</body></html>');
    });

    const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-csp-storage-'));
    const statePath = join(tmpDir, 'state.json');

    const db = createDatabase(':memory:');
    try {
      const result = await runInteractiveUntilPagesClosed(
        db,
        { targetUrl: appServer.url },
        { saveStorageStatePath: statePath },
      );

      expect(result.storageStatePath).toBeDefined();

      const raw = readFileSync(statePath, 'utf-8');
      const state = JSON.parse(raw) as {
        cookies: Array<{ name: string; value: string; domain: string }>;
      };
      expect(Array.isArray(state.cookies)).toBe(true);
      const sessionCookie = state.cookies.find((c) => c.name === 'session_id');
      expect(sessionCookie?.value).toBe('abc123');
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
      await appServer.close();
    }
  }, 30_000);

  it('hands off storage state to a subsequent audit session that reuses auth', async () => {
    // Auth-gated server: requires session_id=abc123 cookie to serve /private.
    // Without the cookie it responds 401; with the cookie it responds 200
    // with a Report-Only CSP so the audit has something to capture.
    const authServer = await startTestServer((req, res) => {
      const cookie = req.headers.cookie ?? '';
      const authed = cookie.includes('session_id=abc123');
      const path = req.url ?? '/';

      if (path === '/' && !authed) {
        // Landing page sets the auth cookie and renders a link to /private
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'session_id=abc123; Path=/; HttpOnly',
        });
        res.end('<!DOCTYPE html><html><body><a href="/private">go</a></body></html>');
        return;
      }

      if (path === '/private' && authed) {
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy-Report-Only': "default-src 'self'",
        });
        res.end('<!DOCTYPE html><html><body>private area</body></html>');
        return;
      }

      if (path === '/private' && !authed) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>ok</body></html>');
    });

    const tmpDir = mkdtempSync(join(process.cwd(), '.tmp-csp-handoff-'));
    const statePath = join(tmpDir, 'state.json');

    const db = createDatabase(':memory:');
    try {
      // Step 1: interactive session — land on /, which sets the cookie.
      //   Then we close the browser and let runInteractiveSession write
      //   state.json.
      await runInteractiveUntilPagesClosed(
        db,
        { targetUrl: authServer.url },
        { saveStorageStatePath: statePath },
      );

      // Step 2: audit session reusing the captured storageState. This path
      //   should hit /private with the auth cookie and capture its
      //   Report-Only CSP.
      const auditResult = await runAuditSession(db, {
        targetUrl: `${authServer.url}/private`,
        crawlConfig: { depth: 0, maxPages: 1, settlementDelay: 0 },
        storageStatePath: statePath,
      });

      expect(auditResult.session.status).toBe('complete');

      // The audit should have landed on a 200, not a 401, confirming the
      // cookie was reused.
      const pages = getPages(db, auditResult.session.id);
      const privatePage = pages.find((p) => p.url.endsWith('/private'));
      expect(privatePage?.statusCode).toBe(200);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
      await authServer.close();
    }
  }, 40_000);
});
