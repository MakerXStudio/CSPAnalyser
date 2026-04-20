/**
 * Private/link-local IPv4 ranges that may indicate SSRF attempts.
 */
const PRIVATE_IPV4_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918
  /^192\.168\./, // RFC 1918
  /^169\.254\./, // link-local
  /^0\./, // "this" network
];

/**
 * Returns true if a hostname is a private/link-local IPv6 address.
 * Covers loopback (::1), link-local (fe80::), unique local (fc00::/7),
 * and the unspecified address (::).
 */
function isPrivateIPv6(hostname: string): boolean {
  // Strip brackets from IPv6 literals like [::1]
  const bare =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const lower = bare.toLowerCase();

  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local (fc00::/7)

  return false;
}

export interface ValidateTargetUrlOptions {
  /**
   * Allow all private/internal IP addresses (IPv4 RFC 1918, link-local, IPv6 ULA).
   * When true, overrides all private IP checks.
   */
  allowPrivateIps?: boolean;
  /**
   * Allow localhost and local-network targets.
   * When false (default), localhost, loopback IPs, and private IPs are all rejected.
   * When true, localhost/loopback is allowed but other private IPs are still blocked
   * unless allowPrivateIps is also set.
   *
   * CLI sets this to true (local dev tool); MCP server leaves it false (agent-driven).
   */
  allowLocalNetwork?: boolean;
}

/**
 * Returns true if a resolved IP address is private/link-local.
 */
function isPrivateIp(ip: string): boolean {
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(ip)) return true;
  }
  return isPrivateIPv6(ip);
}

/**
 * Validates that a target URL is safe for crawling:
 * - Must be a valid URL
 * - Must use http: or https: scheme
 * - By default, rejects localhost, private/link-local IPs (IPv4 and IPv6)
 * - Resolves DNS to catch hostnames that point to private/loopback addresses
 * - Use allowLocalNetwork to permit localhost (CLI mode)
 * - Use allowPrivateIps to permit all private ranges
 *
 * Throws a descriptive error for invalid URLs.
 */
export function validateTargetUrl(url: string, options?: ValidateTargetUrlOptions): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid target URL: "${url}" is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid target URL scheme: "${parsed.protocol}" — only http: and https: are allowed`,
    );
  }

  // When allowPrivateIps is set, skip all private/local checks
  if (options?.allowPrivateIps) {
    return url;
  }

  const hostname = parsed.hostname;
  const isLocal = isLocalhost(hostname);

  // Block localhost unless allowLocalNetwork is explicitly set
  if (isLocal && !options?.allowLocalNetwork) {
    throw new Error(
      `Invalid target URL: localhost/loopback addresses are not allowed in MCP mode ("${hostname}"). ` +
        'Use allowLocalNetwork to override.',
    );
  }

  // Block private IPv4 ranges (unless it's localhost and allowLocalNetwork is set)
  if (!isLocal) {
    for (const pattern of PRIVATE_IPV4_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new Error(
          `Invalid target URL: private/internal IP addresses are not allowed ("${hostname}"). Use --allow-private-ips to override.`,
        );
      }
    }
  }

  // Block private IPv6 ranges (unless it's localhost/loopback and allowLocalNetwork is set)
  if (!isLocal && isPrivateIPv6(hostname)) {
    throw new Error(
      `Invalid target URL: private/internal IPv6 addresses are not allowed ("${hostname}"). Use --allow-private-ips to override.`,
    );
  }

  return url;
}

/**
 * Async version of validateTargetUrl that also resolves DNS to catch hostnames
 * pointing to private/loopback addresses (SSRF protection).
 *
 * This should be used in the MCP server where agent-driven crawling needs
 * full SSRF protection. The synchronous validateTargetUrl only checks literal
 * hostnames and cannot catch DNS rebinding to private IPs.
 */
export async function validateTargetUrlWithDns(
  url: string,
  options?: ValidateTargetUrlOptions,
): Promise<string> {
  // First run all synchronous checks
  validateTargetUrl(url, options);

  // Skip DNS resolution if private IPs are allowed or if the hostname is
  // already a literal IP (already checked above)
  if (options?.allowPrivateIps) return url;

  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Skip DNS check for literal IPs — already validated above
  if (isLocalhost(hostname)) return url;
  for (const pattern of PRIVATE_IPV4_PATTERNS) {
    if (pattern.test(hostname)) return url;
  }
  if (isPrivateIPv6(hostname)) return url;

  // Resolve DNS and check all addresses
  const { lookup } = await import('node:dns/promises');
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isPrivateIp(addr.address) || isLocalhost(addr.address)) {
        const allowLocal = options?.allowLocalNetwork && isLocalhost(addr.address);
        if (!allowLocal) {
          throw new Error(
            `Invalid target URL: hostname "${hostname}" resolves to private/internal address ${addr.address}. ` +
              'Use --allow-private-ips to override.',
          );
        }
      }
    }
  } catch (err) {
    // Re-throw our own SSRF errors, but let DNS lookup failures pass through
    // (the browser will produce a more useful error)
    if (err instanceof Error && err.message.includes('Invalid target URL')) {
      throw err;
    }
  }

  return url;
}

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
 * Common multi-part ccTLD suffixes where wildcarding the second-level
 * domain would be catastrophically permissive (e.g., *.co.uk).
 */
const MULTI_PART_TLD_PATTERNS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

/**
 * Returns true if the last two labels of a hostname form a known
 * multi-part TLD (e.g., co.uk, com.au, org.nz).
 */
function isMultiPartTld(parts: string[]): boolean {
  if (parts.length < 2) return false;
  const secondLevel = parts[parts.length - 2];
  const topLevel = parts[parts.length - 1];
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
