import { describe, it, expect, vi } from 'vitest';
import { handleNonTargetOriginRequest } from '../src/utils/route-redirect-rewriter.js';
import type {
  PlaywrightRoute,
  PlaywrightResponse,
} from '../src/csp-injector.js';

const TARGET_ORIGIN = 'https://app.example.com';

interface MockRouteOptions {
  url?: string;
  resourceType?: string;
  fetchResponse?: PlaywrightResponse;
  fetchThrows?: Error;
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

function createMockRoute(opts: MockRouteOptions = {}): PlaywrightRoute {
  const fetchMock = opts.fetchThrows
    ? vi.fn(async () => {
        throw opts.fetchThrows;
      })
    : vi.fn(async () => opts.fetchResponse ?? createMockResponse(200));

  return {
    fetch: fetchMock as PlaywrightRoute['fetch'],
    fulfill: vi.fn(async () => {}),
    continue: vi.fn(async () => {}),
    request: () => ({
      url: () => opts.url ?? 'https://idp.example.com/auth',
      resourceType: () => opts.resourceType ?? 'document',
    }),
  };
}

describe('handleNonTargetOriginRequest', () => {
  it('continues non-document requests without fetching', async () => {
    const route = createMockRoute({ resourceType: 'xhr' });
    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.fetch).not.toHaveBeenCalled();
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it('fulfills non-redirect document responses with the already-fetched response', async () => {
    const response = createMockResponse(200, { 'content-type': 'text/html' });
    const route = createMockRoute({ fetchResponse: response });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    expect(route.fetch).toHaveBeenCalledWith({ maxRedirects: 0 });
    expect(route.fulfill).toHaveBeenCalledWith({ response });
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('rewrites a 302 redirect as a JS navigation page', async () => {
    const response = createMockResponse(302, {
      location: `${TARGET_ORIGIN}/auth/callback?code=xyz`,
      'set-cookie': 'session=abc',
    });
    const route = createMockRoute({ fetchResponse: response });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
    expect(fulfillCall?.status).toBe(200);
    expect(fulfillCall?.headers?.['content-type']).toBe('text/html; charset=utf-8');
    expect(fulfillCall?.headers?.['set-cookie']).toBe('session=abc');
    expect(fulfillCall?.body).toContain(
      `window.location.href="${TARGET_ORIGIN}/auth/callback?code=xyz"`,
    );
  });

  it('resolves relative Location headers against the request URL', async () => {
    const response = createMockResponse(302, { location: '/relative/path' });
    const route = createMockRoute({
      url: 'https://idp.example.com/some/auth',
      fetchResponse: response,
    });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
    expect(fulfillCall?.body).toContain(
      'window.location.href="https://idp.example.com/relative/path"',
    );
  });

  it('rewrites 301/303 redirects as JS navigation', async () => {
    for (const status of [301, 303]) {
      const response = createMockResponse(status, {
        location: `${TARGET_ORIGIN}/after-redirect`,
      });
      const route = createMockRoute({ fetchResponse: response });

      await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

      const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
      expect(fulfillCall?.status).toBe(200);
      expect(fulfillCall?.body).toContain('window.location.href=');
    }
  });

  it('rewrites 307/308 when the Location targets the app origin', async () => {
    for (const status of [307, 308]) {
      const response = createMockResponse(status, {
        location: `${TARGET_ORIGIN}/callback`,
      });
      const route = createMockRoute({ fetchResponse: response });

      await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

      const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
      expect(fulfillCall?.status).toBe(200);
      expect(fulfillCall?.body).toContain('window.location.href=');
    }
  });

  it('passes through 307/308 when the Location targets a non-app origin', async () => {
    for (const status of [307, 308]) {
      const response = createMockResponse(status, {
        location: 'https://other.example.com/elsewhere',
      });
      const route = createMockRoute({ fetchResponse: response });

      await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

      expect(route.fulfill).toHaveBeenCalledWith({ response });
    }
  });

  it('strips redirect-framing and CSP headers from the forwarded response', async () => {
    const response = createMockResponse(302, {
      location: `${TARGET_ORIGIN}/after`,
      'content-length': '123',
      'content-encoding': 'gzip',
      'transfer-encoding': 'chunked',
      'content-security-policy': "default-src 'none'",
      'content-security-policy-report-only': "default-src 'none'",
      'report-to': '{"group":"bad"}',
      'set-cookie': 'auth=keep',
      'x-custom': 'kept',
    });
    const route = createMockRoute({ fetchResponse: response });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
    const headers = fulfillCall?.headers ?? {};
    expect(headers['location']).toBeUndefined();
    expect(headers['content-length']).toBeUndefined();
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['transfer-encoding']).toBeUndefined();
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['content-security-policy-report-only']).toBeUndefined();
    expect(headers['report-to']).toBeUndefined();
    expect(headers['set-cookie']).toBe('auth=keep');
    expect(headers['x-custom']).toBe('kept');
  });

  it('produces a safely-embedded JS navigation regardless of Location contents', async () => {
    // WHATWG URL parsing percent-encodes quotes and normalizes backslashes in
    // the resolved URL, so the replace step rarely fires in practice — but the
    // final body must still contain a single, unbroken JS string literal for
    // the Location inside window.location.href="...".
    const response = createMockResponse(302, {
      location: `${TARGET_ORIGIN}/a"b\\c`,
    });
    const route = createMockRoute({ fetchResponse: response });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
    const body = String(fulfillCall?.body ?? '');
    const match = body.match(/window\.location\.href="((?:[^"\\]|\\.)*)"/);
    expect(match).toBeTruthy();
    // Resolved URL should not contain raw quotes (they get percent-encoded)
    expect(match?.[1]).not.toContain('"');
  });

  it('passes through the raw response when Location is missing on a 3xx', async () => {
    const response = createMockResponse(302, {});
    const route = createMockRoute({ fetchResponse: response });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    expect(route.fulfill).toHaveBeenCalledWith({ response });
  });

  it('passes through when Location parses to an invalid URL', async () => {
    const response = createMockResponse(302, { location: 'not a url :::' });
    const route = createMockRoute({
      url: 'ht!tp://bad',
      fetchResponse: response,
    });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    expect(route.fulfill).toHaveBeenCalledWith({ response });
  });

  it('calls continue() when the fetch itself throws', async () => {
    const route = createMockRoute({ fetchThrows: new Error('network down') });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    expect(route.continue).toHaveBeenCalledOnce();
    expect(route.fulfill).not.toHaveBeenCalled();
  });

  it('rewrites even when redirect Location is same non-target origin (another hop)', async () => {
    const response = createMockResponse(302, {
      location: 'https://intermediate.example.com/next',
    });
    const route = createMockRoute({ fetchResponse: response });

    await handleNonTargetOriginRequest(route, TARGET_ORIGIN);

    const fulfillCall = vi.mocked(route.fulfill).mock.calls[0]?.[0];
    // Still rewritten as JS navigation — multi-hop chains naturally re-enter
    // the route handler at each new top-level navigation.
    expect(fulfillCall?.status).toBe(200);
    expect(fulfillCall?.body).toContain('window.location.href=');
  });
});
