import { buildDenyAllCSP, buildReportToHeader } from './utils/csp-constants.js';
import { extractOrigin } from './utils/url-utils.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

const REPORT_GROUP = 'csp-analyser';

/** CSP-related headers that should be stripped from responses. */
const CSP_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'report-to'];

/** Permissions-Policy headers to capture (not strip). */
const PERMISSIONS_POLICY_HEADERS = ['permissions-policy', 'feature-policy'];

/**
 * Playwright Page interface — minimal subset needed for CSP injection.
 * Using a local interface avoids requiring playwright as a dependency.
 */
export interface PlaywrightPage {
  route(
    url: string | RegExp,
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<unknown>;
  unroute(
    url: string | RegExp,
    handler?: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<unknown>;
}

export interface PlaywrightRoute {
  fetch(options?: { maxRedirects?: number }): Promise<PlaywrightResponse>;
  fulfill(options?: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    response?: PlaywrightResponse;
    [key: string]: unknown;
  }): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string; resourceType(): string };
}

export interface PlaywrightResponse {
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

/** Captured Permissions-Policy header from a response. */
export interface CapturedPermissionsPolicy {
  headerName: string;
  headerValue: string;
}

/**
 * Transforms response headers by stripping existing CSP headers
 * and injecting a deny-all CSP-Report-Only + Report-To header.
 *
 * Also captures any Permissions-Policy / Feature-Policy headers
 * without modifying them.
 *
 * This is a pure function for easy testing.
 */
export function transformResponseHeaders(
  headers: Record<string, string>,
  reportServerPort: number,
  reportToken?: string,
): { headers: Record<string, string>; permissionsPolicies: CapturedPermissionsPolicy[] } {
  const result: Record<string, string> = {};
  const permissionsPolicies: CapturedPermissionsPolicy[] = [];

  // Copy headers, stripping CSP-related ones (case-insensitive)
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (CSP_HEADERS.includes(lower)) {
      continue;
    }
    // Capture permissions-policy headers (keep them in the response)
    if (PERMISSIONS_POLICY_HEADERS.includes(lower)) {
      permissionsPolicies.push({ headerName: lower, headerValue: value });
    }
    result[key] = value;
  }

  const tokenSuffix = reportToken ? `/${reportToken}` : '';
  const reportUri = `http://127.0.0.1:${reportServerPort}/csp-report${tokenSuffix}`;
  const reportsEndpoint = `http://127.0.0.1:${reportServerPort}/reports${tokenSuffix}`;

  // Add deny-all CSP as report-only
  result['content-security-policy-report-only'] = buildDenyAllCSP(reportUri, REPORT_GROUP);

  // Add Report-To header for Reporting API
  result['report-to'] = buildReportToHeader(reportsEndpoint, REPORT_GROUP);

  return { headers: result, permissionsPolicies };
}

export type PermissionsPolicyCaptureCallback = (
  captured: CapturedPermissionsPolicy[],
  requestUrl: string,
) => void;

/**
 * Headers to strip when building the JS redirect page response.
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
 *    redirects, so there is no way to both preserve POST AND inject CSP.
 * 2. OAuth 2.0 (RFC 6749 §4.1.2) and OIDC specify 302 for auth responses.
 *    307/308 on the auth return leg is essentially non-existent in practice
 *    (Azure AD B2C, Okta, Auth0, Google all use 302).
 * 3. SPA callback endpoints typically accept both GET and POST — the auth
 *    code is in the URL query string regardless of method.
 * 4. The alternative (passing through) silently produces zero CSP violations
 *    on the post-redirect page, which is worse for a CSP analysis tool.
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
 * Sets up CSP injection on a Playwright page by intercepting all requests
 * and modifying response headers.
 *
 * When targetOrigin is provided, CSP injection only applies to responses
 * from that origin — requests to other origins (e.g., auth redirects)
 * pass through unmodified so they don't pollute the generated policy.
 *
 * **Redirect handling**: Playwright's `page.route()` does not re-intercept
 * requests that result from HTTP 3xx redirects — if an external origin
 * (e.g., an OAuth provider) responds with a 302 back to the target origin,
 * the redirected request bypasses the route handler entirely, so CSP is
 * never injected on the post-redirect page. To work around this, the
 * handler intercepts non-target navigation requests with `maxRedirects: 0`
 * and replaces redirect responses with a JS `window.location.href` page.
 * 301/302/303 are always rewritten (they convert to GET anyway). 307/308
 * are rewritten only when the Location points to the target origin (where
 * CSP injection is needed) — for intermediate non-target hops, 307/308 are
 * passed through to preserve method and body semantics. All original
 * response headers except CSP are forwarded — CSP headers from the IdP's
 * redirect response are stripped so they can't block the inline redirect
 * script. The browser processes the forwarded cookies, renders the redirect
 * page, and navigates to the Location URL as a fresh top-level request.
 * That request re-enters the route handler — if it's a target-origin URL,
 * CSP is injected; if it's another non-target redirect, the same rewrite
 * happens again. This naturally handles multi-hop redirect chains (e.g.,
 * auth → intermediate → app) without needing to follow the chain from
 * Node, so the browser's full cookie jar and auth state are available at
 * every hop.
 *
 * Optionally accepts a callback that is invoked when Permissions-Policy
 * or Feature-Policy headers are found in a response.
 *
 * Returns a cleanup function that removes the route handler.
 */
export async function setupCspInjection(
  page: PlaywrightPage,
  reportServerPort: number,
  reportToken?: string,
  onPermissionsPolicy?: PermissionsPolicyCaptureCallback,
  targetOrigin?: string,
): Promise<() => Promise<void>> {
  const handler = async (route: PlaywrightRoute): Promise<void> => {
    try {
      // For non-target origins: check for redirects back to the target.
      if (targetOrigin) {
        let requestOrigin: string;
        try {
          requestOrigin = extractOrigin(route.request().url());
        } catch {
          await route.continue();
          return;
        }

        if (requestOrigin !== targetOrigin) {
          // Only intercept navigation requests (document loads) — subresource
          // requests from non-target origins can't redirect back in a
          // meaningful way and are much more frequent.
          const resourceType = route.request().resourceType();
          if (resourceType !== 'document') {
            await route.continue();
            return;
          }

          // Fetch with maxRedirects:0 to inspect the raw response.
          // If it's a 3xx redirect, replace with a JS redirect page so
          // the browser performs a fresh navigation that re-enters the
          // route handler. This handles both single-hop (auth → app) and
          // multi-hop (auth → intermediate → app) chains: each hop becomes
          // a separate route handler invocation with full browser cookie
          // context, so cookie-dependent auth chains work correctly.
          try {
            const resp = await route.fetch({ maxRedirects: 0 });
            const status = resp.status();
            const isRedirect = status >= 300 && status < 400;

            if (isRedirect) {
              const rawLocation = resp.headers()['location'];
              if (rawLocation) {
                let absoluteLocation: string;
                try {
                  absoluteLocation = resolveLocation(rawLocation, route.request().url());
                } catch {
                  // Unparseable Location — pass through as-is
                  await route.fulfill({ response: resp });
                  return;
                }

                // Decide whether to rewrite this redirect as a JS navigation.
                // 301/302/303: always rewrite (they convert to GET anyway).
                // 307/308: only rewrite when targeting the app origin (need CSP);
                //   for intermediate non-target hops, pass through to preserve
                //   method and body semantics.
                let redirectOrigin: string | undefined;
                try {
                  redirectOrigin = extractOrigin(absoluteLocation);
                } catch {
                  // Can't determine origin — pass through
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

                // Forward all original response headers (Set-Cookie, etc.)
                // but strip redirect-specific and framing headers.
                const originalHeaders = resp.headers();
                const forwardHeaders: Record<string, string> = {};
                for (const [key, value] of Object.entries(originalHeaders)) {
                  if (!REDIRECT_STRIP_HEADERS.has(key.toLowerCase())) {
                    forwardHeaders[key] = value;
                  }
                }
                forwardHeaders['content-type'] = 'text/html; charset=utf-8';

                const safeLocation = absoluteLocation
                  .replace(/\\/g, '\\\\')
                  .replace(/"/g, '\\"');
                await route.fulfill({
                  status: 200,
                  headers: forwardHeaders,
                  body: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.location.href="${safeLocation}"</script></body></html>`,
                });
                return;
              }
            }

            // Not a redirect — pass the already-fetched response through
            // without re-fetching (avoids double requests to stateful or
            // single-use endpoints like auth login URLs).
            await route.fulfill({ response: resp });
          } catch {
            // Fetch failed — fall back to route.continue()
            await route.continue();
          }
          return;
        }
      }

      const response = await route.fetch();
      const originalHeaders = response.headers();
      const { headers: newHeaders, permissionsPolicies } = transformResponseHeaders(
        originalHeaders,
        reportServerPort,
        reportToken,
      );

      if (permissionsPolicies.length > 0 && onPermissionsPolicy) {
        onPermissionsPolicy(permissionsPolicies, route.request().url());
      }

      await route.fulfill({
        response,
        headers: newHeaders,
      });
    } catch (err) {
      let sanitizedUrl: string;
      try {
        const parsed = new URL(route.request().url());
        sanitizedUrl = parsed.origin + parsed.pathname;
      } catch {
        sanitizedUrl = '<invalid-url>';
      }
      logger.error('CSP injection route handler failed', {
        url: sanitizedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      // Let the request proceed without modification on error
      try {
        await route.continue();
      } catch {
        // Route may already be handled
      }
    }
  };

  await page.route('**/*', handler);
  logger.info('CSP injection set up', { reportServerPort });

  return async () => {
    await page.unroute('**/*', handler);
    logger.info('CSP injection removed');
  };
}
