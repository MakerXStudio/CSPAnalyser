/**
 * Edge case tests targeting uncovered lines and untested paths.
 *
 * Coverage targets:
 * - cli.ts: lines 204, 230 (onProgress callbacks)
 * - crawler.ts: line 96, sanitizeErrorMessage (60% func coverage)
 * - csp-injector.ts: line 105 (invalid URL in error handler)
 * - report-server.ts: lines 48-49 (server address edge case)
 * - session-manager.ts: line 158 (onPageLoaded callback)
 * - repository.ts: line 120 (unreachable guard)
 * - mcp-server.ts: additional tool handler paths
 * - URL edge cases: Unicode, malformed, special characters
 * - Large violation counts, empty/null fields
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../src/db/schema.js';
import {
  createDatabase,
  createSession,
  getSession,
  updateSession,
  insertPage,
  insertViolation,
  getViolations,
  getViolationSummary,
  getPages,
  insertPolicy,
  getPolicy,
  listSessions,
} from '../src/db/repository.js';
import { startReportServer } from '../src/report-server.js';
import {
  setupCspInjection,
  type PlaywrightPage,
  type PlaywrightRoute,
} from '../src/csp-injector.js';
import {
  extractOrigin,
  isSameOrigin,
  shouldUseMitmMode,
  generateWildcardDomain,
  normalizeBlockedUri,
} from '../src/utils/url-utils.js';
import { parseCspReport, parseReportingApiReport, parseDomViolation } from '../src/report-parser.js';
import { generatePolicyFromViolations } from '../src/policy-generator.js';
import { optimizePolicy } from '../src/policy-optimizer.js';
import { formatPolicy, directivesToString } from '../src/policy-formatter.js';
import type { Violation } from '../src/types.js';
import type { SessionDeps } from '../src/session-manager.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: '1',
    sessionId: 'sess-1',
    pageId: null,
    documentUri: 'https://example.com/page',
    blockedUri: 'https://cdn.example.com/script.js',
    violatedDirective: 'script-src',
    effectiveDirective: 'script-src',
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: null,
    capturedVia: 'report_uri',
    rawReport: '{}',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── URL edge cases: malformed URLs ─────────────────────────────────────────

describe('URL handling edge cases', () => {
  it('extractOrigin throws on completely invalid URL', () => {
    expect(() => extractOrigin('not-a-url')).toThrow();
  });

  it('extractOrigin handles URL with unicode hostname', () => {
    const origin = extractOrigin('https://münchen.de/path');
    expect(origin).toContain('xn--');
  });

  it('extractOrigin handles URL with port', () => {
    expect(extractOrigin('https://example.com:8443/path')).toBe('https://example.com:8443');
  });

  it('isSameOrigin returns false for different ports', () => {
    expect(isSameOrigin('https://example.com:443/a', 'https://example.com:8443/b')).toBe(false);
  });

  it('isSameOrigin with trailing slashes and paths', () => {
    expect(isSameOrigin('https://example.com/a/b', 'https://example.com/c')).toBe(true);
  });

  it('generateWildcardDomain handles IP addresses', () => {
    expect(generateWildcardDomain('192.168.1.1')).toBe('*.168.1.1');
  });

  it('generateWildcardDomain handles single-label hostname', () => {
    expect(generateWildcardDomain('localhost')).toBe('localhost');
  });

  it('generateWildcardDomain handles two-label hostname', () => {
    expect(generateWildcardDomain('example.com')).toBe('example.com');
  });

  it('normalizeBlockedUri handles unicode blocked URIs', () => {
    const result = normalizeBlockedUri('https://例え.jp/script.js');
    expect(result).toBe('https://例え.jp/script.js');
  });

  it('normalizeBlockedUri handles empty string', () => {
    expect(normalizeBlockedUri('')).toBe("'none'");
  });

  it('normalizeBlockedUri handles about', () => {
    expect(normalizeBlockedUri('about')).toBe("'none'");
  });

  it('normalizeBlockedUri handles filesystem:', () => {
    expect(normalizeBlockedUri('filesystem:https://example.com/file')).toBe('filesystem:');
  });

  it('normalizeBlockedUri handles mediastream:', () => {
    expect(normalizeBlockedUri('mediastream:id')).toBe('mediastream:');
  });

  it('shouldUseMitmMode returns false for http localhost', () => {
    expect(shouldUseMitmMode('http://localhost:3000')).toBe(false);
  });

  it('shouldUseMitmMode returns false for http remote', () => {
    expect(shouldUseMitmMode('http://example.com')).toBe(false);
  });

  it('shouldUseMitmMode returns false for https localhost', () => {
    expect(shouldUseMitmMode('https://localhost:3000')).toBe(false);
  });

  it('shouldUseMitmMode returns false for https remote (local mode is default)', () => {
    expect(shouldUseMitmMode('https://example.com')).toBe(false);
  });

  it('shouldUseMitmMode returns false for https [::1]', () => {
    expect(shouldUseMitmMode('https://[::1]:3000')).toBe(false);
  });
});

// ── CSP injector: line 105 (invalid URL in error path) ────────────────────

describe('csp-injector error path with invalid URL', () => {
  it('handles route handler error when request URL is unparseable', async () => {
    const routes: Array<{ handler: (route: PlaywrightRoute) => Promise<void> | void }> = [];
    const page: PlaywrightPage = {
      route: vi.fn(async (_url, handler) => { routes.push({ handler }); }),
      unroute: vi.fn(async () => {}),
    };

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await setupCspInjection(page, 9876);

    // Create route that throws on fetch AND has unparseable URL
    const mockRoute: PlaywrightRoute = {
      fetch: vi.fn(async () => { throw new Error('Network error'); }),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      request: () => ({ url: () => 'not-a-valid-url-at-all' }),
    };

    await routes[0]!.handler(mockRoute);

    const logCalls = stderrWrite.mock.calls.map(c => String(c[0]));
    const errorLog = logCalls.find(c => c.includes('CSP injection route handler failed'));
    expect(errorLog).toBeDefined();
    expect(errorLog).toContain('<invalid-url>');
    expect(mockRoute.continue).toHaveBeenCalled();

    stderrWrite.mockRestore();
  });

  it('handles route.continue() failure gracefully', async () => {
    const routes: Array<{ handler: (route: PlaywrightRoute) => Promise<void> | void }> = [];
    const page: PlaywrightPage = {
      route: vi.fn(async (_url, handler) => { routes.push({ handler }); }),
      unroute: vi.fn(async () => {}),
    };

    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await setupCspInjection(page, 9876);

    const mockRoute: PlaywrightRoute = {
      fetch: vi.fn(async () => { throw new Error('Fetch failed'); }),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => { throw new Error('Route already handled'); }),
      request: () => ({ url: () => 'https://example.com/page' }),
    };

    // Should not throw even if continue() throws
    await expect(routes[0]!.handler(mockRoute)).resolves.toBeUndefined();

    vi.restoreAllMocks();
  });
});

// ── Report parser: Unicode and special characters ──────────────────────────

describe('report-parser with special characters', () => {
  it('handles unicode in blocked URI', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'https://例え.jp/スクリプト.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };
    const result = parseCspReport(body, 'sess-1', null);
    expect(result).not.toBeNull();
    expect(result!.blockedUri).toBe('https://例え.jp/スクリプト.js');
  });

  it('handles unicode in document URI', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://例え.jp/ページ',
        'blocked-uri': 'https://cdn.example.com/script.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };
    const result = parseCspReport(body, 'sess-1', null);
    expect(result).not.toBeNull();
    expect(result!.documentUri).toBe('https://例え.jp/ページ');
  });

  it('handles empty blocked-uri field', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': '',
        'violated-directive': 'default-src',
        'effective-directive': 'default-src',
      },
    };
    const result = parseCspReport(body, 'sess-1', null);
    expect(result).not.toBeNull();
    // Empty blocked URI is normalized to 'none'
    expect(result!.blockedUri).toBe("'none'");
  });

  it('handles null fields in violation report', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'https://cdn.example.com/s.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
        'source-file': null,
        'line-number': null,
        'column-number': null,
      },
    };
    const result = parseCspReport(body, 'sess-1', null);
    expect(result).not.toBeNull();
    expect(result!.sourceFile).toBeNull();
    expect(result!.lineNumber).toBeNull();
    expect(result!.columnNumber).toBeNull();
  });

  it('returns null for completely empty body', () => {
    expect(parseCspReport({}, 'sess-1', null)).toBeNull();
  });

  it('returns null for body with empty csp-report', () => {
    expect(parseCspReport({ 'csp-report': {} }, 'sess-1', null)).toBeNull();
  });

  it('handles reporting API with empty blocked URL but valid document URL', () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: '',
          effectiveDirective: 'default-src',
        },
      },
    ];
    const results = parseReportingApiReport(body, 'sess-1', null);
    expect(results).toHaveLength(1);
    expect(results[0].documentUri).toBe('https://example.com/');
    // Empty blockedURL is normalized to 'none'
    expect(results[0].blockedUri).toBe("'none'");
  });

  it('skips reporting API entry with empty documentURL (required field)', () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          documentURL: '',
          blockedURL: 'https://cdn.example.com/s.js',
          effectiveDirective: 'default-src',
        },
      },
    ];
    const results = parseReportingApiReport(body, 'sess-1', null);
    // documentURL is required; empty string is falsy so it's skipped
    expect(results).toHaveLength(0);
  });

  it('returns empty array for non-csp-violation reports', () => {
    const body = [
      {
        type: 'deprecation',
        body: { id: 'some-deprecation' },
      },
    ];
    const results = parseReportingApiReport(body, 'sess-1', null);
    expect(results).toHaveLength(0);
  });

  it('returns empty array for non-array body', () => {
    const results = parseReportingApiReport('not-an-array', 'sess-1', null);
    expect(results).toHaveLength(0);
  });

  it('parseDomViolation handles special characters in sample', () => {
    const event = {
      documentURI: 'https://example.com/',
      blockedURI: 'inline',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      sourceFile: null,
      lineNumber: 0,
      columnNumber: 0,
      disposition: 'report',
      sample: '<script>alert("XSS & injection")</script>',
    };
    const result = parseDomViolation(event, 'sess-1', 'page-1');
    expect(result).not.toBeNull();
    expect(result?.sample).toBe('<script>alert("XSS & injection")</script>');
  });
});

// ── Large violation counts (stress test) ──────────────────────────────────

describe('large violation counts', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const session = createSession(db, { targetUrl: 'https://example.com' });
    sessionId = session.id;
  });

  afterEach(() => {
    db.close();
  });

  it('handles 1000+ violations in a session', () => {
    for (let i = 0; i < 1000; i++) {
      insertViolation(db, {
        sessionId,
        pageId: null,
        documentUri: 'https://example.com/',
        blockedUri: `https://cdn${i}.example.com/resource.js`,
        violatedDirective: 'script-src',
        effectiveDirective: 'script-src',
        capturedVia: 'report_uri',
      });
    }

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1000);

    const summary = getViolationSummary(db, sessionId);
    expect(summary.length).toBeGreaterThan(0);
    const scriptSrcEntries = summary.filter(s => s.effectiveDirective === 'script-src');
    expect(scriptSrcEntries.length).toBe(1000);
    // Each unique blocked URI has count 1
    const totalCount = scriptSrcEntries.reduce((sum, e) => sum + e.count, 0);
    expect(totalCount).toBe(1000);
  });

  it('generates policy from 1000+ violations', () => {
    // Use strict mode so each cdn origin stays distinct
    const violations = Array.from({ length: 1000 }, (_, i) =>
      makeViolation({
        id: String(i),
        blockedUri: `https://cdn${i % 100}.other.com/script.js`,
        effectiveDirective: 'script-src',
      }),
    );

    const result = generatePolicyFromViolations(violations, 'https://example.com', {
      strictness: 'strict',
      includeHashes: false,
    });
    expect(result['script-src']).toBeDefined();
    // In strict mode, each cdn origin is distinct
    expect(result['script-src']!.length).toBe(100);
  });

  it('handles violations across many different directives', () => {
    const directives = [
      'script-src', 'style-src', 'img-src', 'font-src',
      'connect-src', 'media-src', 'object-src', 'frame-src',
      'child-src', 'worker-src', 'manifest-src',
    ];
    const violations = directives.flatMap((d, di) =>
      Array.from({ length: 100 }, (_, i) =>
        makeViolation({
          id: `${di}-${i}`,
          blockedUri: `https://cdn${i}.example.com/resource`,
          effectiveDirective: d,
        }),
      ),
    );

    const result = generatePolicyFromViolations(violations, 'https://example.com', {
      strictness: 'strict',
      includeHashes: false,
    });

    for (const d of directives) {
      expect(result[d]).toBeDefined();
    }
  });
});

// ── Repository edge cases ─────────────────────────────────────────────────

describe('repository edge cases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates sessions with concurrent-like access patterns', () => {
    const sessions = [];
    for (let i = 0; i < 50; i++) {
      sessions.push(createSession(db, { targetUrl: `https://example${i}.com` }));
    }
    expect(sessions).toHaveLength(50);
    const allSessions = listSessions(db);
    expect(allSessions).toHaveLength(50);
  });

  it('handles unicode in target URL', () => {
    const session = createSession(db, { targetUrl: 'https://例え.jp/テスト' });
    expect(session.targetUrl).toBe('https://例え.jp/テスト');
    const retrieved = getSession(db, session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.targetUrl).toBe('https://例え.jp/テスト');
  });

  it('handles unicode in violation URIs', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    insertViolation(db, {
      sessionId: session.id,
      pageId: null,
      documentUri: 'https://example.com/パス',
      blockedUri: 'https://外部.jp/スクリプト.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'dom_event',
    });

    const violations = getViolations(db, session.id);
    expect(violations).toHaveLength(1);
    expect(violations[0].blockedUri).toBe('https://外部.jp/スクリプト.js');
    expect(violations[0].documentUri).toBe('https://example.com/パス');
  });

  it('getSession returns null for nonexistent session', () => {
    expect(getSession(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('getViolations returns empty array for nonexistent session', () => {
    expect(getViolations(db, '00000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('getPages returns empty array for nonexistent session', () => {
    expect(getPages(db, '00000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('getViolationSummary returns empty array for nonexistent session', () => {
    expect(getViolationSummary(db, '00000000-0000-0000-0000-000000000000')).toEqual([]);
  });

  it('insertPage records page with null status code', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    const page = insertPage(db, session.id, 'https://example.com/', null);
    expect(page).not.toBeNull();
    expect(page!.statusCode).toBeNull();
  });

  it('insertPolicy and getPolicy roundtrip', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    insertPolicy(db, {
      sessionId: session.id,
      directives: { 'default-src': ["'self'"] },
      policyHeader: "default-src 'self'",
      isReportOnly: false,
    });
    const policy = getPolicy(db, session.id);
    expect(policy).not.toBeNull();
    expect(policy!.directives).toEqual({ 'default-src': ["'self'"] });
  });

  it('updateSession updates status', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    updateSession(db, session.id, { status: 'crawling' });
    const updated = getSession(db, session.id);
    expect(updated!.status).toBe('crawling');
  });

  it('updateSession updates report server port', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    updateSession(db, session.id, { reportServerPort: 9876 });
    const updated = getSession(db, session.id);
    expect(updated!.reportServerPort).toBe(9876);
  });

  it('cookies in config are stripped before persisting', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const session = createSession(db, {
      targetUrl: 'https://example.com',
      cookies: [{ name: 'session', value: 'secret' }],
    });

    const retrieved = getSession(db, session.id);
    expect(retrieved).not.toBeNull();
    // The config stored in DB should not contain cookies
    const rawConfig = db.prepare('SELECT config FROM sessions WHERE id = ?').get(session.id) as { config: string } | undefined;
    expect(rawConfig).toBeDefined();
    const parsedConfig = JSON.parse(rawConfig!.config);
    expect(parsedConfig.cookies).toBeUndefined();

    stderrWrite.mockRestore();
  });
});

// ── Policy generation with zero violations ────────────────────────────────

describe('policy generation edge cases', () => {
  it('zero violations produces empty policy', () => {
    const result = generatePolicyFromViolations([], 'https://example.com', {
      strictness: 'moderate',
      includeHashes: false,
    });
    expect(result).toEqual({});
  });

  it('optimizePolicy with empty directives', () => {
    const result = optimizePolicy({});
    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
    });
  });

  it('optimizePolicy with single directive', () => {
    const result = optimizePolicy({ 'script-src': ["'self'"] });
    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'script-src': ["'self'"],
    });
  });

  it('optimizePolicy with all directives identical', () => {
    const directives: Record<string, string[]> = {};
    const fetchDirectives = [
      'script-src', 'style-src', 'img-src', 'font-src',
      'connect-src', 'media-src', 'object-src', 'frame-src',
    ];
    for (const d of fetchDirectives) {
      directives[d] = ["'self'"];
    }

    const result = optimizePolicy(directives);
    expect(result['default-src']).toEqual(["'self'"]);
    // Individual fetch directives should be collapsed
    for (const d of fetchDirectives) {
      // object-src gets re-added as a security default with 'none'
      if (d === 'object-src') {
        expect(result[d]).toEqual(["'none'"]);
      } else {
        expect(result[d]).toBeUndefined();
      }
    }
    // Security defaults for non-fetch directives
    expect(result['base-uri']).toEqual(["'self'"]);
    expect(result['form-action']).toEqual(["'self'"]);
  });

  it('formatPolicy with empty directives object', () => {
    const result = formatPolicy({}, 'header');
    expect(result).toBe('Content-Security-Policy: ');
  });

  it('directivesToString with empty directives', () => {
    const result = directivesToString({});
    expect(result).toBe('');
  });

  it('formatPolicy json with special characters in sources', () => {
    const directives = { 'default-src': ["'self'", 'https://example.com?foo=bar&baz=qux'] };
    const result = formatPolicy(directives, 'json');
    const parsed = JSON.parse(result);
    expect(parsed.directives['default-src']).toContain('https://example.com?foo=bar&baz=qux');
  });
});

// ── Session-manager onPageLoaded callback (line 158) ──────────────────────

describe('session-manager onPageLoaded callback', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeDatabase(db);
  });

  afterEach(() => {
    db.close();
  });

  it('onProgress callback fires for page visits', async () => {
    const { runSession } = await import('../src/session-manager.js');

    const mockPage = {
      route: vi.fn().mockResolvedValue(undefined),
      unroute: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      close: vi.fn().mockResolvedValue(undefined),
      $$eval: vi.fn().mockResolvedValue([]),
      exposeFunction: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    };

    const mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      addCookies: vi.fn().mockResolvedValue(undefined),
      storageState: vi.fn().mockResolvedValue({ cookies: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      newPage: vi.fn().mockResolvedValue(mockPage),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const progressMessages: string[] = [];

    const deps: SessionDeps = {
      launchBrowser: vi.fn().mockResolvedValue(mockBrowser),
      startReportServer: vi.fn().mockResolvedValue({
        port: 9876,
        token: 'test-token',
        close: vi.fn().mockResolvedValue(undefined),
      }),
      startMitmProxy: vi.fn().mockResolvedValue({
        port: 8080,
        caCertPath: '/tmp/ca.pem',
        close: vi.fn(),
      }),
      createAuthenticatedContext: vi.fn().mockResolvedValue({ context: mockContext }),
      crawl: vi.fn().mockImplementation(async (_ctx, _db, _sid, _url, _config, callbacks) => {
        // Simulate onPageLoaded being called (covers line 158)
        if (callbacks?.onPageLoaded) {
          await callbacks.onPageLoaded(mockPage, 'http://localhost:3000/test', 'page-123');
        }
        return { pagesVisited: 1, errors: [] };
      }),
      setupCspInjection: vi.fn().mockResolvedValue(vi.fn()),
      setupViolationListener: vi.fn().mockResolvedValue(undefined),
    };

    const result = await runSession(
      db,
      { targetUrl: 'http://localhost:3000' },
      { onProgress: (msg: string) => progressMessages.push(msg) },
      deps,
    );

    // Line 158: progress(`Visited: ${url}`) should fire
    expect(progressMessages).toContainEqual('Visited: http://localhost:3000/test');
    expect(result.pagesVisited).toBe(1);
  });
});

// ── CLI onProgress callbacks (lines 204, 230) ────────────────────────────

describe('CLI onProgress callbacks', () => {
  // These tests verify that the crawl and interactive commands pass
  // onProgress callbacks that write to stderr (lines 204 and 230)

  const mockRunSession = vi.fn();
  const mockGeneratePolicy = vi.fn().mockReturnValue({ 'default-src': ["'self'"] });
  const mockOptimizePolicy = vi.fn().mockImplementation((d) => d);
  const mockFormatPolicy = vi.fn().mockReturnValue("Content-Security-Policy: default-src 'self'");
  const mockCreateDatabase = vi.fn().mockReturnValue({ close: vi.fn() });

  beforeEach(() => {
    vi.doMock('../src/session-manager.js', () => ({
      runSession: (...args: unknown[]) => mockRunSession(...args),
      runInteractiveSession: (...args: unknown[]) => mockRunSession(...args),
    }));
    vi.doMock('../src/policy-generator.js', () => ({
      generatePolicy: (...args: unknown[]) => mockGeneratePolicy(...args),
    }));
    vi.doMock('../src/policy-optimizer.js', () => ({
      optimizePolicy: (...args: unknown[]) => mockOptimizePolicy(...args),
    }));
    vi.doMock('../src/policy-formatter.js', () => ({
      formatPolicy: (...args: unknown[]) => mockFormatPolicy(...args),
    }));
    vi.doMock('../src/db/repository.js', () => ({
      createDatabase: (...args: unknown[]) => mockCreateDatabase(...args),
      getSession: () => ({ targetUrl: 'https://example.com' }),
      getViolationSummary: () => [],
    }));
    vi.doMock('../src/policy-diff.js', () => ({
      compareSessions: vi.fn(),
      formatDiff: vi.fn().mockReturnValue('no changes'),
    }));
  });

  afterEach(() => {
    vi.doUnmock('../src/session-manager.js');
    vi.doUnmock('../src/policy-generator.js');
    vi.doUnmock('../src/policy-optimizer.js');
    vi.doUnmock('../src/policy-formatter.js');
    vi.doUnmock('../src/db/repository.js');
    vi.doUnmock('../src/policy-diff.js');
    vi.restoreAllMocks();
  });

  it('crawl command invokes onProgress that writes to stderr', async () => {
    // Capture the onProgress callback passed to runSession
    mockRunSession.mockImplementation(async (_db: unknown, _config: unknown, options: { onProgress?: (msg: string) => void }) => {
      // Invoke the progress callback (line 204)
      if (options.onProgress) {
        options.onProgress('Test progress message');
      }
      return {
        session: { id: 'test-session-id' },
        pagesVisited: 1,
        violationsFound: 0,
        errors: [],
      };
    });

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const { main } = await import('../src/cli.js');
    await main(['crawl', 'https://example.com']);

    // onProgress writes to stderr (now with color formatting)
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Test progress message'));

    stderrWrite.mockRestore();
    stdoutWrite.mockRestore();
  });

  it('interactive command invokes onProgress that writes to stderr', async () => {
    mockRunSession.mockImplementation(async (_db: unknown, _config: unknown, options: { onProgress?: (msg: string) => void }) => {
      if (options.onProgress) {
        options.onProgress('Interactive progress');
      }
      return {
        session: { id: 'test-session-id' },
        pagesVisited: 1,
        violationsFound: 0,
        errors: [],
      };
    });

    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const { main } = await import('../src/cli.js');
    await main(['interactive', 'https://example.com']);

    // onProgress writes to stderr (now with color formatting)
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('Interactive progress'));

    stderrWrite.mockRestore();
    stdoutWrite.mockRestore();
  });
});

// ── Report server edge cases ──────────────────────────────────────────────

describe('report-server edge cases', () => {
  let db: Database.Database;
  let sessionId: string;
  let port: number;
  let token: string;
  let close: () => Promise<void>;

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

  it('handles POST with unicode in violation data', async () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/ページ',
        'blocked-uri': 'https://外部.jp/スクリプト.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };

    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
    expect(violations[0].blockedUri).toBe('https://外部.jp/スクリプト.js');
  });

  it('handles POST with special characters that need escaping', async () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/page?a=1&b=2',
        'blocked-uri': 'https://cdn.example.com/s.js?v=1.0&t=abc',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };

    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(204);
  });

  it('handles empty reporting API array', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/reports/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/reports+json' },
      body: '[]',
    });
    expect(res.status).toBe(204);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(0);
  });

  it('handles truncated JSON gracefully', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/csp-report/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: '{"csp-report": {"document-uri": "https://example.com/",',
    });
    expect(res.status).toBe(400);
  });

  it('handles oversized JSON body in reporting API endpoint', async () => {
    const largeBody = JSON.stringify([{
      type: 'csp-violation',
      body: {
        documentURL: 'https://example.com/',
        blockedURL: 'x'.repeat(1024 * 1024),
        effectiveDirective: 'script-src',
      },
    }]);

    const res = await fetch(`http://127.0.0.1:${port}/reports/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/reports+json' },
      body: largeBody,
    });
    expect([400, 413].includes(res.status) || !res.ok).toBe(true);
  });
});

// ── MCP server additional coverage ────────────────────────────────────────

describe('mcp-server additional coverage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('get_violations with directive filter returns matching results', async () => {
    const { createMcpServer } = await import('../src/mcp-server.js');
    const server = createMcpServer(db);

    const session = createSession(db, { targetUrl: 'https://example.com' });
    insertViolation(db, {
      sessionId: session.id,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'report_uri',
    });
    insertViolation(db, {
      sessionId: session.id,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://fonts.example.com/font.woff',
      violatedDirective: 'font-src',
      effectiveDirective: 'font-src',
      capturedVia: 'report_uri',
    });

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;
    const result = await tools['get_violations'].handler(
      { sessionId: session.id, directive: 'script-src' },
      {},
    ) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(1);
    expect(data.violations[0].effectiveDirective).toBe('script-src');
  });

  it('list_sessions returns sessions with correct format', async () => {
    const { createMcpServer } = await import('../src/mcp-server.js');
    const server = createMcpServer(db);

    createSession(db, { targetUrl: 'https://a.com' });
    createSession(db, { targetUrl: 'https://b.com' });
    createSession(db, { targetUrl: 'https://c.com' });

    const tools = (server as unknown as { _registeredTools: Record<string, { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;
    const result = await tools['list_sessions'].handler({}, {}) as { content: Array<{ type: string; text: string }> };

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(3);
    expect(data.sessions).toHaveLength(3);
  });
});

// ── Crawler: sanitizeErrorMessage function coverage ──────────────────────

describe('crawler sanitizeErrorMessage coverage', () => {
  // sanitizeErrorMessage is not exported, but we can test it indirectly
  // through the crawl function's error handling

  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const session = createSession(db, { targetUrl: 'https://example.com' });
    sessionId = session.id;
  });

  afterEach(() => {
    db.close();
  });

  it('sanitizes error messages with multiple file paths', async () => {
    const { crawl } = await import('../src/crawler.js');

    const context = {
      newPage: vi.fn().mockImplementation(() => {
        return Promise.resolve({
          goto: vi.fn().mockRejectedValue(
            new Error('Error at /home/user/project/file.ts:/home/user/.cache/chromium/chrome')
          ),
          $$eval: vi.fn().mockResolvedValue([]),
          close: vi.fn().mockResolvedValue(undefined),
        });
      }),
    } as unknown as import('playwright').BrowserContext;

    const result = await crawl(context, db, sessionId, 'https://example.com/', {
      depth: 0,
      maxPages: 1,
      waitStrategy: 'load',
      settlementDelay: 0,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).not.toContain('/home/user');
    expect(result.errors[0].error).toContain('<path>');
  });
});
