import { createHash } from 'node:crypto';
import type { Violation, StrictnessLevel } from './types.js';
import { extractOrigin, isSameOrigin, generateWildcardDomain } from './utils/url-utils.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

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
  if (strictness === 'strict') {
    return extractOrigin(blockedUri);
  }

  // moderate: wildcard for 3+ label hostnames, else exact origin
  // permissive: wildcard for 2+ label hostnames (more lenient)
  const hostname = parsed.hostname;
  const labels = hostname.split('.');

  if (strictness === 'permissive') {
    if (labels.length >= 2) {
      return `*.${hostname}`;
    }
    return extractOrigin(blockedUri);
  }

  // moderate
  if (labels.length >= 3) {
    return generateWildcardDomain(hostname);
  }

  return extractOrigin(blockedUri);
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
