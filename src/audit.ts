import type Database from 'better-sqlite3';
import type { StrictnessLevel, ExistingCspHeaderType, Violation } from './types.js';
import {
  getExistingCspHeaders,
  getViolations,
  getSession,
  getInlineHashes,
} from './db/repository.js';
import {
  generatePolicyFromViolations,
  mergeInlineHashes,
  type PolicyGeneratorOptions,
} from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';
import { comparePolicies, type PolicyDiff } from './policy-diff.js';
import { parseCspHeader, unionDirectives, mergeDirectives } from './utils/csp-parser.js';
import { directivesToString } from './policy-formatter.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

// ── Types ──────────────────────────────────────────────────────────────

export interface AuditPolicyResult {
  /** The existing CSP parsed from response headers */
  existingDirectives: Record<string, string[]>;
  /** The merged policy with violations resolved and optimizations applied */
  mergedDirectives: Record<string, string[]>;
  /** Diff between existing and merged policy */
  diff: PolicyDiff;
  /** Number of violations that contributed to this result */
  violationCount: number;
}

export interface AuditResult {
  sessionId: string;
  pagesVisited: number;
  violationsFound: number;
  /** Result for the enforced Content-Security-Policy header, if present */
  enforced: AuditPolicyResult | null;
  /** Result for the Content-Security-Policy-Report-Only header, if present */
  reportOnly: AuditPolicyResult | null;
}

export interface AuditOptions {
  strictness: StrictnessLevel;
}

// ── Core logic ────────────────────────────────────────────────────────

/**
 * Generates violation-derived directive additions from a filtered set of violations,
 * including inline hashes when requested.
 */
function generateAdditionsFromViolations(
  db: Database.Database,
  sessionId: string,
  violations: Violation[],
  targetOrigin: string,
  options: PolicyGeneratorOptions,
): Record<string, string[]> {
  const directives = generatePolicyFromViolations(violations, targetOrigin, options);

  // Merge inline content hashes from the inline_hashes table
  if (options.includeHashes) {
    const inlineHashes = getInlineHashes(db, sessionId);
    mergeInlineHashes(directives, inlineHashes);
  }

  return directives;
}

/**
 * Builds an audit result for a single CSP header type (enforced or report-only).
 */
function buildAuditPolicyResult(
  existingDirectives: Record<string, string[]>,
  violationDirectives: Record<string, string[]>,
  violationCount: number,
  targetOrigin: string,
  strictness: StrictnessLevel,
): AuditPolicyResult {
  // Merge violation-derived additions into the existing policy
  const merged = mergeDirectives(existingDirectives, violationDirectives);

  // Optimize the merged policy
  const optimized = optimizePolicy(merged, targetOrigin, {
    useHashes: true,
    stripUnsafeInline: strictness === 'strict',
    stripUnsafeEval: strictness === 'strict',
  });

  // Diff the existing vs merged
  const diff = comparePolicies(existingDirectives, optimized);

  return {
    existingDirectives,
    mergedDirectives: optimized,
    diff,
    violationCount,
  };
}

/**
 * Generates an audit result for a completed audit session.
 *
 * Reads the captured existing CSP headers, filters violations by disposition
 * (enforce vs report), generates per-header-type additions, merges them,
 * and produces a diff for both enforced and report-only CSP independently.
 */
export function generateAuditResult(
  db: Database.Database,
  sessionId: string,
  options: AuditOptions,
): AuditResult {
  const session = getSession(db, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const allViolations = getViolations(db, sessionId);
  const targetOrigin = session.targetUrl;
  const includeHashes = options.strictness === 'strict';

  logger.info('Generating audit result', {
    sessionId,
    violationCount: allViolations.length,
    strictness: options.strictness,
  });

  // Map disposition to header type:
  // - disposition 'enforce' → violations from the enforced CSP header
  // - disposition 'report' → violations from the report-only CSP header
  const enforcedViolations = allViolations.filter((v) => v.disposition === 'enforce');
  const reportOnlyViolations = allViolations.filter((v) => v.disposition === 'report');

  const policyGenOptions: PolicyGeneratorOptions = {
    strictness: options.strictness,
    includeHashes,
  };

  // Build results for each CSP header type using only its own violations
  const buildForHeaderType = (
    headerType: ExistingCspHeaderType,
    violations: Violation[],
  ): AuditPolicyResult | null => {
    const headers = getExistingCspHeaders(db, sessionId, headerType);
    if (headers.length === 0) return null;

    // Parse and union all captured headers of this type
    const parsedHeaders = headers.map((h) => parseCspHeader(h.headerValue));
    const existingDirectives = unionDirectives(...parsedHeaders);

    // Generate additions only from violations triggered by this header type
    const violationDirectives = generateAdditionsFromViolations(
      db,
      sessionId,
      violations,
      targetOrigin,
      policyGenOptions,
    );

    return buildAuditPolicyResult(
      existingDirectives,
      violationDirectives,
      violations.length,
      targetOrigin,
      options.strictness,
    );
  };

  // Count pages from violations (unique document URIs)
  const pageUrls = new Set(allViolations.map((v) => v.documentUri));

  return {
    sessionId,
    pagesVisited: pageUrls.size,
    violationsFound: allViolations.length,
    enforced: buildForHeaderType('enforced', enforcedViolations),
    reportOnly: buildForHeaderType('report-only', reportOnlyViolations),
  };
}

// ── Formatting ────────────────────────────────────────────────────────

function formatPolicyDiff(diff: PolicyDiff): string[] {
  const lines: string[] = [];

  if (diff.addedDirectives.length > 0) {
    lines.push('  New directives:');
    for (const d of diff.addedDirectives) {
      lines.push(`    + ${d}`);
    }
  }

  if (diff.removedDirectives.length > 0) {
    lines.push('  Removed directives:');
    for (const d of diff.removedDirectives) {
      lines.push(`    - ${d}`);
    }
  }

  if (diff.changedDirectives.length > 0) {
    lines.push('  Changed directives:');
    for (const change of diff.changedDirectives) {
      lines.push(`    ${change.directive}:`);
      for (const s of change.added) {
        lines.push(`      + ${s}`);
      }
      for (const s of change.removed) {
        lines.push(`      - ${s}`);
      }
    }
  }

  if (
    diff.addedDirectives.length === 0 &&
    diff.removedDirectives.length === 0 &&
    diff.changedDirectives.length === 0
  ) {
    lines.push('  No changes needed.');
  }

  return lines;
}

function formatPolicyResult(
  label: string,
  result: AuditPolicyResult,
  isReportOnly: boolean,
): string[] {
  const lines: string[] = [];
  const headerName = isReportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';

  lines.push(`=== ${label} (${headerName}) ===`);
  lines.push(`Violations: ${result.violationCount}`);
  lines.push('');

  // Existing policy
  lines.push('Existing policy:');
  lines.push(`  ${directivesToString(result.existingDirectives)}`);
  lines.push('');

  // Diff
  lines.push('Changes:');
  lines.push(...formatPolicyDiff(result.diff));
  lines.push('');

  // Merged policy
  lines.push('Updated policy:');
  lines.push(`  ${headerName}: ${directivesToString(result.mergedDirectives)}`);

  return lines;
}

/**
 * Formats an audit result as human-readable text output.
 */
export function formatAuditResult(result: AuditResult): string {
  const lines: string[] = [];

  lines.push(`Audit session: ${result.sessionId}`);
  lines.push(`Violations found: ${result.violationsFound}`);
  lines.push('');

  if (!result.enforced && !result.reportOnly) {
    lines.push('No existing CSP headers were found on the target site.');
    lines.push('Use the "crawl" command to generate a CSP from scratch.');
    return lines.join('\n');
  }

  if (result.enforced) {
    lines.push(...formatPolicyResult('Enforced CSP', result.enforced, false));
  }

  if (result.enforced && result.reportOnly) {
    lines.push('');
  }

  if (result.reportOnly) {
    lines.push(...formatPolicyResult('Report-Only CSP', result.reportOnly, true));
  }

  return lines.join('\n');
}
