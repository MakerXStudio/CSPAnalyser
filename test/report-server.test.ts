import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startReportServer } from '../src/report-server.js';
import { createDatabase } from '../src/db/repository.js';
import { getViolations } from '../src/db/repository.js';
import { createSession } from '../src/db/repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let sessionId: string;
let port: number;
let token: string;
let close: () => Promise<void>;

async function post(path: string, body: unknown, contentType: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  db = createDatabase(':memory:');
  const session = createSession(db, { targetUrl: 'https://example.com' });
  sessionId = session.id;
  const server = await startReportServer(db, sessionId);
  port = server.port;
  token = server.token;
  close = server.close;
});

afterEach(async () => {
  await close();
  db.close();
});

describe('report-server', () => {
  // ── Health check ─────────────────────────────────────────────────────

  it('GET /health returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  // ── Token auth ───────────────────────────────────────────────────────

  it('returns a per-session auth token', () => {
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('returns 404 for report paths without token', async () => {
    const res = await post('/csp-report', { 'csp-report': {} }, 'application/csp-report');
    expect(res.status).toBe(404);
  });

  it('returns 404 for report paths with wrong token', async () => {
    const res = await post('/csp-report/wrong-token', { 'csp-report': {} }, 'application/csp-report');
    expect(res.status).toBe(404);
  });

  it('returns 404 for reports API path without token', async () => {
    const res = await post('/reports', [], 'application/reports+json');
    expect(res.status).toBe(404);
  });

  // ── 404 ──────────────────────────────────────────────────────────────

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 405 for GET on report endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('method not allowed');
  });

  it('returns 405 for PUT on report endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/reports/${token}`, { method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('returns 405 with Allow: POST header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  // ── CSP report endpoint ──────────────────────────────────────────────

  it('POST /csp-report accepts and stores a valid report', async () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/page',
        'blocked-uri': 'https://cdn.example.com/script.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };

    const res = await post(`/csp-report/${token}`, body, 'application/csp-report');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.blockedUri).toBe('https://cdn.example.com/script.js');
    expect(violations[0]!.capturedVia).toBe('report_uri');
  });

  it('POST /csp-report accepts application/json content type', async () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'inline',
        'violated-directive': 'style-src',
        'effective-directive': 'style-src',
      },
    };

    const res = await post(`/csp-report/${token}`, body, 'application/json');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
  });

  it('POST /csp-report returns 204 even for unparseable reports', async () => {
    const res = await post(`/csp-report/${token}`, { invalid: 'data' }, 'application/csp-report');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(0);
  });

  it('POST /csp-report rejects unsupported content type', async () => {
    const res = await post(`/csp-report/${token}`, {}, 'text/plain');
    expect(res.status).toBe(415);
  });

  it('POST /csp-report rejects invalid JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: 'not json{{{',
    });
    expect(res.status).toBe(400);
  });

  // ── Reporting API endpoint ───────────────────────────────────────────

  it('POST /reports accepts and stores reporting API reports', async () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: 'https://cdn.example.com/img.png',
          effectiveDirective: 'img-src',
        },
      },
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: 'https://cdn.example.com/font.woff',
          effectiveDirective: 'font-src',
        },
      },
    ];

    const res = await post(`/reports/${token}`, body, 'application/reports+json');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(2);
    expect(violations[0]!.capturedVia).toBe('reporting_api');
  });

  it('POST /reports accepts application/json content type', async () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: 'eval',
          effectiveDirective: 'script-src',
        },
      },
    ];

    const res = await post(`/reports/${token}`, body, 'application/json');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
  });

  it('POST /reports rejects unsupported content type', async () => {
    const res = await post(`/reports/${token}`, [], 'text/plain');
    expect(res.status).toBe(415);
  });

  // ── Body size limit ──────────────────────────────────────────────────

  it('rejects bodies larger than 1MB', async () => {
    const largeBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: largeBody,
    });
    // Server may return 413 or connection may be destroyed
    expect([400, 413].includes(res.status) || !res.ok).toBe(true);
  });

  // ── Internal error handling ──────────────────────────────────────────

  it('returns 500 when report processing throws', async () => {
    // Close the DB to make insertViolation throw
    db.close();

    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'https://cdn.example.com/script.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };

    const res = await post(`/csp-report/${token}`, body, 'application/csp-report');
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('internal error');

    // Reopen DB so afterEach doesn't throw
    db = createDatabase(':memory:');
  });

  // ── Server lifecycle ─────────────────────────────────────────────────

  it('listens on 127.0.0.1 with auto-assigned port', () => {
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────

describe('report-server rate limiting', () => {
  let rateLimitDb: Database.Database;
  let rateLimitSessionId: string;
  let rateLimitPort: number;
  let rateLimitToken: string;
  let rateLimitClose: () => Promise<void>;

  function makeReport(blockedUri: string) {
    return {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': blockedUri,
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };
  }

  async function postReport(body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${rateLimitPort}/csp-report/${rateLimitToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify(body),
    });
  }

  afterEach(async () => {
    if (rateLimitClose) await rateLimitClose();
    if (rateLimitDb) rateLimitDb.close();
  });

  it('accepts reports under the violation limit', async () => {
    rateLimitDb = createDatabase(':memory:');
    const session = createSession(rateLimitDb, { targetUrl: 'https://example.com' });
    rateLimitSessionId = session.id;
    const server = await startReportServer(rateLimitDb, rateLimitSessionId, { violationLimit: 3 });
    rateLimitPort = server.port;
    rateLimitToken = server.token;
    rateLimitClose = server.close;

    const res1 = await postReport(makeReport('https://cdn.example.com/a.js'));
    expect(res1.status).toBe(204);

    const res2 = await postReport(makeReport('https://cdn.example.com/b.js'));
    expect(res2.status).toBe(204);

    const violations = getViolations(rateLimitDb, rateLimitSessionId);
    expect(violations).toHaveLength(2);
  });

  it('returns 429 once violation limit is reached', async () => {
    rateLimitDb = createDatabase(':memory:');
    const session = createSession(rateLimitDb, { targetUrl: 'https://example.com' });
    rateLimitSessionId = session.id;
    const server = await startReportServer(rateLimitDb, rateLimitSessionId, { violationLimit: 2 });
    rateLimitPort = server.port;
    rateLimitToken = server.token;
    rateLimitClose = server.close;

    // Fill up to limit
    const res1 = await postReport(makeReport('https://cdn.example.com/a.js'));
    expect(res1.status).toBe(204);

    const res2 = await postReport(makeReport('https://cdn.example.com/b.js'));
    expect(res2.status).toBe(204);

    // This should be rejected
    const res3 = await postReport(makeReport('https://cdn.example.com/c.js'));
    expect(res3.status).toBe(429);
    const body = await res3.json();
    expect(body.error).toBe('violation limit reached');

    // Only 2 violations should be stored
    const violations = getViolations(rateLimitDb, rateLimitSessionId);
    expect(violations).toHaveLength(2);
  });

  it('returns 429 for reporting API endpoint when limit reached', async () => {
    rateLimitDb = createDatabase(':memory:');
    const session = createSession(rateLimitDb, { targetUrl: 'https://example.com' });
    rateLimitSessionId = session.id;
    const server = await startReportServer(rateLimitDb, rateLimitSessionId, { violationLimit: 1 });
    rateLimitPort = server.port;
    rateLimitToken = server.token;
    rateLimitClose = server.close;

    // Fill the limit with one report
    const res1 = await postReport(makeReport('https://cdn.example.com/a.js'));
    expect(res1.status).toBe(204);

    // Reporting API endpoint should also be rate-limited
    const res2 = await fetch(`http://127.0.0.1:${rateLimitPort}/reports/${rateLimitToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/reports+json' },
      body: JSON.stringify([{
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: 'https://cdn.example.com/b.js',
          effectiveDirective: 'script-src',
        },
      }]),
    });
    expect(res2.status).toBe(429);
  });

  it('allows unlimited violations when violationLimit is 0', async () => {
    rateLimitDb = createDatabase(':memory:');
    const session = createSession(rateLimitDb, { targetUrl: 'https://example.com' });
    rateLimitSessionId = session.id;
    const server = await startReportServer(rateLimitDb, rateLimitSessionId, { violationLimit: 0 });
    rateLimitPort = server.port;
    rateLimitToken = server.token;
    rateLimitClose = server.close;

    // Send multiple reports — none should be rejected
    for (let i = 0; i < 5; i++) {
      const res = await postReport(makeReport(`https://cdn.example.com/${i}.js`));
      expect(res.status).toBe(204);
    }

    const violations = getViolations(rateLimitDb, rateLimitSessionId);
    expect(violations).toHaveLength(5);
  });

  it('uses default limit of 10,000 when no option provided', async () => {
    rateLimitDb = createDatabase(':memory:');
    const session = createSession(rateLimitDb, { targetUrl: 'https://example.com' });
    rateLimitSessionId = session.id;
    // No options — uses default
    const server = await startReportServer(rateLimitDb, rateLimitSessionId);
    rateLimitPort = server.port;
    rateLimitToken = server.token;
    rateLimitClose = server.close;

    // Just verify it accepts reports (default limit is 10,000)
    const res = await postReport(makeReport('https://cdn.example.com/a.js'));
    expect(res.status).toBe(204);
  });
});
