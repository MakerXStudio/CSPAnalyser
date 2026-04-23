import { describe, it, expect, vi } from 'vitest';
import {
  setupCspPassthrough,
  transformResponseHeadersForAudit,
} from '../src/csp-passthrough.js';
import type {
  PlaywrightPage,
  PlaywrightRoute,
  PlaywrightResponse,
} from '../src/csp-injector.js';

const TEST_PORT = 9876;
const TEST_TOKEN = 'test-token-123';

describe('transformResponseHeadersForAudit', () => {
  it('preserves existing enforced CSP header', () => {
    const headers = {
      'Content-Type': 'text/html',
      'content-security-policy': "default-src 'self'; script-src 'self' https://cdn.example.com",
    };

    const { headers: result, capturedCspHeaders } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    // CSP header should still be present (not stripped)
    expect(result['content-security-policy']).toBeDefined();
    expect(result['content-security-policy']).toContain("default-src 'self'");
    expect(result['content-security-policy']).toContain("script-src 'self' https://cdn.example.com");

    // Should capture original value
    expect(capturedCspHeaders).toHaveLength(1);
    expect(capturedCspHeaders[0].headerType).toBe('enforced');
    expect(capturedCspHeaders[0].headerValue).toBe(
      "default-src 'self'; script-src 'self' https://cdn.example.com",
    );
  });

  it('preserves existing report-only CSP header', () => {
    const headers = {
      'content-security-policy-report-only': "default-src 'self'",
    };

    const { capturedCspHeaders } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    expect(capturedCspHeaders).toHaveLength(1);
    expect(capturedCspHeaders[0].headerType).toBe('report-only');
  });

  it('captures both enforced and report-only headers', () => {
    const headers = {
      'content-security-policy': "default-src 'self'",
      'content-security-policy-report-only': "script-src 'none'",
    };

    const { capturedCspHeaders } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    expect(capturedCspHeaders).toHaveLength(2);
    const types = capturedCspHeaders.map((h) => h.headerType);
    expect(types).toContain('enforced');
    expect(types).toContain('report-only');
  });

  it('appends report-uri and report-to to existing CSP', () => {
    const headers = {
      'content-security-policy': "default-src 'self'",
    };

    const { headers: result } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    const csp = result['content-security-policy'];
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report/${TEST_TOKEN}`);
    expect(csp).toContain('report-to csp-analyser');
  });

  it('replaces existing report-uri with ours', () => {
    const headers = {
      'content-security-policy': "default-src 'self'; report-uri /old-report",
    };

    const { headers: result } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    const csp = result['content-security-policy'];
    expect(csp).not.toContain('/old-report');
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report/${TEST_TOKEN}`);
  });

  it('strips existing Report-To header and adds ours', () => {
    const headers = {
      'content-security-policy': "default-src 'self'",
      'report-to': '{"group":"old-group"}',
    };

    const { headers: result } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    // Old Report-To should be replaced
    const reportTo = JSON.parse(result['report-to']);
    expect(reportTo.group).toBe('csp-analyser');
    expect(reportTo.endpoints[0].url).toBe(
      `http://127.0.0.1:${TEST_PORT}/reports/${TEST_TOKEN}`,
    );
  });

  it('returns empty captured headers when no CSP present', () => {
    const headers = {
      'Content-Type': 'text/html',
    };

    const { capturedCspHeaders } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    expect(capturedCspHeaders).toHaveLength(0);
  });

  it('captures permissions-policy headers', () => {
    const headers = {
      'content-security-policy': "default-src 'self'",
      'permissions-policy': 'camera=(), microphone=()',
    };

    const { permissionsPolicies } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    expect(permissionsPolicies).toHaveLength(1);
    expect(permissionsPolicies[0].headerName).toBe('permissions-policy');
    expect(permissionsPolicies[0].headerValue).toBe('camera=(), microphone=()');
  });

  it('preserves non-CSP headers', () => {
    const headers = {
      'Content-Type': 'text/html',
      'X-Frame-Options': 'DENY',
      'content-security-policy': "default-src 'self'",
    };

    const { headers: result } = transformResponseHeadersForAudit(
      headers,
      TEST_PORT,
      TEST_TOKEN,
    );

    expect(result['Content-Type']).toBe('text/html');
    expect(result['X-Frame-Options']).toBe('DENY');
  });

  it('works without token', () => {
    const headers = {
      'content-security-policy': "default-src 'self'",
    };

    const { headers: result } = transformResponseHeadersForAudit(headers, TEST_PORT);

    const csp = result['content-security-policy'];
    expect(csp).toContain(`report-uri http://127.0.0.1:${TEST_PORT}/csp-report`);
  });
});

// ── setupCspPassthrough: non-target-origin handling ─────────────────────

describe('setupCspPassthrough non-target origin delegation', () => {
  const TARGET = 'https://app.example.com';

  function createMockPage() {
    const routes: Array<{
      url: string | RegExp;
      handler: (route: PlaywrightRoute) => Promise<void> | void;
    }> = [];

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

  function createMockResponse(
    status: number,
    headers: Record<string, string> = {},
  ): PlaywrightResponse {
    return {
      status: () => status,
      headers: () => headers,
      body: async () => Buffer.from(''),
    };
  }

  function createMockRoute(
    url: string,
    resourceType: string,
    response: PlaywrightResponse,
  ): PlaywrightRoute {
    return {
      fetch: vi.fn(async () => response),
      fulfill: vi.fn(async () => {}),
      continue: vi.fn(async () => {}),
      request: () => ({ url: () => url, resourceType: () => resourceType }),
    };
  }

  it('rewrites a 302 from a non-target origin back to target as JS navigation', async () => {
    const { page, routes } = createMockPage();
    await setupCspPassthrough(page, TEST_PORT, TEST_TOKEN, undefined, undefined, TARGET);

    const redirectResponse = createMockResponse(302, {
      location: `${TARGET}/auth/callback?code=abc`,
    });
    const route = createMockRoute(
      'https://idp.example.com/auth',
      'document',
      redirectResponse,
    );

    await routes[0]!.handler(route);

    const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
    expect(fulfillCall?.status).toBe(200);
    expect(fulfillCall?.body).toContain(
      `window.location.href="${TARGET}/auth/callback?code=abc"`,
    );
    // The pre-refactor behaviour was route.continue() — that would have meant
    // CSP on the post-redirect page was missed. Ensure we don't do that now.
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('passes through non-document requests on non-target origins', async () => {
    const { page, routes } = createMockPage();
    await setupCspPassthrough(page, TEST_PORT, TEST_TOKEN, undefined, undefined, TARGET);

    const route = createMockRoute(
      'https://idp.example.com/static.css',
      'stylesheet',
      createMockResponse(200),
    );

    await routes[0]!.handler(route);

    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.fetch).not.toHaveBeenCalled();
  });
});
