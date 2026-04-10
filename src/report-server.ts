import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parseCspReport, parseReportingApiReport } from './report-parser.js';
import { insertViolation } from './db/repository.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const DEFAULT_VIOLATION_LIMIT = 10_000;

export interface ReportServerOptions {
  /** Maximum violations to accept per session (default: 10,000). Set to 0 for unlimited. */
  violationLimit?: number;
}

export interface ReportServerResult {
  port: number;
  token: string;
  close: () => Promise<void>;
}

/**
 * Starts a local HTTP server that receives CSP violation reports.
 * Each server generates a per-session auth token; only requests to
 * the token-prefixed paths are accepted, preventing other local
 * processes from injecting fake reports.
 *
 * - POST /csp-report/{token} — application/csp-report format
 * - POST /reports/{token}    — application/reports+json (Reporting API)
 * - GET  /health             — health check (no token required)
 */
export async function startReportServer(
  db: Database.Database,
  sessionId: string,
  options?: ReportServerOptions,
): Promise<ReportServerResult> {
  const token = randomUUID();
  const cspReportPath = `/csp-report/${token}`;
  const reportsPath = `/reports/${token}`;
  const violationLimit = options?.violationLimit ?? DEFAULT_VIOLATION_LIMIT;
  let violationCount = 0;
  let limitWarningLogged = false;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === cspReportPath || req.url === reportsPath) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      // Rate limit: reject new reports once violation limit is reached
      if (violationLimit > 0 && violationCount >= violationLimit) {
        if (!limitWarningLogged) {
          logger.warn('Violation limit reached, rejecting further reports', {
            sessionId,
            limit: violationLimit,
          });
          limitWarningLogged = true;
        }
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'violation limit reached' }));
        return;
      }

      handleReport(req, res, db, sessionId, req.url === cspReportPath, (count: number) => {
        violationCount += count;
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      const port = addr.port;
      logger.info('Report server started', { port, sessionId });

      resolve({
        port,
        token,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) rejectClose(err);
              else resolveClose();
            });
          }),
      });
    });
  });
}

function handleReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  db: Database.Database,
  sessionId: string,
  isCspReport: boolean,
  onViolationsInserted: (count: number) => void,
): void {
  const contentType = req.headers['content-type'] ?? '';
  const isReportsApi = !isCspReport;

  // Validate content type
  if (
    isCspReport &&
    !contentType.includes('application/csp-report') &&
    !contentType.includes('application/json')
  ) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported content type' }));
    return;
  }

  if (
    isReportsApi &&
    !contentType.includes('application/reports+json') &&
    !contentType.includes('application/json')
  ) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unsupported content type' }));
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;

  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_SIZE) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (aborted || res.writableEnded) return;

    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    try {
      if (isCspReport) {
        const violation = parseCspReport(body, sessionId, null);
        if (violation) {
          insertViolation(db, violation);
          onViolationsInserted(1);
          logger.debug('CSP report stored', { directive: violation.effectiveDirective });
        }
        res.writeHead(204);
        res.end();
      } else {
        const violations = parseReportingApiReport(body, sessionId, null);
        for (const v of violations) {
          insertViolation(db, v);
        }
        if (violations.length > 0) {
          onViolationsInserted(violations.length);
        }
        logger.debug('Reporting API reports stored', { count: violations.length });
        res.writeHead(204);
        res.end();
      }
    } catch (err) {
      logger.error('Failed to process report', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
}
