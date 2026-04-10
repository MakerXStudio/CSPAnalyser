import { describe, it, expect } from 'vitest';
import {
  parsePermissionsPolicy,
  parseFeaturePolicy,
  parsePermissionsPolicyHeaders,
  KNOWN_PERMISSIONS_POLICY_DIRECTIVES,
} from '../src/permissions-policy.js';

// ── parsePermissionsPolicy ─────────────────────────────────────────────

describe('parsePermissionsPolicy', () => {
  it('parses a single directive with empty allowlist', () => {
    const result = parsePermissionsPolicy('camera=()');
    expect(result).toHaveLength(1);
    expect(result[0]!.directive).toBe('camera');
    expect(result[0]!.allowlist).toEqual([]);
    expect(result[0]!.headerType).toBe('permissions-policy');
  });

  it('parses a single directive with self', () => {
    const result = parsePermissionsPolicy('geolocation=(self)');
    expect(result).toHaveLength(1);
    expect(result[0]!.directive).toBe('geolocation');
    expect(result[0]!.allowlist).toEqual(['self']);
  });

  it('parses a single directive with wildcard', () => {
    const result = parsePermissionsPolicy('fullscreen=*');
    expect(result).toHaveLength(1);
    expect(result[0]!.directive).toBe('fullscreen');
    expect(result[0]!.allowlist).toEqual(['*']);
  });

  it('parses multiple directives separated by commas', () => {
    const result = parsePermissionsPolicy('camera=(), geolocation=(self), microphone=()');
    expect(result).toHaveLength(3);
    expect(result[0]!.directive).toBe('camera');
    expect(result[1]!.directive).toBe('geolocation');
    expect(result[2]!.directive).toBe('microphone');
  });

  it('parses a directive with self and quoted origins', () => {
    const result = parsePermissionsPolicy('geolocation=(self "https://example.com")');
    expect(result).toHaveLength(1);
    expect(result[0]!.allowlist).toEqual(['self', '"https://example.com"']);
  });

  it('parses a directive with only a quoted origin', () => {
    const result = parsePermissionsPolicy('payment=("https://pay.example.com")');
    expect(result).toHaveLength(1);
    expect(result[0]!.allowlist).toEqual(['"https://pay.example.com"']);
  });

  it('normalises directive names to lowercase', () => {
    const result = parsePermissionsPolicy('Camera=()');
    expect(result[0]!.directive).toBe('camera');
  });

  it('returns empty array for empty string', () => {
    expect(parsePermissionsPolicy('')).toEqual([]);
  });

  it('returns empty array for whitespace', () => {
    expect(parsePermissionsPolicy('   ')).toEqual([]);
  });

  it('skips entries without = sign', () => {
    const result = parsePermissionsPolicy('camera=(), invalid, microphone=()');
    expect(result).toHaveLength(2);
    expect(result[0]!.directive).toBe('camera');
    expect(result[1]!.directive).toBe('microphone');
  });

  it('handles multiple origins in allowlist', () => {
    const result = parsePermissionsPolicy('geolocation=(self "https://a.com" "https://b.com")');
    expect(result[0]!.allowlist).toEqual(['self', '"https://a.com"', '"https://b.com"']);
  });
});

// ── parseFeaturePolicy ─────────────────────────────────────────────────

describe('parseFeaturePolicy', () => {
  it('parses a single directive with none', () => {
    const result = parseFeaturePolicy("camera 'none'");
    expect(result).toHaveLength(1);
    expect(result[0]!.directive).toBe('camera');
    expect(result[0]!.allowlist).toEqual([]);
    expect(result[0]!.headerType).toBe('feature-policy');
  });

  it('parses a single directive with self', () => {
    const result = parseFeaturePolicy("geolocation 'self'");
    expect(result).toHaveLength(1);
    expect(result[0]!.directive).toBe('geolocation');
    expect(result[0]!.allowlist).toEqual(['self']);
  });

  it('parses multiple directives separated by semicolons', () => {
    const result = parseFeaturePolicy("camera 'none'; microphone 'self'");
    expect(result).toHaveLength(2);
    expect(result[0]!.directive).toBe('camera');
    expect(result[0]!.allowlist).toEqual([]);
    expect(result[1]!.directive).toBe('microphone');
    expect(result[1]!.allowlist).toEqual(['self']);
  });

  it('parses a directive with wildcard', () => {
    const result = parseFeaturePolicy('fullscreen *');
    expect(result).toHaveLength(1);
    expect(result[0]!.allowlist).toEqual(['*']);
  });

  it('parses a directive with origins', () => {
    const result = parseFeaturePolicy("geolocation 'self' https://example.com");
    expect(result).toHaveLength(1);
    expect(result[0]!.allowlist).toEqual(['self', '"https://example.com"']);
  });

  it('renames vr to xr-spatial-tracking', () => {
    const result = parseFeaturePolicy("vr 'self'");
    expect(result[0]!.directive).toBe('xr-spatial-tracking');
  });

  it('returns empty array for empty string', () => {
    expect(parseFeaturePolicy('')).toEqual([]);
  });

  it('returns empty array for whitespace', () => {
    expect(parseFeaturePolicy('   ')).toEqual([]);
  });
});

// ── parsePermissionsPolicyHeaders ──────────────────────────────────────

describe('parsePermissionsPolicyHeaders', () => {
  it('parses Permissions-Policy header', () => {
    const headers = { 'Permissions-Policy': 'camera=(), geolocation=(self)' };
    const result = parsePermissionsPolicyHeaders(headers);
    expect(result).toHaveLength(2);
    expect(result[0]!.directive).toBe('camera');
    expect(result[0]!.headerType).toBe('permissions-policy');
    expect(result[1]!.directive).toBe('geolocation');
  });

  it('parses Feature-Policy header', () => {
    const headers = { 'Feature-Policy': "camera 'none'; microphone 'self'" };
    const result = parsePermissionsPolicyHeaders(headers);
    expect(result).toHaveLength(2);
    expect(result[0]!.headerType).toBe('feature-policy');
  });

  it('parses both headers when both are present', () => {
    const headers = {
      'Permissions-Policy': 'camera=()',
      'Feature-Policy': "microphone 'none'",
    };
    const result = parsePermissionsPolicyHeaders(headers);
    expect(result).toHaveLength(2);
    expect(result.find((d) => d.directive === 'camera')).toBeDefined();
    expect(result.find((d) => d.directive === 'microphone')).toBeDefined();
  });

  it('handles case-insensitive header names', () => {
    const headers = { 'permissions-policy': 'camera=()' };
    const result = parsePermissionsPolicyHeaders(headers);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no relevant headers', () => {
    const headers = { 'Content-Type': 'text/html' };
    expect(parsePermissionsPolicyHeaders(headers)).toEqual([]);
  });

  it('returns empty array for empty headers object', () => {
    expect(parsePermissionsPolicyHeaders({})).toEqual([]);
  });
});

// ── KNOWN_PERMISSIONS_POLICY_DIRECTIVES ────────────────────────────────

describe('KNOWN_PERMISSIONS_POLICY_DIRECTIVES', () => {
  it('contains well-known directives', () => {
    expect(KNOWN_PERMISSIONS_POLICY_DIRECTIVES.has('camera')).toBe(true);
    expect(KNOWN_PERMISSIONS_POLICY_DIRECTIVES.has('microphone')).toBe(true);
    expect(KNOWN_PERMISSIONS_POLICY_DIRECTIVES.has('geolocation')).toBe(true);
    expect(KNOWN_PERMISSIONS_POLICY_DIRECTIVES.has('fullscreen')).toBe(true);
    expect(KNOWN_PERMISSIONS_POLICY_DIRECTIVES.has('payment')).toBe(true);
  });

  it('does not contain random strings', () => {
    expect(KNOWN_PERMISSIONS_POLICY_DIRECTIVES.has('not-a-directive')).toBe(false);
  });
});
