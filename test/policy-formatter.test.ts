import { describe, it, expect } from 'vitest';
import { directivesToString, formatPolicy } from '../src/policy-formatter.js';

// ── directivesToString ──────────────────────────────────────────────────

describe('directivesToString', () => {
  it('converts a single directive', () => {
    expect(directivesToString({ 'script-src': ["'self'"] })).toBe("script-src 'self'");
  });

  it('converts multiple directives', () => {
    const result = directivesToString({
      'script-src': ["'self'", 'https://cdn.example.com'],
      'img-src': ['data:', "'self'"],
    });
    expect(result).toBe("script-src 'self' https://cdn.example.com; img-src data: 'self'");
  });

  it('returns empty string for empty directives', () => {
    expect(directivesToString({})).toBe('');
  });

  it('handles directives with special characters in source expressions', () => {
    const result = directivesToString({
      'script-src': ["'nonce-abc123'", "'sha256-xyz=='"],
    });
    expect(result).toBe("script-src 'nonce-abc123' 'sha256-xyz=='");
  });
});

// ── formatPolicy: header ────────────────────────────────────────────────

describe('formatPolicy — header', () => {
  const directives = { 'default-src': ["'self'"], 'script-src': ["'self'", 'https://cdn.example.com'] };

  it('produces a Content-Security-Policy header', () => {
    const result = formatPolicy(directives, 'header');
    expect(result).toBe(
      "Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com",
    );
  });

  it('produces a report-only header when isReportOnly is true', () => {
    const result = formatPolicy(directives, 'header', true);
    expect(result).toMatch(/^Content-Security-Policy-Report-Only:/);
  });

  it('handles empty directives', () => {
    expect(formatPolicy({}, 'header')).toBe('Content-Security-Policy: ');
  });
});

// ── formatPolicy: meta ──────────────────────────────────────────────────

describe('formatPolicy — meta', () => {
  it('produces a meta tag', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'meta');
    expect(result).toBe('<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">');
  });

  it('strips report-uri and report-to directives', () => {
    const directives = {
      'default-src': ["'self'"],
      'report-uri': ['/csp-report'],
      'report-to': ['default'],
    };
    const result = formatPolicy(directives, 'meta');
    expect(result).not.toContain('report-uri');
    expect(result).not.toContain('report-to');
    expect(result).toContain("default-src 'self'");
  });

  it('uses report-only http-equiv when isReportOnly is true', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'meta', true);
    expect(result).toContain('Content-Security-Policy-Report-Only');
  });

  it('HTML-escapes quotes, angle brackets, and ampersands in the content attribute', () => {
    const directives = { 'default-src': ['https://example.com/"test"', '<script>'] };
    const result = formatPolicy(directives, 'meta');
    expect(result).not.toContain('"test"');
    expect(result).toContain('&quot;test&quot;');
    expect(result).toContain('&lt;script&gt;');
    // Verify well-formed tag
    expect(result).toMatch(/^<meta http-equiv="[^"]*" content="[^"]*">$/);
  });
});

// ── formatPolicy: nginx ─────────────────────────────────────────────────

describe('formatPolicy — nginx', () => {
  it('produces an nginx add_header directive', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'nginx');
    expect(result).toBe("add_header Content-Security-Policy \"default-src 'self'\" always;");
  });

  it('escapes double quotes in the policy string', () => {
    // Unlikely but defensive: source expression containing a double quote
    const result = formatPolicy({ 'default-src': ['https://example.com/"test"'] }, 'nginx');
    expect(result).toContain('\\"test\\"');
    expect(result).toMatch(/^add_header Content-Security-Policy ".*" always;$/);
  });

  it('uses report-only header name when isReportOnly is true', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'nginx', true);
    expect(result).toContain('Content-Security-Policy-Report-Only');
  });
});

// ── formatPolicy: apache ────────────────────────────────────────────────

describe('formatPolicy — apache', () => {
  it('produces an Apache Header directive', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'apache');
    expect(result).toBe("Header always set Content-Security-Policy \"default-src 'self'\"");
  });

  it('uses report-only header name when isReportOnly is true', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'apache', true);
    expect(result).toContain('Content-Security-Policy-Report-Only');
  });

  it('escapes double quotes in the policy string', () => {
    const result = formatPolicy({ 'default-src': ['https://example.com/"test"'] }, 'apache');
    expect(result).toContain('\\"test\\"');
    expect(result).toMatch(/^Header always set Content-Security-Policy ".*"$/);
  });
});

// ── formatPolicy: cloudflare ────────────────────────────────────────────

describe('formatPolicy — cloudflare', () => {
  it('produces a Cloudflare Workers snippet', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'cloudflare');
    expect(result).toContain('export default {');
    expect(result).toContain('async fetch(request, env, ctx)');
    expect(result).toContain("headers.set('Content-Security-Policy'");
    expect(result).toContain('return newResponse;');
  });

  it('escapes single quotes in source expressions for the JS string', () => {
    const result = formatPolicy({ 'script-src': ["'self'", "'unsafe-inline'"] }, 'cloudflare');
    expect(result).toContain("\\'self\\'");
    expect(result).toContain("\\'unsafe-inline\\'");
  });

  it('uses report-only header name when isReportOnly is true', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'cloudflare', true);
    expect(result).toContain('Content-Security-Policy-Report-Only');
  });

  it('escapes backslashes in source expressions for the JS string', () => {
    // A source expression containing a backslash should be double-escaped in JS
    const result = formatPolicy({ 'default-src': ['https://example.com\\path'] }, 'cloudflare');
    expect(result).toContain('\\\\path');
    // Backslash should be escaped before single-quote escaping
    expect(result).not.toMatch(/[^\\]\\p/);
  });
});

// ── formatPolicy: cloudflare-pages ─────────────────────────────────────

describe('formatPolicy — cloudflare-pages', () => {
  it('produces a Cloudflare Pages _headers file snippet', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'cloudflare-pages');
    expect(result).toBe("/*\n  Content-Security-Policy: default-src 'self'");
  });

  it('includes multiple directives on a single line', () => {
    const result = formatPolicy(
      { 'default-src': ["'self'"], 'script-src': ["'self'", 'https://cdn.example.com'] },
      'cloudflare-pages',
    );
    expect(result).toBe(
      "/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com",
    );
  });

  it('uses report-only header name when isReportOnly is true', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'cloudflare-pages', true);
    expect(result).toContain('Content-Security-Policy-Report-Only');
    expect(result).toMatch(/^\/\*\n  Content-Security-Policy-Report-Only:/);
  });

  it('handles empty directives', () => {
    const result = formatPolicy({}, 'cloudflare-pages');
    expect(result).toBe('/*\n  Content-Security-Policy: ');
  });
});

// ── formatPolicy: json ──────────────────────────────────────────────────

describe('formatPolicy — json', () => {
  it('produces valid JSON with directives, policyString, and isReportOnly', () => {
    const directives = { 'default-src': ["'self'"] };
    const result = formatPolicy(directives, 'json');
    const parsed = JSON.parse(result);
    expect(parsed.directives).toEqual(directives);
    expect(parsed.policyString).toBe("default-src 'self'");
    expect(parsed.isReportOnly).toBe(false);
  });

  it('sets isReportOnly to true in JSON output', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'json', true);
    const parsed = JSON.parse(result);
    expect(parsed.isReportOnly).toBe(true);
  });

  it('uses 2-space indentation', () => {
    const result = formatPolicy({ 'default-src': ["'self'"] }, 'json');
    expect(result).toContain('  "directives"');
  });

  it('handles empty directives', () => {
    const result = formatPolicy({}, 'json');
    const parsed = JSON.parse(result);
    expect(parsed.directives).toEqual({});
    expect(parsed.policyString).toBe('');
  });
});
