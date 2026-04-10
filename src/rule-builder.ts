import { createHash } from 'node:crypto';
import type { Violation, StrictnessLevel } from './types.js';
import { extractOrigin, isSameOrigin, generateWildcardDomain } from './utils/url-utils.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

/**
 * Validates that a CSP source expression does not contain characters that could
 * inject additional directives or break the policy. Returns true if safe.
 *
 * Rejects expressions containing semicolons, newlines, carriage returns, or
 * null bytes — all of which could be used to inject additional CSP directives.
 */
export function isValidSourceExpression(source: string): boolean {
  // Semicolons delimit CSP directives — a source containing one could inject directives
  // Newlines/CR could break header parsing; null bytes are never valid
  return !/[;\r\n\0]/.test(source);
}

/**
 * Maps a single violation to a CSP source expression based on strictness level.
 *
 * Returns null if the violation should be skipped (e.g. blocked-uri is 'none').
 */
export function violationToSourceExpression(
  violation: Violation,
  targetOrigin: string,
  strictness: StrictnessLevel,
): string | null {
  const blockedUri = violation.blockedUri;

  // Handle special keyword values
  if (blockedUri === "'unsafe-inline'") return "'unsafe-inline'";
  if (blockedUri === "'unsafe-eval'") return "'unsafe-eval'";
  if (blockedUri === 'data:') return 'data:';
  if (blockedUri === 'blob:') return 'blob:';
  if (blockedUri === 'mediastream:') return 'mediastream:';
  if (blockedUri === "'none'") return null;

  // URL-based blocked URIs
  let parsed: URL;
  try {
    parsed = new URL(blockedUri);
  } catch {
    logger.warn('Could not parse blocked URI as URL, skipping', { blockedUri });
    return null;
  }

  // Same origin → 'self'
  if (isSameOrigin(blockedUri, targetOrigin)) {
    return "'self'";
  }

  // External origin — strictness determines the source expression
  let result: string;

  if (strictness === 'strict') {
    result = extractOrigin(blockedUri);
  } else {
    // moderate: wildcard for 3+ label hostnames, else exact origin
    // permissive: wildcard for 2+ label hostnames (more lenient)
    const hostname = parsed.hostname;
    const labels = hostname.split('.');

    if (strictness === 'permissive') {
      // permissive: wildcard for 3+ labels (same as moderate), plus wildcard 2-label hostnames
      // This is always at least as broad as moderate
      if (labels.length >= 3) {
        result = generateWildcardDomain(hostname);
      } else if (labels.length >= 2) {
        result = `*.${hostname}`;
      } else {
        result = extractOrigin(blockedUri);
      }
    } else {
      // moderate: wildcard for 3+ label hostnames, else exact origin
      result = labels.length >= 3 ? generateWildcardDomain(hostname) : extractOrigin(blockedUri);
    }
  }

  // Validate that the resulting expression can't inject additional CSP directives
  if (!isValidSourceExpression(result)) {
    logger.warn('Source expression contains invalid characters, skipping', { source: result, blockedUri });
    return null;
  }

  return result;
}

/**
 * Generates a hash-based source expression from a violation's sample content.
 *
 * Returns a 'sha256-...' value if the violation has a sample and the effective
 * directive is script-src or style-src (or their sub-directives). Returns null otherwise.
 */
/**
 * Browsers truncate violation samples at ~256 characters. A hash of a
 * truncated sample won't match the full script/style, so skip it.
 */
const MAX_SAMPLE_LENGTH = 256;

export function violationToHashSource(violation: Violation): string | null {
  if (!violation.sample) return null;

  if (violation.sample.length >= MAX_SAMPLE_LENGTH) {
    return null;
  }

  const directive = violation.effectiveDirective;
  if (!directive.startsWith('script-src') && !directive.startsWith('style-src')) {
    return null;
  }

  const hash = createHash('sha256').update(violation.sample).digest('base64');
  return `'sha256-${hash}'`;
}
