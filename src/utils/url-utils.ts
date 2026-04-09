/**
 * Extracts the origin (protocol + hostname + port) from a URL string.
 */
export function extractOrigin(url: string): string {
  const parsed = new URL(url);
  return parsed.origin;
}

/**
 * Returns true if the hostname refers to localhost.
 */
export function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

/**
 * Returns true if two URLs share the same origin.
 */
export function isSameOrigin(url1: string, url2: string): boolean {
  return extractOrigin(url1) === extractOrigin(url2);
}

/**
 * Auto-detection logic for whether MITM proxy mode is needed.
 *
 * - localhost/127.0.0.1/[::1] → false (local mode)
 * - http: → false (local mode)
 * - https: with remote hostname → true (MITM mode)
 */
export function shouldUseMitmMode(targetUrl: string): boolean {
  const parsed = new URL(targetUrl);

  if (isLocalhost(parsed.hostname)) {
    return false;
  }

  if (parsed.protocol === 'http:') {
    return false;
  }

  // https: with a remote hostname → MITM mode
  return true;
}

/**
 * Common multi-part ccTLD suffixes where wildcarding the second-level
 * domain would be catastrophically permissive (e.g., *.co.uk).
 */
const MULTI_PART_TLD_PATTERNS = new Set([
  'co', 'com', 'org', 'net', 'ac', 'gov', 'edu',
]);

/**
 * Returns true if the last two labels of a hostname form a known
 * multi-part TLD (e.g., co.uk, com.au, org.nz).
 */
function isMultiPartTld(parts: string[]): boolean {
  if (parts.length < 2) return false;
  const secondLevel = parts[parts.length - 2]!;
  const topLevel = parts[parts.length - 1]!;
  // Only applies to short ccTLDs (2-3 char), not gTLDs like .com
  return topLevel.length <= 3 && MULTI_PART_TLD_PATTERNS.has(secondLevel);
}

/**
 * Generates a wildcard domain from a hostname.
 * e.g., cdn.example.com → *.example.com
 *
 * Handles multi-part TLDs correctly:
 * e.g., cdn.example.co.uk → *.example.co.uk (not *.co.uk)
 *
 * For single-label hostnames (e.g., localhost), returns the hostname as-is.
 */
export function generateWildcardDomain(hostname: string): string {
  const parts = hostname.split('.');

  // For multi-part TLDs (co.uk, com.au, etc.), require ≥4 parts to wildcard
  const minParts = isMultiPartTld(parts) ? 4 : 3;

  if (parts.length < minParts) {
    return hostname;
  }
  return `*.${parts.slice(1).join('.')}`;
}

/**
 * Normalizes special blocked-URI values from CSP violation reports.
 *
 * Browsers report certain violations with special string values
 * rather than full URIs (e.g., 'inline', 'eval', 'data', 'blob').
 */
export function normalizeBlockedUri(blockedUri: string): string {
  if (!blockedUri || blockedUri === '') {
    return "'none'";
  }

  const lower = blockedUri.toLowerCase();

  if (lower === 'inline' || lower === "'inline'") {
    return "'unsafe-inline'";
  }
  if (lower === 'eval' || lower === "'eval'") {
    return "'unsafe-eval'";
  }
  if (lower === 'data' || lower.startsWith('data:')) {
    return 'data:';
  }
  if (lower === 'blob' || lower.startsWith('blob:')) {
    return 'blob:';
  }
  if (lower === 'mediastream' || lower.startsWith('mediastream:')) {
    return 'mediastream:';
  }
  if (lower === 'filesystem' || lower.startsWith('filesystem:')) {
    return 'filesystem:';
  }
  if (lower === 'about') {
    return "'none'";
  }

  // For regular URLs, return as-is
  return blockedUri;
}
