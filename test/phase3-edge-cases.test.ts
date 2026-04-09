import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { violationToSourceExpression, violationToHashSource } from '../src/rule-builder.js';
import { generatePolicyFromViolations } from '../src/policy-generator.js';
import { optimizePolicy, shouldUseDefaultSrc } from '../src/policy-optimizer.js';
import { formatPolicy, directivesToString } from '../src/policy-formatter.js';
import type { Violation } from '../src/types.js';
import type { PolicyGeneratorOptions } from '../src/policy-generator.js';

const TARGET_ORIGIN = 'https://example.com';

function makeViolation(overrides: Partial<Violation> = {}): Violation {
  return {
    id: '1',
    sessionId: 'sess-1',
    pageId: null,
    documentUri: 'https://example.com/page',
    blockedUri: 'https://cdn.example.com/script.js',
    violatedDirective: 'script-src',
    effectiveDirective: 'script-src',
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: null,
    capturedVia: 'report_uri',
    rawReport: '{}',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Rule-builder edge cases ──────────────────────────────────────────────

describe('rule-builder edge cases', () => {
  it('returns null for empty-string blocked URI', () => {
    const v = makeViolation({ blockedUri: '' });
    expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBeNull();
  });

  it('handles URL with username:password (unusual blocked URI)', () => {
    const v = makeViolation({ blockedUri: 'https://user:pass@cdn.example.com/x.js' });
    // Should extract origin only
    expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('https://cdn.example.com');
  });

  it('handles URL with non-standard port', () => {
    const v = makeViolation({ blockedUri: 'https://cdn.example.com:8443/script.js' });
    expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('https://cdn.example.com:8443');
  });

  it('permissive mode returns exact origin for single-label hostname', () => {
    const v = makeViolation({ blockedUri: 'http://localhost/api' });
    expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe('http://localhost');
  });

  it('moderate mode returns exact origin for single-label hostname', () => {
    const v = makeViolation({ blockedUri: 'http://localhost/api' });
    expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe('http://localhost');
  });

  it('permissive mode wildcards IP-like hostname with dots', () => {
    // IP addresses have 4 labels when split by dot
    const v = makeViolation({ blockedUri: 'http://192.168.1.1/api' });
    expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe('*.192.168.1.1');
  });

  it('hash source returns null for empty sample', () => {
    const v = makeViolation({ effectiveDirective: 'script-src', sample: '' });
    // Empty string is falsy, should return null
    expect(violationToHashSource(v)).toBeNull();
  });

  it('hash source works for sample with exactly 255 chars', () => {
    const sample = 'a'.repeat(255);
    const v = makeViolation({ effectiveDirective: 'script-src', sample });
    const expected = `'sha256-${createHash('sha256').update(sample).digest('base64')}'`;
    expect(violationToHashSource(v)).toBe(expected);
  });

  it('hash source returns null for sample with exactly 256 chars', () => {
    const v = makeViolation({ effectiveDirective: 'script-src', sample: 'a'.repeat(256) });
    expect(violationToHashSource(v)).toBeNull();
  });
});

// ── Policy-generator edge cases ─────────────────────────────────────────

describe('policy-generator edge cases', () => {
  const defaultOptions: PolicyGeneratorOptions = { strictness: 'strict', includeHashes: false };

  it('handles many violations for the same directive', () => {
    const violations = Array.from({ length: 50 }, (_, i) =>
      makeViolation({
        id: String(i),
        blockedUri: `https://cdn${i}.example.com/x.js`,
        effectiveDirective: 'script-src',
      }),
    );

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);
    expect(result['script-src']).toHaveLength(50);
    // Verify sorted
    const sorted = [...result['script-src']!].sort();
    expect(result['script-src']).toEqual(sorted);
  });

  it('handles violations across all directive types', () => {
    const directives = [
      'script-src', 'style-src', 'img-src', 'font-src',
      'connect-src', 'media-src', 'object-src', 'frame-src',
    ];
    const violations = directives.map((d, i) =>
      makeViolation({
        id: String(i),
        blockedUri: `https://cdn${i}.other.com/x`,
        effectiveDirective: d,
      }),
    );

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);
    for (const d of directives) {
      expect(result[d]).toBeDefined();
      expect(result[d]!.length).toBeGreaterThan(0);
    }
  });

  it('hash-only violation creates directive entry (covers generator line 51)', () => {
    // Violation where source expression is null ('none') but hash is present
    // This covers the branch where hash needs to create the directive set
    const violations = [
      makeViolation({
        blockedUri: "'unsafe-inline'",
        effectiveDirective: 'script-src',
        sample: 'alert(1)',
      }),
    ];
    const options: PolicyGeneratorOptions = { strictness: 'strict', includeHashes: true };
    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, options);

    expect(result['script-src']).toBeDefined();
    expect(result['script-src']!.some((s) => s.startsWith("'sha256-"))).toBe(true);
  });

  it('hash added to directive that has no URL source (covers line 50-51)', () => {
    // A violation where blockedUri is 'none' (null source) but has a hash
    // This exercises the branch where only the hash path creates the directive entry
    const violations = [
      makeViolation({
        blockedUri: "'none'",
        effectiveDirective: 'style-src',
        sample: 'body { color: red }',
      }),
    ];
    const options: PolicyGeneratorOptions = { strictness: 'strict', includeHashes: true };
    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, options);

    // Source was null (skipped), but hash should still be added
    expect(result['style-src']).toBeDefined();
    expect(result['style-src']!.every((s) => s.startsWith("'sha256-"))).toBe(true);
  });

  it('zero violations returns empty object', () => {
    const result = generatePolicyFromViolations([], TARGET_ORIGIN, defaultOptions);
    expect(result).toEqual({});
  });

  it('all violations skipped returns empty object', () => {
    const violations = [
      makeViolation({ blockedUri: "'none'", effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: 'not-a-url', effectiveDirective: 'style-src' }),
    ];
    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);
    expect(result).toEqual({});
  });

  it('permissive mode generates wildcards for 2-label hostnames in generator', () => {
    const violations = [
      makeViolation({ blockedUri: 'https://cdn-host.com/x.js', effectiveDirective: 'script-src' }),
    ];
    const options: PolicyGeneratorOptions = { strictness: 'permissive', includeHashes: false };
    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, options);
    expect(result['script-src']).toEqual(['*.cdn-host.com']);
  });
});

// ── Policy-optimizer edge cases ─────────────────────────────────────────

describe('policy-optimizer edge cases', () => {
  it('handles exactly 3 fetch directives at the threshold', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
    });
    expect(result).not.toBeNull();
    expect(result!.defaultSrc).toEqual(["'self'"]);
  });

  it('returns null for exactly 2 fetch directives (below threshold)', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    });
    expect(result).toBeNull();
  });

  it('handles mix of fetch and non-fetch with partial overlap', () => {
    const result = optimizePolicy({
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'img-src': ["'self'", 'https://images.example.com'],
      'form-action': ["'self'"],
      'base-uri': ["'none'"],
    });

    expect(result['default-src']).toEqual(["'self'"]);
    expect(result['script-src']).toEqual(['https://cdn.example.com']);
    expect(result['style-src']).toEqual(['https://fonts.googleapis.com']);
    expect(result['img-src']).toEqual(['https://images.example.com']);
    expect(result['form-action']).toEqual(["'self'"]);
    expect(result['base-uri']).toEqual(["'none'"]);
  });

  it('does not factor when only non-fetch directives present', () => {
    const result = optimizePolicy({
      'form-action': ["'self'"],
      'base-uri': ["'self'"],
    });

    expect('default-src' in result).toBe(false);
    expect(result['base-uri']).toEqual(["'self'"]);
    expect(result['form-action']).toEqual(["'self'"]);
  });

  it('handles duplicate sources across directives', () => {
    const result = optimizePolicy({
      'script-src': ["'self'", "'self'", 'https://cdn.example.com'],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
    });

    expect(result['default-src']).toEqual(["'self'"]);
    expect(result['script-src']).toEqual(['https://cdn.example.com']);
  });

  it('manifest-src participates in factoring (now a fetch directive)', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'manifest-src': ["'self'"],
    });
    expect(result).not.toBeNull();
    expect(result!.defaultSrc).toEqual(["'self'"]);
  });

  it('sorts output deterministically across runs', () => {
    const input = {
      'font-src': ['https://fonts.example.com'],
      'img-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    };
    const result1 = optimizePolicy(input);
    const result2 = optimizePolicy(input);
    expect(Object.keys(result1)).toEqual(Object.keys(result2));
    expect(result1).toEqual(result2);
  });
});

// ── Policy-formatter edge cases ─────────────────────────────────────────

describe('policy-formatter edge cases', () => {
  it('handles special characters in all format variants', () => {
    const directives = {
      'script-src': ["'self'", "'nonce-abc+/=123'"],
      'style-src': ["'sha256-aGVsbG8='"],
    };

    for (const format of ['header', 'meta', 'nginx', 'apache', 'cloudflare', 'json'] as const) {
      const result = formatPolicy(directives, format);
      expect(result.length).toBeGreaterThan(0);
    }
  });

  it('meta format HTML-escapes ampersands', () => {
    const directives = { 'default-src': ['https://example.com?a=1&b=2'] };
    const result = formatPolicy(directives, 'meta');
    expect(result).toContain('&amp;');
    expect(result).not.toContain('?a=1&b=2');
  });

  it('nginx escapes embedded quotes properly', () => {
    const directives = { 'default-src': ['"quoted"'] };
    const result = formatPolicy(directives, 'nginx');
    expect(result).toContain('\\"quoted\\"');
    expect(result).toMatch(/^add_header .* always;$/);
  });

  it('apache escapes embedded quotes properly', () => {
    const directives = { 'default-src': ['"quoted"'] };
    const result = formatPolicy(directives, 'apache');
    expect(result).toContain('\\"quoted\\"');
  });

  it('cloudflare escapes single quotes in policy values', () => {
    const directives = { 'default-src': ["'self'", "'unsafe-inline'"] };
    const result = formatPolicy(directives, 'cloudflare');
    expect(result).toContain("\\'self\\'");
    expect(result).toContain("\\'unsafe-inline\\'");
  });

  it('json format produces parseable JSON with all fields', () => {
    const directives = {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdn.example.com'],
    };
    const result = formatPolicy(directives, 'json', true);
    const parsed = JSON.parse(result);
    expect(parsed.directives).toEqual(directives);
    expect(parsed.isReportOnly).toBe(true);
    expect(typeof parsed.policyString).toBe('string');
  });

  it('header format with many directives', () => {
    const directives = {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'img-src': ["'self'", 'data:'],
      'font-src': ['https://fonts.gstatic.com'],
      'connect-src': ["'self'", 'https://api.example.com'],
    };
    const result = formatPolicy(directives, 'header');
    expect(result.split('; ').length).toBe(6);
  });

  it('meta strips report-uri but preserves other directives', () => {
    const directives = {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'report-uri': ['/csp-report'],
    };
    const result = formatPolicy(directives, 'meta');
    expect(result).toContain("default-src");
    expect(result).toContain("script-src");
    expect(result).not.toContain("report-uri");
  });

  it('directivesToString handles single source per directive', () => {
    const result = directivesToString({ 'default-src': ["'none'"] });
    expect(result).toBe("default-src 'none'");
  });

  it('all formats work with report-only flag', () => {
    const directives = { 'default-src': ["'self'"] };
    for (const format of ['header', 'meta', 'nginx', 'apache', 'cloudflare', 'json'] as const) {
      const result = formatPolicy(directives, format, true);
      if (format === 'json') {
        expect(JSON.parse(result).isReportOnly).toBe(true);
      } else {
        expect(result).toContain('Content-Security-Policy-Report-Only');
      }
    }
  });
});
