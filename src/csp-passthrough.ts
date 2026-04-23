import { buildReportToHeader } from './utils/csp-constants.js';
import { extractOrigin } from './utils/url-utils.js';
import { createLogger } from './utils/logger.js';
import { handleNonTargetOriginRequest } from './utils/route-redirect-rewriter.js';
import type {
  PlaywrightPage,
  PlaywrightRoute,
  CapturedPermissionsPolicy,
  PermissionsPolicyCaptureCallback,
} from './csp-injector.js';
import type { ExistingCspHeaderType } from './types.js';

const logger = createLogger();

const REPORT_GROUP = 'csp-analyser';

/** CSP headers to capture from responses. */
const CSP_HEADER_MAP: ReadonlyArray<{ header: string; type: ExistingCspHeaderType }> = [
  { header: 'content-security-policy', type: 'enforced' },
  { header: 'content-security-policy-report-only', type: 'report-only' },
];

/** Permissions-Policy headers to capture (not strip). */
const PERMISSIONS_POLICY_HEADERS = ['permissions-policy', 'feature-policy'];

export interface CapturedCspHeader {
  headerType: ExistingCspHeaderType;
  headerValue: string;
}

export type CspHeaderCaptureCallback = (
  captured: CapturedCspHeader[],
  requestUrl: string,
) => void;

/**
 * Appends report-uri and report-to directives to an existing CSP header value.
 * If report-uri or report-to already exists, replaces it with ours.
 */
function appendReportDirectives(
  headerValue: string,
  reportUri: string,
  reportToGroup: string,
): string {
  const parts = headerValue
    .split(';')
    .map((p) => p.trim())
    .filter((p) => {
      const directive = p.split(/\s+/)[0]?.toLowerCase();
      // Strip existing reporting directives — we inject our own
      return directive !== 'report-uri' && directive !== 'report-to';
    });

  parts.push(`report-uri ${reportUri}`);
  parts.push(`report-to ${reportToGroup}`);

  return parts.join('; ');
}

/**
 * Transforms response headers for audit mode.
 *
 * Unlike the deny-all injector, this preserves the site's existing CSP headers
 * and only appends our report-uri/report-to so violations are reported to our server.
 * Captures the original CSP header values before modification.
 */
export function transformResponseHeadersForAudit(
  headers: Record<string, string>,
  reportServerPort: number,
  reportToken?: string,
): {
  headers: Record<string, string>;
  capturedCspHeaders: CapturedCspHeader[];
  permissionsPolicies: CapturedPermissionsPolicy[];
} {
  const result: Record<string, string> = {};
  const capturedCspHeaders: CapturedCspHeader[] = [];
  const permissionsPolicies: CapturedPermissionsPolicy[] = [];

  const tokenSuffix = reportToken ? `/${reportToken}` : '';
  const reportUri = `http://127.0.0.1:${reportServerPort}/csp-report${tokenSuffix}`;
  const reportsEndpoint = `http://127.0.0.1:${reportServerPort}/reports${tokenSuffix}`;

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();

    // Check if this is a CSP header we need to capture and augment
    const cspMatch = CSP_HEADER_MAP.find((m) => m.header === lower);
    if (cspMatch) {
      // Capture the original value
      capturedCspHeaders.push({ headerType: cspMatch.type, headerValue: value });

      // Augment with our report endpoints
      result[key] = appendReportDirectives(value, reportUri, REPORT_GROUP);
      continue;
    }

    // Strip Report-To header — we inject our own
    if (lower === 'report-to') continue;

    // Capture permissions-policy headers (keep them in the response)
    if (PERMISSIONS_POLICY_HEADERS.includes(lower)) {
      permissionsPolicies.push({ headerName: lower, headerValue: value });
    }

    result[key] = value;
  }

  // Add our Report-To header
  result['report-to'] = buildReportToHeader(reportsEndpoint, REPORT_GROUP);

  return { headers: result, capturedCspHeaders, permissionsPolicies };
}

/**
 * Sets up CSP passthrough on a Playwright page for audit mode.
 *
 * Preserves existing CSP headers, appends our report endpoints, and captures
 * the original CSP values via callback. Does NOT inject a deny-all CSP.
 *
 * If a response has no CSP headers, it passes through unmodified (there is
 * nothing to audit — no CSP means no violations).
 *
 * Non-target-origin requests are delegated to `handleNonTargetOriginRequest`,
 * which rewrites 3xx redirects back to the target origin as JS navigations.
 * Without this, Playwright skips re-intercepting the post-redirect request
 * and the CSP on the auth callback page would never be captured.
 *
 * Returns a cleanup function that removes the route handler.
 */
export async function setupCspPassthrough(
  page: PlaywrightPage,
  reportServerPort: number,
  reportToken?: string,
  onCspHeaders?: CspHeaderCaptureCallback,
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

      const { headers: newHeaders, capturedCspHeaders, permissionsPolicies } =
        transformResponseHeadersForAudit(originalHeaders, reportServerPort, reportToken);

      if (capturedCspHeaders.length > 0 && onCspHeaders) {
        onCspHeaders(capturedCspHeaders, route.request().url());
      }

      if (permissionsPolicies.length > 0 && onPermissionsPolicy) {
        onPermissionsPolicy(permissionsPolicies, route.request().url());
      }

      // Only modify the response if CSP headers were found
      if (capturedCspHeaders.length > 0) {
        await route.fulfill({ response, headers: newHeaders });
      } else {
        await route.fulfill({ response, headers: originalHeaders });
      }
    } catch (err) {
      let sanitizedUrl: string;
      try {
        const parsed = new URL(route.request().url());
        sanitizedUrl = parsed.origin + parsed.pathname;
      } catch {
        sanitizedUrl = '<invalid-url>';
      }
      logger.error('CSP passthrough route handler failed', {
        url: sanitizedUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await route.continue();
      } catch {
        // Route may already be handled
      }
    }
  };

  await page.route('**/*', handler);
  logger.info('CSP passthrough set up (audit mode)', { reportServerPort });

  return async () => {
    await page.unroute('**/*', handler);
    logger.info('CSP passthrough removed');
  };
}
