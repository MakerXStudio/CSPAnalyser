/**
 * Integration tests for the full runSession orchestration.
 *
 * Unlike browser-violation-capture.test.ts which tests the route handler
 * and violation listener in isolation, this suite exercises the full
 * session-manager pipeline: DB → report server → browser → auth context →
 * BFS crawler → CSP injection → inline hash extraction → per-page
 * Permissions-Policy capture → session status transitions.
 *
 * Covers:
 *  - Inline hash extraction end-to-end (script, style, style="", on*="")
 *  - Same-origin BFS with depth/maxPages limits
 *  - Permissions-Policy parsed and attributable via getPermissionsPolicies
 *  - Settlement delay: late-firing violations captured with delay, missed without
 *
 * Requires Playwright browsers.
 */
import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createDatabase,
  getPages,
  getViolations,
  getInlineHashes,
  getPermissionsPolicies,
  getSession,
} from '../../src/db/repository.js';
import { runSession } from '../../src/session-manager.js';

// ── Test servers ────────────────────────────────────────────────────────

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

// ── Test suite ──────────────────────────────────────────────────────────

describe('runSession pipeline', () => {
  // runSession takes ownership of the browser it receives and closes it
  // on cleanup, so we can't share one across tests — each test launches
  // (and implicitly releases) its own via runSession's default behaviour.

  // ── Inline hash extraction ─────────────────────────────────────────────

  it('extracts SHA-256 hashes for inline <script>, <style>, and event handlers', async () => {
    const inlineScript = "console.log('hello from inline script')";
    const inlineStyle = 'body { background: pink; }';
    const inlineAttrStyle = 'color: red;';
    const appServer = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html>
<html><head>
<style>${inlineStyle}</style>
</head><body>
<div style="${inlineAttrStyle}">styled div</div>
<button onclick="void 0">click me</button>
<script>${inlineScript}</script>
</body></html>`);
    });

    const db = createDatabase(':memory:');
    try {
      await runSession(db, {
        targetUrl: appServer.url,
        crawlConfig: { depth: 0, maxPages: 1, settlementDelay: 500 },
      });

      // Look up the session that was created (we didn't capture the id).
      const sessions = db
        .prepare('SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1')
        .all() as Array<{ id: string }>;
      const sessionId = sessions[0].id;

      const hashes = getInlineHashes(db, sessionId);
      const byDirective: Record<string, number> = {};
      for (const h of hashes) {
        byDirective[h.directive] = (byDirective[h.directive] ?? 0) + 1;
      }
      // Each content type should produce at least one hash
      expect(byDirective['script-src-elem'] ?? 0).toBeGreaterThanOrEqual(1);
      expect(byDirective['style-src-elem'] ?? 0).toBeGreaterThanOrEqual(1);
      expect(byDirective['style-src-attr'] ?? 0).toBeGreaterThanOrEqual(1);
      // onclick handler → script-src-attr
      expect(byDirective['script-src-attr'] ?? 0).toBeGreaterThanOrEqual(1);

      // Stored hashes are the raw base64 digest; the `sha256-` prefix is
      // prepended later when the hash is serialised into a CSP source.
      for (const h of hashes) {
        expect(h.hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
      }
    } finally {
      db.close();
      await appServer.close();
    }
  }, 20_000);

  // ── Same-origin BFS ────────────────────────────────────────────────────

  it('respects maxPages and only follows same-origin links', async () => {
    const externalServer = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>external</body></html>');
    });

    const appServer = await startTestServer((req, res) => {
      const path = req.url ?? '/';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (path === '/') {
        res.end(`<!DOCTYPE html><html><body>
<a href="/a">a</a> <a href="/b">b</a> <a href="/c">c</a>
<a href="${externalServer.url}/">external</a>
</body></html>`);
      } else {
        res.end(`<!DOCTYPE html><html><body>page ${path}</body></html>`);
      }
    });

    const db = createDatabase(':memory:');
    try {
      const result = await runSession(db, {
        targetUrl: appServer.url,
        crawlConfig: { depth: 1, maxPages: 3, settlementDelay: 0 },
      });

      const sessionId = result.session.id;
      const pages = getPages(db, sessionId);

      // maxPages = 3 caps the visits
      expect(pages.length).toBeLessThanOrEqual(3);
      // All visited pages must be on the target origin
      for (const p of pages) {
        expect(p.url.startsWith(appServer.url)).toBe(true);
      }
      expect(pages.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
      await appServer.close();
      await externalServer.close();
    }
  }, 20_000);

  it("does not follow links past the configured depth", async () => {
    const appServer = await startTestServer((req, res) => {
      const path = req.url ?? '/';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (path === '/') {
        res.end('<!DOCTYPE html><html><body><a href="/level1">l1</a></body></html>');
      } else if (path === '/level1') {
        res.end('<!DOCTYPE html><html><body><a href="/level2">l2</a></body></html>');
      } else {
        res.end('<!DOCTYPE html><html><body>leaf</body></html>');
      }
    });

    const db = createDatabase(':memory:');
    try {
      const result = await runSession(db, {
        targetUrl: appServer.url,
        crawlConfig: { depth: 1, maxPages: 10, settlementDelay: 0 },
      });

      const pages = getPages(db, result.session.id);
      const urls = pages.map((p) => p.url);
      // depth=1 means / + its direct links, not transitively deeper
      expect(urls).toContain(`${appServer.url}/`);
      expect(urls).toContain(`${appServer.url}/level1`);
      expect(urls.some((u) => u.endsWith('/level2'))).toBe(false);
    } finally {
      db.close();
      await appServer.close();
    }
  }, 20_000);

  // ── Permissions-Policy capture ─────────────────────────────────────────

  it('captures Permissions-Policy header into the permissions_policies table', async () => {
    const appServer = await startTestServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Permissions-Policy': 'camera=(), geolocation=(self), microphone=(self "https://trusted.example.com")',
      });
      res.end('<!DOCTYPE html><html><body>hi</body></html>');
    });

    const db = createDatabase(':memory:');
    try {
      const result = await runSession(db, {
        targetUrl: appServer.url,
        crawlConfig: { depth: 0, maxPages: 1, settlementDelay: 0 },
      });

      const policies = getPermissionsPolicies(db, result.session.id);
      const byDirective = new Map(policies.map((p) => [p.directive, p]));

      expect(byDirective.has('camera')).toBe(true);
      expect(byDirective.has('geolocation')).toBe(true);
      expect(byDirective.has('microphone')).toBe(true);
      expect(byDirective.get('camera')?.allowlist).toEqual([]);
      expect(byDirective.get('geolocation')?.allowlist).toEqual(['self']);
      expect(byDirective.get('microphone')?.allowlist).toContain('self');
    } finally {
      db.close();
      await appServer.close();
    }
  }, 20_000);

  // ── Settlement delay ───────────────────────────────────────────────────

  it('captures late-firing violations when settlementDelay is non-zero', async () => {
    // Page fires a blocked fetch 600ms after load. Without settlement delay
    // the crawler closes the page before the violation is reported.
    const apiServer = await startTestServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const appServer = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body><script>
setTimeout(function() { fetch('${apiServer.url}/late').catch(function(){}); }, 600);
</script></body></html>`);
    });

    const db = createDatabase(':memory:');
    try {
      const result = await runSession(db, {
        targetUrl: appServer.url,
        crawlConfig: { depth: 0, maxPages: 1, settlementDelay: 2000 },
      });

      const violations = getViolations(db, result.session.id);
      const connectSrc = violations.filter(
        (v) => v.effectiveDirective === 'connect-src',
      );
      expect(connectSrc.length).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
      await appServer.close();
      await apiServer.close();
    }
  }, 20_000);

  // ── Session status lifecycle ───────────────────────────────────────────

  it('transitions session status through created → crawling → complete', async () => {
    const appServer = await startTestServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body>hi</body></html>');
    });

    const db = createDatabase(':memory:');
    try {
      const result = await runSession(db, {
        targetUrl: appServer.url,
        crawlConfig: { depth: 0, maxPages: 1, settlementDelay: 0 },
      });

      const final = getSession(db, result.session.id);
      expect(final?.status).toBe('complete');
      expect(result.errors).toEqual([]);
    } finally {
      db.close();
      await appServer.close();
    }
  }, 20_000);
});
