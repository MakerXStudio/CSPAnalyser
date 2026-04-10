/**
 * Permissions-Policy and Feature-Policy header parsing and analysis.
 *
 * Supports both the modern Permissions-Policy header and the legacy
 * Feature-Policy header format.
 */

// ── Known directives ────────────────────────────────────────────────────

/**
 * Well-known Permissions-Policy directives as defined in the W3C spec
 * and browser implementations.
 */
export const KNOWN_PERMISSIONS_POLICY_DIRECTIVES: ReadonlySet<string> = new Set([
  'accelerometer',
  'ambient-light-sensor',
  'autoplay',
  'battery',
  'bluetooth',
  'browsing-topics',
  'camera',
  'captured-surface-control',
  'clipboard-read',
  'clipboard-write',
  'compute-pressure',
  'cross-origin-isolated',
  'digital-credentials-get',
  'direct-sockets',
  'display-capture',
  'document-domain',
  'encrypted-media',
  'execution-while-not-rendered',
  'execution-while-out-of-viewport',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'identity-credentials-get',
  'idle-detection',
  'interest-cohort',
  'keyboard-map',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'otp-credentials',
  'payment',
  'picture-in-picture',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'speaker-selection',
  'storage-access',
  'usb',
  'web-share',
  'window-management',
  'xr-spatial-tracking',
]);

// ── Types ───────────────────────────────────────────────────────────────

export type HeaderType = 'permissions-policy' | 'feature-policy';

export interface ParsedDirective {
  directive: string;
  allowlist: string[];
  headerType: HeaderType;
}

// ── Feature-Policy → Permissions-Policy mapping ─────────────────────────

/**
 * Maps legacy Feature-Policy directive names to their Permissions-Policy equivalents.
 * Only includes directives that were renamed.
 */
const FEATURE_POLICY_RENAME_MAP: ReadonlyMap<string, string> = new Map([
  ['vr', 'xr-spatial-tracking'],
]);

/**
 * Normalises a Feature-Policy allowlist token to Permissions-Policy syntax.
 *
 * Feature-Policy uses:  'self', 'none', '*', or origins without quotes
 * Permissions-Policy uses: self, *, or "origin"
 */
function normaliseFeaturePolicyToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed === "'self'") return 'self';
  if (trimmed === "'none'") return '()';
  if (trimmed === '*') return '*';
  // Origins in Feature-Policy are unquoted; in Permissions-Policy they are quoted
  return `"${trimmed}"`;
}

// ── Parsers ─────────────────────────────────────────────────────────────

/**
 * Parses a Permissions-Policy header value.
 *
 * Format: directive=(allowlist), directive=(allowlist), ...
 * Example: camera=(), geolocation=(self "https://example.com"), fullscreen=*
 */
export function parsePermissionsPolicy(headerValue: string): ParsedDirective[] {
  const results: ParsedDirective[] = [];
  if (!headerValue.trim()) return results;

  // Split on commas that are outside parentheses
  const directives = splitDirectives(headerValue);

  for (const raw of directives) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const directive = trimmed.slice(0, eqIndex).trim().toLowerCase();
    const valueStr = trimmed.slice(eqIndex + 1).trim();

    const allowlist = parseAllowlist(valueStr);
    results.push({ directive, allowlist, headerType: 'permissions-policy' });
  }

  return results;
}

/**
 * Parses a Feature-Policy header value and normalises to Permissions-Policy format.
 *
 * Format: directive 'allowlist'; directive 'allowlist'; ...
 * Example: camera 'none'; geolocation 'self' https://example.com
 */
export function parseFeaturePolicy(headerValue: string): ParsedDirective[] {
  const results: ParsedDirective[] = [];
  if (!headerValue.trim()) return results;

  const entries = headerValue.split(';');

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length === 0) continue;

    const rawDirective = parts[0].toLowerCase();
    const directive = FEATURE_POLICY_RENAME_MAP.get(rawDirective) ?? rawDirective;
    const tokens = parts.slice(1);

    // Check for 'none' as the only token
    if (tokens.length === 1 && tokens[0] === "'none'") {
      results.push({ directive, allowlist: [], headerType: 'feature-policy' });
      continue;
    }

    const allowlist = tokens.map(normaliseFeaturePolicyToken).filter((t) => t !== '()');
    results.push({ directive, allowlist, headerType: 'feature-policy' });
  }

  return results;
}

/**
 * Parses both Permissions-Policy and Feature-Policy headers from a set
 * of response headers.
 *
 * If both are present, both are parsed (the Permissions-Policy takes
 * precedence in browsers, but we capture both for completeness).
 */
export function parsePermissionsPolicyHeaders(headers: Record<string, string>): ParsedDirective[] {
  const results: ParsedDirective[] = [];

  // Iterate headers case-insensitively
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'permissions-policy') {
      results.push(...parsePermissionsPolicy(value));
    } else if (lower === 'feature-policy') {
      results.push(...parseFeaturePolicy(value));
    }
  }

  return results;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Splits a Permissions-Policy header value on commas that aren't inside parentheses.
 */
function splitDirectives(headerValue: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of headerValue) {
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    result.push(current);
  }

  return result;
}

/**
 * Parses the allowlist portion of a Permissions-Policy directive.
 *
 * Handles: *, (), (self), (self "https://example.com"), "https://example.com"
 */
function parseAllowlist(value: string): string[] {
  if (value === '*') return ['*'];
  if (value === '()') return [];

  // Remove surrounding parentheses
  let inner = value;
  if (inner.startsWith('(') && inner.endsWith(')')) {
    inner = inner.slice(1, -1).trim();
  }

  if (!inner) return [];

  // Split on whitespace, preserving quoted strings
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const ch of inner) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (/\s/.test(ch) && !inQuotes) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  return tokens;
}
