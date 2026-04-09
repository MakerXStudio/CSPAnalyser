import { buildDenyAllCSP, buildReportToHeader } from './utils/csp-constants.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

const REPORT_GROUP = 'csp-analyser';

/** CSP-related headers that should be stripped from responses. */
const CSP_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'report-to',
];

/**
 * Playwright Page interface — minimal subset needed for CSP injection.
 * Using a local interface avoids requiring playwright as a dependency.
 */
export interface PlaywrightPage {
  route(
    url: string | RegExp,
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<void>;
  unroute(
    url: string | RegExp,
    handler?: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<void>;
}

export interface PlaywrightRoute {
  fetch(): Promise<PlaywrightResponse>;
  fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    response?: PlaywrightResponse;
  }): Promise<void>;
  continue(): Promise<void>;
  request(): { url(): string };
}

export interface PlaywrightResponse {
  status(): number;
  headers(): Record<string, string>;
  body(): Promise<Buffer>;
}

/**
 * Transforms response headers by stripping existing CSP headers
 * and injecting a deny-all CSP-Report-Only + Report-To header.
 *
 * This is a pure function for easy testing.
 */
export function transformResponseHeaders(
  headers: Record<string, string>,
  reportServerPort: number,
): Record<string, string> {
  const result: Record<string, string> = {};

  // Copy headers, stripping CSP-related ones (case-insensitive)
  for (const [key, value] of Object.entries(headers)) {
    if (!CSP_HEADERS.includes(key.toLowerCase())) {
      result[key] = value;
    }
  }

  const reportUri = `http://127.0.0.1:${reportServerPort}/csp-report`;
  const reportsEndpoint = `http://127.0.0.1:${reportServerPort}/reports`;

  // Add deny-all CSP as report-only
  result['content-security-policy-report-only'] = buildDenyAllCSP(reportUri, REPORT_GROUP);

  // Add Report-To header for Reporting API
  result['report-to'] = buildReportToHeader(reportsEndpoint, REPORT_GROUP);

  return result;
}

/**
 * Sets up CSP injection on a Playwright page by intercepting all requests
 * and modifying response headers.
 *
 * Returns a cleanup function that removes the route handler.
 */
export async function setupCspInjection(
  page: PlaywrightPage,
  reportServerPort: number,
): Promise<() => Promise<void>> {
  const handler = async (route: PlaywrightRoute): Promise<void> => {
    try {
      const response = await route.fetch();
      const originalHeaders = response.headers();
      const newHeaders = transformResponseHeaders(originalHeaders, reportServerPort);

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
