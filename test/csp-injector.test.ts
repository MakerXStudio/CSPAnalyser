import { describe, it, expect, vi } from 'vitest';
import {
  transformResponseHeaders,
  setupCspInjection,
  type PlaywrightPage,
  type PlaywrightRoute,
  type PlaywrightResponse,
} from '../src/csp-injector.js';

const TEST_PORT = 9876;

// ── transformResponseHeaders ─────────────────────────────────────────────

describe('transformResponseHeaders', () => {
  it('strips existing CSP headers', () => {
    const headers = {
      'Content-Type': 'text/html',
      'content-security-policy': "default-src 'self'",
      'content-security-policy-report-only': "script-src 'none'",
      'report-to': '{"group":"old"}',
    };

    const result = transformResponseHeaders(headers, TEST_PORT);

    expect(result['Content-Type']).toBe('text/html');
    expect(result['content-security-policy']).toBeUndefined();
  });

  it('strips CSP headers case-insensitively', () => {
    const headers = {
      'Content-Security-Policy': "default-src 'self'",
      'Report-To': '{"group":"old"}',
    };

    const result = transformResponseHeaders(headers, TEST_PORT);

    expect(result['Content-Security-Policy']).toBeUndefined();
    expect(result['Report-To']).toBeUndefined();
  });

  it('adds CSP-Report-Only header with deny-all policy', () => {
    const result = transformResponseHeaders({}, TEST_PORT);

    const csp = result['content-security-policy-report-only'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'none'");
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report`);
    expect(csp).toContain('report-to csp-analyser');
  });

  it('adds Report-To header pointing to report server', () => {
    const result = transformResponseHeaders({}, TEST_PORT);

    const reportTo = JSON.parse(result['report-to']!);
    expect(reportTo.group).toBe('csp-analyser');
    expect(reportTo.endpoints[0].url).toBe(`http://127.0.0.1:${TEST_PORT}/reports`);
    expect(reportTo.max_age).toBe(86400);
  });

  it('preserves non-CSP headers', () => {
    const headers = {
      'X-Custom': 'value',
      'Cache-Control': 'no-cache',
      'Set-Cookie': 'session=abc',
    };

    const result = transformResponseHeaders(headers, TEST_PORT);

    expect(result['X-Custom']).toBe('value');
    expect(result['Cache-Control']).toBe('no-cache');
    expect(result['Set-Cookie']).toBe('session=abc');
  });

  it('handles empty headers', () => {
    const result = transformResponseHeaders({}, TEST_PORT);

    expect(result['content-security-policy-report-only']).toBeDefined();
    expect(result['report-to']).toBeDefined();
  });

  it('includes token in report-uri and report-to URLs when provided', () => {
    const token = 'test-token-abc';
    const result = transformResponseHeaders({}, TEST_PORT, token);

    const csp = result['content-security-policy-report-only'];
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report/${token}`);

    const reportTo = JSON.parse(result['report-to']!);
    expect(reportTo.endpoints[0].url).toBe(`http://127.0.0.1:${TEST_PORT}/reports/${token}`);
  });

  it('omits token from URLs when not provided', () => {
    const result = transformResponseHeaders({}, TEST_PORT);

    const csp = result['content-security-policy-report-only'];
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report`);
    expect(csp).not.toContain('/csp-report/');

    const reportTo = JSON.parse(result['report-to']!);
    expect(reportTo.endpoints[0].url).toBe(`http://127.0.0.1:${TEST_PORT}/reports`);
  });
});

// ── setupCspInjection ────────────────────────────────────────────────────

describe('setupCspInjection', () => {
  function createMockPage() {
    const routes: Array<{ url: string | RegExp; handler: (route: PlaywrightRoute) => Promise<void> | void }> = [];

    const page: PlaywrightPage = {
      route: vi.fn(async (url, handler) => {
        routes.push({ url, handler });
      }),
      unroute: vi.fn(async () => {
        routes.length = 0;
      }),
    };

    return { page, routes };
  }

  function createMockRoute(responseHeaders: Record<string, string> = {}): PlaywrightRoute {
    const mockResponse: PlaywrightResponse = {
      status: () => 200,
      headers: () => responseHeaders,
      body: async () => Buffer.from('<html></html>'),
    };

    return {
      fetch: vi.fn(async () => mockResponse),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      request: () => ({ url: () => 'https://example.com/page' }),
    };
  }

  it('registers a route handler on **/*', async () => {
    const { page } = createMockPage();

    await setupCspInjection(page, TEST_PORT);

    expect(page.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('returns a cleanup function that calls unroute', async () => {
    const { page } = createMockPage();

    const cleanup = await setupCspInjection(page, TEST_PORT);
    await cleanup();

    expect(page.unroute).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('route handler fetches response and transforms headers', async () => {
    const { page, routes } = createMockPage();
    const mockRoute = createMockRoute({
      'Content-Type': 'text/html',
      'content-security-policy': "default-src 'self'",
    });

    await setupCspInjection(page, TEST_PORT);

    // Invoke the registered handler
    const handler = routes[0]!.handler;
    await handler(mockRoute);

    expect(mockRoute.fetch).toHaveBeenCalled();
    expect(mockRoute.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'text/html',
          'content-security-policy-report-only': expect.stringContaining("default-src 'none'"),
          'report-to': expect.any(String),
        }),
      }),
    );

    // Original CSP should be stripped
    const fulfillCall = vi.mocked(mockRoute.fulfill).mock.calls[0]![0];
    expect(fulfillCall.headers!['content-security-policy']).toBeUndefined();
  });

  it('passes token through to transformed headers', async () => {
    const { page, routes } = createMockPage();
    const mockRoute = createMockRoute({ 'Content-Type': 'text/html' });
    const token = 'session-token-xyz';

    await setupCspInjection(page, TEST_PORT, token);

    const handler = routes[0]!.handler;
    await handler(mockRoute);

    const fulfillCall = vi.mocked(mockRoute.fulfill).mock.calls[0]![0];
    const csp = fulfillCall.headers!['content-security-policy-report-only'];
    expect(csp).toContain(`/csp-report/${token}`);

    const reportTo = JSON.parse(fulfillCall.headers!['report-to']!);
    expect(reportTo.endpoints[0].url).toContain(`/reports/${token}`);
  });

  it('handles route handler errors gracefully by continuing', async () => {
    const { page, routes } = createMockPage();
    const mockRoute: PlaywrightRoute = {
      fetch: vi.fn(async () => { throw new Error('Network error'); }),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      request: () => ({ url: () => 'https://example.com/fail' }),
    };

    await setupCspInjection(page, TEST_PORT);

    const handler = routes[0]!.handler;
    // Should not throw
    await handler(mockRoute);

    // Should call continue() to let the request proceed unmodified
    expect(mockRoute.continue).toHaveBeenCalled();
    // Should NOT call fulfill() with empty response
    expect(mockRoute.fulfill).not.toHaveBeenCalled();
  });

  it('strips query params from URLs in error logs', async () => {
    const { page, routes } = createMockPage();

    // Capture logger output
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const mockRoute: PlaywrightRoute = {
      fetch: vi.fn(async () => { throw new Error('Connection reset'); }),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      request: () => ({ url: () => 'https://example.com/api?token=secret123&session=abc' }),
    };

    await setupCspInjection(page, TEST_PORT);
    await routes[0]!.handler(mockRoute);

    // Find the error log entry
    const logCalls = stderrWrite.mock.calls.map(c => String(c[0]));
    const errorLog = logCalls.find(c => c.includes('CSP injection route handler failed'));

    expect(errorLog).toBeDefined();
    expect(errorLog).not.toContain('secret123');
    expect(errorLog).not.toContain('session=abc');
    expect(errorLog).toContain('https://example.com/api');

    stderrWrite.mockRestore();
  });
});
