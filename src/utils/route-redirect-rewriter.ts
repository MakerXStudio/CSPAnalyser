import { extractOrigin } from './url-utils.js';
import { createLogger } from './logger.js';
import type { PlaywrightRoute } from '../csp-injector.js';

const logger = createLogger();

/**
 * Headers stripped when forwarding a rewritten redirect response.
 * Includes redirect-specific framing headers and CSP headers — the
 * synthetic page contains an inline script, so any CSP from the
 * original redirect response would block it and stall the auth flow.
 */
const REDIRECT_STRIP_HEADERS = new Set([
  'location',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'content-security-policy',
  'content-security-policy-report-only',
  'report-to',
]);

/**
 * HTTP status codes that are always safe to rewrite as JS redirects.
 * 301, 302, and 303 all convert the follow-up request to GET, which
 * matches JS `window.location.href` behavior.
 */
const ALWAYS_REWRITABLE_STATUSES = new Set([301, 302, 303]);

/**
 * HTTP status codes that preserve the original method and body (RFC 7538).
 *
 * **Tradeoff**: A JS `window.location.href` redirect always becomes a GET,
 * so rewriting a 307/308 drops the original POST body and changes the
 * method. This can break callback endpoints that depend on POST semantics
 * or request body contents. We accept this tradeoff ONLY when the redirect
 * targets the app origin, because:
 *
 * 1. Playwright's `page.route()` cannot re-intercept requests from 3xx
 *    redirects, so there is no way to both preserve POST AND re-enter
 *    the handler on the target origin.
 * 2. OAuth 2.0 (RFC 6749 §4.1.2) and OIDC specify 302 for auth responses.
 *    307/308 on the auth return leg is essentially non-existent in practice
 *    (Azure AD B2C, Okta, Auth0, Google all use 302).
 * 3. SPA callback endpoints typically accept both GET and POST — the auth
 *    code is in the URL query string regardless of method.
 * 4. The alternative (passing through) silently breaks CSP analysis on
 *    the post-redirect page, which is worse for this tool.
 *
 * For intermediate hops between non-target origins, 307/308 are passed
 * through to preserve method semantics.
 */
const METHOD_PRESERVING_STATUSES = new Set([307, 308]);

/**
 * Resolves a potentially relative Location header against the URL of the
 * request that produced it, returning an absolute URL.
 */
function resolveLocation(location: string, requestUrl: string): string {
  return new URL(location, requestUrl).href;
}

/**
 * Handles a request destined for a non-target origin.
 *
 * Playwright's `page.route()` does not re-intercept requests that result
 * from HTTP 3xx redirects. So if an external origin (e.g. an OAuth IdP)
 * responds with a 302 back to the target origin, the redirected request
 * bypasses the route handler entirely — meaning neither CSP injection
 * nor CSP passthrough capture runs on the post-redirect page.
 *
 * To work around this, navigation requests to non-target origins are
 * fetched with `maxRedirects: 0` and any 3xx response is replaced with a
 * JS `window.location.href` page. The browser then performs a fresh
 * top-level navigation to the Location URL, which re-enters the route
 * handler — if it's target-origin, the normal CSP handling runs; if it's
 * another non-target hop, this function runs again. Multi-hop chains
 * (auth → intermediate → app) work naturally because each hop is a new
 * top-level request with full cookie jar context.
 *
 * 301/302/303 are always rewritten (they convert to GET anyway). 307/308
 * are rewritten only when the Location points to the target origin —
 * for intermediate non-target hops, 307/308 are passed through to preserve
 * method and body semantics. All original response headers except CSP
 * and redirect-framing are forwarded.
 *
 * Subresource (non-document) requests from non-target origins can't
 * meaningfully redirect back and are far more frequent, so they pass
 * through via `route.continue()`.
 *
 * If anything goes wrong the request is passed through unmodified — the
 * goal is never to break the navigation.
 */
export async function handleNonTargetOriginRequest(
  route: PlaywrightRoute,
  targetOrigin: string,
): Promise<void> {
  const resourceType = route.request().resourceType();
  if (resourceType !== 'document') {
    await route.continue();
    return;
  }

  try {
    const resp = await route.fetch({ maxRedirects: 0 });
    const status = resp.status();
    const isRedirect = status >= 300 && status < 400;

    if (!isRedirect) {
      // Not a redirect — pass the already-fetched response through
      // without re-fetching (avoids double requests to stateful or
      // single-use endpoints like auth login URLs).
      await route.fulfill({ response: resp });
      return;
    }

    const rawLocation = resp.headers()['location'];
    if (!rawLocation) {
      await route.fulfill({ response: resp });
      return;
    }

    let absoluteLocation: string;
    try {
      absoluteLocation = resolveLocation(rawLocation, route.request().url());
    } catch {
      await route.fulfill({ response: resp });
      return;
    }

    let redirectOrigin: string;
    try {
      redirectOrigin = extractOrigin(absoluteLocation);
    } catch {
      await route.fulfill({ response: resp });
      return;
    }

    const shouldRewrite =
      ALWAYS_REWRITABLE_STATUSES.has(status) ||
      (METHOD_PRESERVING_STATUSES.has(status) && redirectOrigin === targetOrigin);

    if (!shouldRewrite) {
      // 307/308 to a non-target origin — pass through to preserve
      // method/body for intermediate hops.
      await route.fulfill({ response: resp });
      return;
    }

    logger.debug('Replacing non-target redirect with JS navigation', {
      from: route.request().url(),
      to: absoluteLocation,
      status,
    });

    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(resp.headers())) {
      if (!REDIRECT_STRIP_HEADERS.has(key.toLowerCase())) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders['content-type'] = 'text/html; charset=utf-8';

    const safeLocation = absoluteLocation.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await route.fulfill({
      status: 200,
      headers: forwardHeaders,
      body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.location.href="${safeLocation}"</script></body></html>`,
    });
  } catch {
    // Fetch failed — fall back to continue so the browser handles it.
    try {
      await route.continue();
    } catch {
      // Route may already be handled.
    }
  }
}
