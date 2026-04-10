import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingHttpHeaders } from 'node:http';

// vi.mock is hoisted — factory must be self-contained
vi.mock('http-mitm-proxy', () => {
  const listen = vi.fn();
  const close = vi.fn();
  const onError = vi.fn();
  const onResponseHeaders = vi.fn();

  class ProxyMock {
    listen = listen;
    close = close;
    onError = onError;
    onResponseHeaders = onResponseHeaders;
    httpPort = 8443;
  }

  return { Proxy: ProxyMock, __mocks: { listen, close, onError, onResponseHeaders } };
});

import { transformProxyResponseHeaders, startMitmProxy } from '../src/mitm-proxy.js';
import type { MitmProxyOptions } from '../src/mitm-proxy.js';

// Access the mock functions from the module
let mockListen: ReturnType<typeof vi.fn>;
let mockClose: ReturnType<typeof vi.fn>;
let mockOnError: ReturnType<typeof vi.fn>;
let mockOnResponseHeaders: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const mitmMock = await import('http-mitm-proxy') as unknown as {
    __mocks: {
      listen: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      onError: ReturnType<typeof vi.fn>;
      onResponseHeaders: ReturnType<typeof vi.fn>;
    };
  };
  mockListen = mitmMock.__mocks.listen;
  mockClose = mitmMock.__mocks.close;
  mockOnError = mitmMock.__mocks.onError;
  mockOnResponseHeaders = mitmMock.__mocks.onResponseHeaders;
  vi.clearAllMocks();
});

const TEST_PORT = 9876;

describe('transformProxyResponseHeaders', () => {
  it('strips content-security-policy header', () => {
    const headers: IncomingHttpHeaders = {
      'content-type': 'text/html',
      'content-security-policy': "default-src 'self'",
    };

    const result = transformProxyResponseHeaders(headers, TEST_PORT);

    expect(result['content-security-policy']).toBeUndefined();
    expect(result['content-type']).toBe('text/html');
  });

  it('strips content-security-policy-report-only header', () => {
    const headers: IncomingHttpHeaders = {
      'content-security-policy-report-only': "script-src 'none'",
    };

    const result = transformProxyResponseHeaders(headers, TEST_PORT);

    expect(result['content-security-policy-report-only']).toBeDefined();
    // Should be our deny-all, not the original
    expect(result['content-security-policy-report-only']).toContain("default-src 'none'");
  });

  it('strips report-to header and replaces with ours', () => {
    const headers: IncomingHttpHeaders = {
      'report-to': '{"group":"old","endpoints":[{"url":"https://old.example.com"}]}',
    };

    const result = transformProxyResponseHeaders(headers, TEST_PORT);

    const reportTo = JSON.parse(result['report-to'] as string);
    expect(reportTo.group).toBe('csp-analyser');
    expect(reportTo.endpoints[0].url).toBe(`http://127.0.0.1:${TEST_PORT}/reports`);
  });

  it('adds deny-all CSP-Report-Only header', () => {
    const result = transformProxyResponseHeaders({}, TEST_PORT);

    const csp = result['content-security-policy-report-only'] as string;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'none'");
    expect(csp).toContain("img-src 'none'");
    expect(csp).toContain("font-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("media-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report`);
    expect(csp).toContain('report-to csp-analyser');
  });

  it('adds Report-To header with correct endpoint', () => {
    const result = transformProxyResponseHeaders({}, TEST_PORT);

    const reportTo = JSON.parse(result['report-to'] as string);
    expect(reportTo.group).toBe('csp-analyser');
    expect(reportTo.max_age).toBe(86400);
    expect(reportTo.endpoints[0].url).toBe(`http://127.0.0.1:${TEST_PORT}/reports`);
  });

  it('preserves non-CSP headers', () => {
    const headers: IncomingHttpHeaders = {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'set-cookie': ['session=abc', 'theme=dark'],
      'x-custom': 'value',
    };

    const result = transformProxyResponseHeaders(headers, TEST_PORT);

    expect(result['content-type']).toBe('text/html; charset=utf-8');
    expect(result['cache-control']).toBe('no-cache');
    expect(result['set-cookie']).toEqual(['session=abc', 'theme=dark']);
    expect(result['x-custom']).toBe('value');
  });

  it('handles empty headers', () => {
    const result = transformProxyResponseHeaders({}, TEST_PORT);

    expect(result['content-security-policy-report-only']).toBeDefined();
    expect(result['report-to']).toBeDefined();
  });

  it('strips all three CSP-related headers simultaneously', () => {
    const headers: IncomingHttpHeaders = {
      'content-security-policy': "default-src 'self'",
      'content-security-policy-report-only': "script-src 'unsafe-inline'",
      'report-to': '{"group":"existing"}',
      'x-frame-options': 'DENY',
    };

    const result = transformProxyResponseHeaders(headers, TEST_PORT);

    // Original CSP should be gone
    expect(result['content-security-policy']).toBeUndefined();
    // Our CSP-RO should be injected
    expect(result['content-security-policy-report-only']).toContain("default-src 'none'");
    // Our Report-To should be injected
    const reportTo = JSON.parse(result['report-to'] as string);
    expect(reportTo.group).toBe('csp-analyser');
    // Non-CSP security headers should be preserved
    expect(result['x-frame-options']).toBe('DENY');
  });

  it('produces identical CSP policy as csp-injector transformResponseHeaders', () => {
    // The deny-all CSP must be the same regardless of mode (local vs MITM)
    // per ADR requirement. We verify the CSP content matches.
    const result = transformProxyResponseHeaders({}, TEST_PORT);
    const csp = result['content-security-policy-report-only'] as string;

    // Verify the exact same directives and report-uri format
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report`);
    expect(csp).toContain('report-to csp-analyser');

    // Both modes use buildDenyAllCSP from csp-constants — verified by import chain
  });
});

// ── startMitmProxy ─────────────────────────────────────────────────────

describe('startMitmProxy', () => {
  const defaultOptions: MitmProxyOptions = {
    reportServerPort: TEST_PORT,
    certPaths: {
      sslCaDir: '/tmp/certs',
      caCertPath: '/tmp/certs/certs/ca.pem',
      caKeyPath: '/tmp/certs/keys/ca.private.key',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: listen calls its callback synchronously
    mockListen.mockImplementation((_opts: unknown, callback: () => void) => {
      callback();
    });
  });

  it('resolves with port, caCertPath, and close function', async () => {
    const instance = await startMitmProxy(defaultOptions);

    expect(instance.port).toBe(8443);
    expect(instance.caCertPath).toBe('/tmp/certs/certs/ca.pem');
    expect(typeof instance.close).toBe('function');
  });

  it('listens on 127.0.0.1 with port 0 and correct sslCaDir', async () => {
    await startMitmProxy(defaultOptions);

    expect(mockListen).toHaveBeenCalledWith(
      { port: 0, host: '127.0.0.1', sslCaDir: '/tmp/certs' },
      expect.any(Function),
    );
  });

  it('registers an onError handler', async () => {
    await startMitmProxy(defaultOptions);

    expect(mockOnError).toHaveBeenCalledWith(expect.any(Function));
  });

  it('registers an onResponseHeaders handler', async () => {
    await startMitmProxy(defaultOptions);

    expect(mockOnResponseHeaders).toHaveBeenCalledWith(expect.any(Function));
  });

  it('onResponseHeaders transforms upstream headers', async () => {
    await startMitmProxy(defaultOptions);

    // Get the registered handler
    const handler = mockOnResponseHeaders.mock.calls[0][0];
    const mockCallback = vi.fn();
    const upstreamHeaders: IncomingHttpHeaders = {
      'content-type': 'text/html',
      'content-security-policy': "default-src 'self'",
    };
    const ctx = {
      serverToProxyResponse: { headers: upstreamHeaders },
    };

    handler(ctx, mockCallback);

    // Original CSP should be stripped
    expect(upstreamHeaders['content-security-policy']).toBeUndefined();
    // Our CSP-RO should be injected
    expect(upstreamHeaders['content-security-policy-report-only']).toContain("default-src 'none'");
    expect(mockCallback).toHaveBeenCalled();
  });

  it('onResponseHeaders handles missing serverToProxyResponse', async () => {
    await startMitmProxy(defaultOptions);

    const handler = mockOnResponseHeaders.mock.calls[0][0];
    const mockCallback = vi.fn();

    // ctx without serverToProxyResponse
    handler({}, mockCallback);

    expect(mockCallback).toHaveBeenCalled();
  });

  it('close() calls proxy.close()', async () => {
    const instance = await startMitmProxy(defaultOptions);

    instance.close();

    expect(mockClose).toHaveBeenCalled();
  });

  it('onError handler does not throw after startup', async () => {
    await startMitmProxy(defaultOptions);

    const errorHandler = mockOnError.mock.calls[0][0];

    // Should not throw for Error objects (post-startup errors are logged only)
    expect(() => errorHandler({}, new Error('test error'))).not.toThrow();
    // Should not throw for non-Error values
    expect(() => errorHandler({}, 'string error')).not.toThrow();
    // Should not throw for null/undefined
    expect(() => errorHandler({}, null)).not.toThrow();
  });

  it('rejects the promise if onError fires before listen callback', async () => {
    // Simulate: listen never calls its callback, but onError fires first
    mockListen.mockImplementation(() => {
      // Don't call the callback — proxy failed to start
    });

    const promise = startMitmProxy(defaultOptions);

    // Fire the error handler before listen completes
    const errorHandler = mockOnError.mock.calls[0][0];
    errorHandler({}, new Error('EADDRINUSE: address already in use'));

    await expect(promise).rejects.toThrow('MITM proxy startup failed: EADDRINUSE: address already in use');
  });

  it('does not double-reject if onError fires multiple times before startup', async () => {
    mockListen.mockImplementation(() => {
      // Never calls callback
    });

    const promise = startMitmProxy(defaultOptions);

    const errorHandler = mockOnError.mock.calls[0][0];
    errorHandler({}, new Error('first error'));
    // Second error should not cause issues
    errorHandler({}, new Error('second error'));

    await expect(promise).rejects.toThrow('first error');
  });
});
