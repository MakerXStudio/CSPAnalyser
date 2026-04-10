import type { InsertViolationParams } from './db/repository.js';
import { normalizeBlockedUri } from './utils/url-utils.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

// ── Type guards & helpers ────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ── String length limits ─────────────────────────────────────────────────

const MAX_URI_LENGTH = 2048;
const MAX_SOURCE_FILE_LENGTH = 2048;
const MAX_RAW_REPORT_LENGTH = 64 * 1024; // 64KB
const MAX_DIRECTIVE_LENGTH = 128;
const MAX_SAMPLE_LENGTH = 256;

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function truncateNullable(value: string | null, maxLength: number): string | null {
  return value !== null ? truncate(value, maxLength) : null;
}

/**
 * Extracts the effective directive from a violated-directive string.
 * CSP report format often sends the full directive value (e.g., "script-src 'none'"),
 * so we extract just the directive name.
 */
function extractDirectiveName(directive: string): string {
  return directive.split(/\s+/)[0] ?? directive;
}

// ── CSP Report format (application/csp-report) ──────────────────────────

/**
 * Parses a CSP report in the `{"csp-report": {...}}` envelope format.
 * Used by the report-uri directive.
 */
export function parseCspReport(
  body: unknown,
  sessionId: string,
  pageId: string | null,
): InsertViolationParams | null {
  if (!isRecord(body)) {
    logger.warn('parseCspReport: body is not an object');
    return null;
  }

  const report = body['csp-report'];
  if (!isRecord(report)) {
    logger.warn('parseCspReport: missing csp-report envelope');
    return null;
  }

  const documentUri = str(report['document-uri']);
  const blockedUri = str(report['blocked-uri']);
  const violatedDirective = str(report['violated-directive']);
  const effectiveDirective = str(report['effective-directive']);

  if (!documentUri || !violatedDirective) {
    logger.warn('parseCspReport: missing required fields', {
      hasDocumentUri: !!documentUri,
      hasViolatedDirective: !!violatedDirective,
    });
    return null;
  }

  return {
    sessionId,
    pageId,
    documentUri: truncate(documentUri, MAX_URI_LENGTH),
    blockedUri: truncate(normalizeBlockedUri(blockedUri ?? ''), MAX_URI_LENGTH),
    violatedDirective: truncate(extractDirectiveName(violatedDirective), MAX_DIRECTIVE_LENGTH),
    effectiveDirective: truncate(
      extractDirectiveName(effectiveDirective ?? violatedDirective),
      MAX_DIRECTIVE_LENGTH,
    ),
    sourceFile: truncateNullable(str(report['source-file']), MAX_SOURCE_FILE_LENGTH),
    lineNumber: num(report['line-number']),
    columnNumber: num(report['column-number']),
    disposition: str(report['disposition']) === 'enforce' ? 'enforce' : 'report',
    sample: truncateNullable(str(report['script-sample']), MAX_SAMPLE_LENGTH),
    capturedVia: 'report_uri',
    rawReport: truncate(JSON.stringify(body), MAX_RAW_REPORT_LENGTH),
  };
}

// ── Reporting API format (application/reports+json) ──────────────────────

/**
 * Parses a Reporting API v1 payload (array of `{type, body}` objects).
 * Only CSP violation reports (type === "csp-violation") are processed.
 */
export function parseReportingApiReport(
  body: unknown,
  sessionId: string,
  pageId: string | null,
): InsertViolationParams[] {
  if (!Array.isArray(body)) {
    logger.warn('parseReportingApiReport: body is not an array');
    return [];
  }

  const results: InsertViolationParams[] = [];

  for (const entry of body) {
    if (!isRecord(entry)) continue;

    const type = str(entry['type']);
    if (type !== 'csp-violation') continue;

    const reportBody = entry['body'];
    if (!isRecord(reportBody)) continue;

    const documentURL = str(reportBody['documentURL']);
    const blockedURL = str(reportBody['blockedURL']);
    const effectiveDirective = str(reportBody['effectiveDirective']);

    if (!documentURL || !effectiveDirective) continue;

    results.push({
      sessionId,
      pageId,
      documentUri: truncate(documentURL, MAX_URI_LENGTH),
      blockedUri: truncate(normalizeBlockedUri(blockedURL ?? ''), MAX_URI_LENGTH),
      violatedDirective: truncate(effectiveDirective, MAX_DIRECTIVE_LENGTH),
      effectiveDirective: truncate(effectiveDirective, MAX_DIRECTIVE_LENGTH),
      sourceFile: truncateNullable(str(reportBody['sourceFile']), MAX_SOURCE_FILE_LENGTH),
      lineNumber: num(reportBody['lineNumber']),
      columnNumber: num(reportBody['columnNumber']),
      disposition: str(reportBody['disposition']) === 'enforce' ? 'enforce' : 'report',
      sample: truncateNullable(str(reportBody['sample']), MAX_SAMPLE_LENGTH),
      capturedVia: 'reporting_api',
      rawReport: truncate(JSON.stringify(entry), MAX_RAW_REPORT_LENGTH),
    });
  }

  return results;
}

// ── DOM SecurityPolicyViolationEvent ─────────────────────────────────────

/**
 * Parses data from a DOM SecurityPolicyViolationEvent.
 * This is the format captured by page.addInitScript() event listeners.
 */
export function parseDomViolation(
  data: unknown,
  sessionId: string,
  pageId: string | null,
): InsertViolationParams | null {
  if (!isRecord(data)) {
    logger.warn('parseDomViolation: data is not an object');
    return null;
  }

  const documentURI = str(data['documentURI']);
  const blockedURI = str(data['blockedURI']);
  const violatedDirective = str(data['violatedDirective']);
  const effectiveDirective = str(data['effectiveDirective']);

  if (!documentURI || !violatedDirective) {
    logger.warn('parseDomViolation: missing required fields', {
      hasDocumentURI: !!documentURI,
      hasViolatedDirective: !!violatedDirective,
    });
    return null;
  }

  return {
    sessionId,
    pageId,
    documentUri: truncate(documentURI, MAX_URI_LENGTH),
    blockedUri: truncate(normalizeBlockedUri(blockedURI ?? ''), MAX_URI_LENGTH),
    violatedDirective: truncate(extractDirectiveName(violatedDirective), MAX_DIRECTIVE_LENGTH),
    effectiveDirective: truncate(
      extractDirectiveName(effectiveDirective ?? violatedDirective),
      MAX_DIRECTIVE_LENGTH,
    ),
    sourceFile: truncateNullable(str(data['sourceFile']), MAX_SOURCE_FILE_LENGTH),
    lineNumber: num(data['lineNumber']),
    columnNumber: num(data['columnNumber']),
    disposition: str(data['disposition']) === 'enforce' ? 'enforce' : 'report',
    sample: truncateNullable(str(data['sample']), MAX_SAMPLE_LENGTH),
    capturedVia: 'dom_event',
    rawReport: truncate(JSON.stringify(data), MAX_RAW_REPORT_LENGTH),
  };
}
