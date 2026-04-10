import type { IncomingHttpHeaders } from 'node:http';
import { Proxy } from 'http-mitm-proxy';
import { buildDenyAllCSP, buildReportToHeader } from './utils/csp-constants.js';
import { createLogger } from './utils/logger.js';
import type { CertPaths } from './cert-manager.js';

const logger = createLogger();

const REPORT_GROUP = 'csp-analyser';

/** CSP-related headers that should be stripped from responses (lowercase). */
const CSP_HEADERS_TO_STRIP = [
  'content-security-policy',
  'content-security-policy-report-only',
  'report-to',
];

export interface MitmProxyOptions {
  /** Report server port for CSP violation reporting */
  reportServerPort: number;
  /** Certificate paths from ensureCACertificate() */
  certPaths: CertPaths;
}

export interface MitmProxyInstance {
  /** Port the proxy is listening on */
  port: number;
  /** Path to the CA certificate (for configuring browsers to trust it) */
  caCertPath: string;
  /** Stops the proxy */
  close(): void;
}

/**
 * Transforms upstream response headers by stripping existing CSP headers
 * and injecting a deny-all CSP-Report-Only + Report-To header.
 *
 * This is the same transformation used by csp-injector.ts for local mode,
 * extracted as a pure function for testability.
 *
 * Works with Node.js IncomingHttpHeaders (lowercase keys, string | string[] | undefined values).
 */
export function transformProxyResponseHeaders(
  headers: IncomingHttpHeaders,
  reportServerPort: number,
): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!CSP_HEADERS_TO_STRIP.includes(key)) {
      result[key] = value;
    }
  }

  const reportUri = `http://127.0.0.1:${reportServerPort}/csp-report`;
  const reportsEndpoint = `http://127.0.0.1:${reportServerPort}/reports`;

  result['content-security-policy-report-only'] = buildDenyAllCSP(reportUri, REPORT_GROUP);
  result['report-to'] = buildReportToHeader(reportsEndpoint, REPORT_GROUP);

  return result;
}

/**
 * Starts an HTTPS-intercepting MITM proxy that strips existing CSP headers
 * and injects a deny-all CSP-Report-Only policy.
 *
 * Listens on 127.0.0.1 with an OS-assigned port.
 */
export function startMitmProxy(options: MitmProxyOptions): Promise<MitmProxyInstance> {
  const { reportServerPort, certPaths } = options;

  return new Promise((resolve, reject) => {
    const proxy = new Proxy();

    proxy.onError((ctx, err) => {
      const errorMsg = err instanceof Error ? err.message : String(err ?? 'unknown');
      logger.error('MITM proxy error', { error: errorMsg });
    });

    proxy.onResponseHeaders((ctx, callback) => {
      const upstream = ctx.serverToProxyResponse;
      if (upstream) {
        const transformed = transformProxyResponseHeaders(upstream.headers, reportServerPort);
        // Replace headers in-place — the proxy writes these to the client response
        for (const key of Object.keys(upstream.headers)) {
          delete upstream.headers[key];
        }
        for (const [key, value] of Object.entries(transformed)) {
          upstream.headers[key] = value;
        }
      }
      return callback();
    });

    proxy.listen(
      {
        port: 0,
        host: '127.0.0.1',
        sslCaDir: certPaths.sslCaDir,
      },
      () => {
        const port = proxy.httpPort;
        logger.info('MITM proxy started', { port, sslCaDir: certPaths.sslCaDir });

        resolve({
          port,
          caCertPath: certPaths.caCertPath,
          close() {
            proxy.close();
            logger.info('MITM proxy stopped');
          },
        });
      },
    );
  });
}
