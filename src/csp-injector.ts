import { buildDenyAllCSP, buildReportToHeader } from './utils/csp-constants.js';
import { extractOrigin } from './utils/url-utils.js';
import { createLogger } from './utils/logger.js';
import { handleNonTargetOriginRequest } from './utils/route-redirect-rewriter.js';

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
 * Sets up CSP injection on a Playwright page by intercepting all requests
 * and modifying response headers.
 *
 * When targetOrigin is provided, CSP injection only applies to responses
 * from that origin. Requests to other origins are delegated to
 * `handleNonTargetOriginRequest`, which rewrites 3xx redirects as JS
 * navigations so redirects back to the target origin re-enter this
 * handler — otherwise Playwright's page.route() would silently skip them
 * and CSP would never be injected on the post-redirect page.
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
      if (targetOrigin) {
        let requestOrigin: string;
        try {
          requestOrigin = extractOrigin(route.request().url());
        } catch {
          await route.continue();
          return;
        }

        if (requestOrigin !== targetOrigin) {
          await handleNonTargetOriginRequest(route, targetOrigin);
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
