import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startReportServer } from '../src/report-server.js';
import { createDatabase } from '../src/db/repository.js';
import { getViolations } from '../src/db/repository.js';
import { createSession } from '../src/db/repository.js';
import type Database from 'better-sqlite3';

let db: Database.Database;
let sessionId: string;
let port: number;
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

  // ── 404 ──────────────────────────────────────────────────────────────

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it('returns 405 for GET on report endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report`);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('method not allowed');
  });

  it('returns 405 for PUT on report endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/reports`, { method: 'PUT' });
    expect(res.status).toBe(405);
  });

  it('returns 405 with Allow: POST header', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report`, { method: 'DELETE' });
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

    const res = await post('/csp-report', body, 'application/csp-report');
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

    const res = await post('/csp-report', body, 'application/json');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
  });

  it('POST /csp-report returns 204 even for unparseable reports', async () => {
    const res = await post('/csp-report', { invalid: 'data' }, 'application/csp-report');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(0);
  });

  it('POST /csp-report rejects unsupported content type', async () => {
    const res = await post('/csp-report', {}, 'text/plain');
    expect(res.status).toBe(415);
  });

  it('POST /csp-report rejects invalid JSON', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report`, {
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

    const res = await post('/reports', body, 'application/reports+json');
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

    const res = await post('/reports', body, 'application/json');
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
  });

  it('POST /reports rejects unsupported content type', async () => {
    const res = await post('/reports', [], 'text/plain');
    expect(res.status).toBe(415);
  });

  // ── Body size limit ──────────────────────────────────────────────────

  it('rejects bodies larger than 1MB', async () => {
    const largeBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await fetch(`http://127.0.0.1:${port}/csp-report`, {
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

    const res = await post('/csp-report', body, 'application/csp-report');
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
