import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/schema.js';
import {
  createSession,
  insertViolation,
  insertExistingCspHeader,
  insertInlineHash,
  updateSession,
} from '../src/db/repository.js';
import { generateAuditResult, formatAuditResult } from '../src/audit.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initializeDatabase(db);
});

afterEach(() => {
  db.close();
});

function createCompletedAuditSession(targetUrl: string): string {
  const session = createSession(db, { targetUrl, audit: true });
  updateSession(db, session.id, { status: 'complete' });
  return session.id;
}

describe('generateAuditResult', () => {
  it('returns null for enforced/reportOnly when no CSP headers captured', () => {
    const sessionId = createCompletedAuditSession('https://example.com');
    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });
    expect(result.enforced).toBeNull();
    expect(result.reportOnly).toBeNull();
  });

  it('generates diff for enforced CSP with enforce-disposition violations', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "default-src 'self'; script-src 'self'",
      sourceUrl: 'https://example.com',
    });

    // Enforced violation (disposition: enforce)
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
      disposition: 'enforce',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });

    expect(result.enforced).not.toBeNull();
    expect(result.enforced!.violationCount).toBe(1);
    expect(result.enforced!.existingDirectives['script-src']).toEqual(["'self'"]);
    // Merged should include the new source
    const scriptChange = result.enforced!.diff.changedDirectives.find(
      (d) => d.directive === 'script-src',
    );
    expect(scriptChange).toBeDefined();
  });

  it('filters enforce violations to enforced result only', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    // Both header types present
    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self'",
      sourceUrl: 'https://example.com',
    });
    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'report-only',
      headerValue: "script-src 'self'",
      sourceUrl: 'https://example.com',
    });

    // Violation from enforced CSP only
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/enforced.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
      disposition: 'enforce',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });

    // Enforced should have the violation
    expect(result.enforced!.violationCount).toBe(1);
    // Report-only should have zero violations — no changes from violations
    expect(result.reportOnly!.violationCount).toBe(0);
  });

  it('filters report violations to report-only result only', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self'",
      sourceUrl: 'https://example.com',
    });
    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'report-only',
      headerValue: "script-src 'self'",
      sourceUrl: 'https://example.com',
    });

    // Violation from report-only CSP
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/report-only.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
      disposition: 'report',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });

    // Enforced should have zero violations
    expect(result.enforced!.violationCount).toBe(0);
    // Report-only should have the violation
    expect(result.reportOnly!.violationCount).toBe(1);
  });

  it('handles both enforced and report-only violations independently', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self'",
      sourceUrl: 'https://example.com',
    });
    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'report-only',
      headerValue: "script-src 'self' https://cdn.example.com",
      sourceUrl: 'https://example.com',
    });

    // Enforced violation
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/blocked.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
      disposition: 'enforce',
    });

    // Report-only violation (different source)
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://analytics.example.com/track.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
      disposition: 'report',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });

    expect(result.violationsFound).toBe(2);
    expect(result.enforced!.violationCount).toBe(1);
    expect(result.reportOnly!.violationCount).toBe(1);

    // Enforced merged should contain cdn.example.com source
    const enforcedScriptSrc = result.enforced!.mergedDirectives['script-src'];
    expect(enforcedScriptSrc).toBeDefined();

    // Report-only merged should contain analytics.example.com source
    const reportOnlyScriptSrc = result.reportOnly!.mergedDirectives['script-src'];
    expect(reportOnlyScriptSrc).toBeDefined();
  });

  it('handles report-only CSP separately', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'report-only',
      headerValue: "default-src 'self'",
      sourceUrl: 'https://example.com',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });
    expect(result.enforced).toBeNull();
    expect(result.reportOnly).not.toBeNull();
    expect(result.reportOnly!.existingDirectives['default-src']).toEqual(["'self'"]);
  });

  it('strips unsafe-inline in strict mode', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "default-src 'self'; script-src 'self' 'unsafe-inline'",
      sourceUrl: 'https://example.com',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'strict' });

    expect(result.enforced).not.toBeNull();
    expect(result.enforced!.mergedDirectives['script-src']).not.toContain("'unsafe-inline'");
  });

  it('keeps unsafe-inline in moderate mode', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self' 'unsafe-inline'",
      sourceUrl: 'https://example.com',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });

    expect(result.enforced).not.toBeNull();
    expect(result.enforced!.mergedDirectives['script-src']).toContain("'unsafe-inline'");
  });

  it('includes inline hashes in strict mode', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self' 'unsafe-inline'",
      sourceUrl: 'https://example.com',
    });

    insertInlineHash(db, {
      sessionId,
      pageId: null,
      directive: 'script-src',
      hash: 'abc123base64hash',
      contentLength: 42,
    });

    // Need an enforce violation to trigger policy generation for enforced
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'inline',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
      disposition: 'enforce',
      sample: 'console.log("test")',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'strict' });

    expect(result.enforced).not.toBeNull();
    const scriptSrc = result.enforced!.mergedDirectives['script-src'];
    expect(scriptSrc).toContain("'sha256-abc123base64hash'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('unions multiple CSP headers from different pages', () => {
    const sessionId = createCompletedAuditSession('https://example.com');

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self' https://a.com",
      sourceUrl: 'https://example.com/',
    });

    insertExistingCspHeader(db, {
      sessionId,
      pageId: null,
      headerType: 'enforced',
      headerValue: "script-src 'self' https://b.com",
      sourceUrl: 'https://example.com/page2',
    });

    const result = generateAuditResult(db, sessionId, { strictness: 'moderate' });

    expect(result.enforced).not.toBeNull();
    expect(result.enforced!.existingDirectives['script-src']).toEqual(
      expect.arrayContaining(["'self'", 'https://a.com', 'https://b.com']),
    );
  });

  it('throws for non-existent session', () => {
    expect(() =>
      generateAuditResult(db, 'non-existent-id', { strictness: 'moderate' }),
    ).toThrow('Session not found');
  });
});

describe('formatAuditResult', () => {
  it('formats result with no CSP headers found', () => {
    const output = formatAuditResult({
      sessionId: 'test-session',
      pagesVisited: 5,
      violationsFound: 0,
      enforced: null,
      reportOnly: null,
    });
    expect(output).toContain('No existing CSP headers were found');
    expect(output).toContain('crawl');
  });

  it('formats result with enforced CSP changes', () => {
    const output = formatAuditResult({
      sessionId: 'test-session',
      pagesVisited: 3,
      violationsFound: 2,
      enforced: {
        existingDirectives: { 'default-src': ["'self'"] },
        mergedDirectives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://cdn.example.com'],
        },
        diff: {
          addedDirectives: ['script-src'],
          removedDirectives: [],
          changedDirectives: [],
          unchangedDirectives: ['default-src'],
        },
        violationCount: 2,
      },
      reportOnly: null,
    });
    expect(output).toContain('Enforced CSP');
    expect(output).toContain('Content-Security-Policy');
    expect(output).toContain('Violations: 2');
    expect(output).toContain('script-src');
    expect(output).toContain('Updated policy');
  });

  it('formats result with both enforced and report-only', () => {
    const output = formatAuditResult({
      sessionId: 'test-session',
      pagesVisited: 1,
      violationsFound: 3,
      enforced: {
        existingDirectives: { 'default-src': ["'self'"] },
        mergedDirectives: { 'default-src': ["'self'"] },
        diff: {
          addedDirectives: [],
          removedDirectives: [],
          changedDirectives: [],
          unchangedDirectives: ['default-src'],
        },
        violationCount: 1,
      },
      reportOnly: {
        existingDirectives: { 'default-src': ["'self'"] },
        mergedDirectives: { 'default-src': ["'self'"] },
        diff: {
          addedDirectives: [],
          removedDirectives: [],
          changedDirectives: [],
          unchangedDirectives: ['default-src'],
        },
        violationCount: 2,
      },
    });
    expect(output).toContain('Enforced CSP');
    expect(output).toContain('Violations: 1');
    expect(output).toContain('Report-Only CSP');
    expect(output).toContain('Violations: 2');
    expect(output).toContain('Content-Security-Policy-Report-Only');
  });

  it('shows violation count per header type', () => {
    const output = formatAuditResult({
      sessionId: 'test-session',
      pagesVisited: 1,
      violationsFound: 5,
      enforced: {
        existingDirectives: { 'script-src': ["'self'"] },
        mergedDirectives: { 'script-src': ["'self'"] },
        diff: {
          addedDirectives: [],
          removedDirectives: [],
          changedDirectives: [],
          unchangedDirectives: ['script-src'],
        },
        violationCount: 0,
      },
      reportOnly: null,
    });
    expect(output).toContain('Violations: 0');
  });
});
