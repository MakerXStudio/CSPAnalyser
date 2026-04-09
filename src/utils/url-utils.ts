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
 * Generates a wildcard domain from a hostname.
 * e.g., cdn.example.com → *.example.com
 *
 * For single-label hostnames (e.g., localhost), returns the hostname as-is.
 */
export function generateWildcardDomain(hostname: string): string {
  const parts = hostname.split('.');
  if (parts.length <= 2) {
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
