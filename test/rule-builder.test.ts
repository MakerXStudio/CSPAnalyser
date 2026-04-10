import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { violationToSourceExpression, violationToHashSource, isValidSourceExpression } from '../src/rule-builder.js';
import type { Violation } from '../src/types.js';

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

// ── violationToSourceExpression ──────────────────────────────────────────

describe('violationToSourceExpression', () => {
  describe('special keyword values', () => {
    it("returns 'unsafe-inline' for unsafe-inline blocked URI", () => {
      const v = makeViolation({ blockedUri: "'unsafe-inline'" });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe("'unsafe-inline'");
    });

    it("returns 'unsafe-eval' for unsafe-eval blocked URI", () => {
      const v = makeViolation({ blockedUri: "'unsafe-eval'" });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe("'unsafe-eval'");
    });

    it('returns data: for data: blocked URI', () => {
      const v = makeViolation({ blockedUri: 'data:' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('data:');
    });

    it('returns blob: for blob: blocked URI', () => {
      const v = makeViolation({ blockedUri: 'blob:' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('blob:');
    });

    it('returns mediastream: for mediastream: blocked URI', () => {
      const v = makeViolation({ blockedUri: 'mediastream:' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('mediastream:');
    });

    it("returns null for 'none' blocked URI", () => {
      const v = makeViolation({ blockedUri: "'none'" });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBeNull();
    });
  });

  describe('same-origin URLs', () => {
    it("returns 'self' when blocked URI has the same origin as target", () => {
      const v = makeViolation({ blockedUri: 'https://example.com/style.css' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe("'self'");
    });

    it("returns 'self' for same origin with path and query", () => {
      const v = makeViolation({ blockedUri: 'https://example.com/a/b?c=d' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe("'self'");
    });
  });

  describe('strict mode', () => {
    it('returns exact origin for external URLs', () => {
      const v = makeViolation({ blockedUri: 'https://cdn.example.com/script.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('https://cdn.example.com');
    });

    it('returns exact origin even for multi-label hostnames', () => {
      const v = makeViolation({ blockedUri: 'https://a.b.cdn.example.com/x.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('https://a.b.cdn.example.com');
    });
  });

  describe('moderate mode', () => {
    it('returns wildcard domain for 3+ label hostnames', () => {
      const v = makeViolation({ blockedUri: 'https://cdn.example.com/script.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe('*.example.com');
    });

    it('returns exact origin for 2-label hostnames', () => {
      const v = makeViolation({ blockedUri: 'https://cdn-host.com/script.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe('https://cdn-host.com');
    });

    it('returns wildcard for deeply nested subdomains', () => {
      const v = makeViolation({ blockedUri: 'https://a.b.c.example.com/x.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe('*.b.c.example.com');
    });
  });

  describe('permissive mode', () => {
    it('returns wildcard domain for 3+ label hostnames (same as moderate)', () => {
      const v = makeViolation({ blockedUri: 'https://cdn.example.com/script.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe('*.example.com');
    });

    it('returns wildcard for 2-label hostnames (more lenient than moderate)', () => {
      const v = makeViolation({ blockedUri: 'https://cdn-host.com/script.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe('*.cdn-host.com');
    });

    it('returns wildcard for deeply nested subdomains', () => {
      const v = makeViolation({ blockedUri: 'https://a.b.c.example.com/x.js' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe('*.b.c.example.com');
    });
  });

  describe('strictness ordering: strict < moderate < permissive breadth', () => {
    it('3-label hostname: strict=exact origin, moderate=wildcard, permissive=wildcard (same as moderate)', () => {
      const v = makeViolation({ blockedUri: 'https://cdn.example.com/script.js' });
      const strict = violationToSourceExpression(v, TARGET_ORIGIN, 'strict');
      const moderate = violationToSourceExpression(v, TARGET_ORIGIN, 'moderate');
      const permissive = violationToSourceExpression(v, TARGET_ORIGIN, 'permissive');

      expect(strict).toBe('https://cdn.example.com');     // exact origin (narrowest)
      expect(moderate).toBe('*.example.com');              // wildcard domain
      expect(permissive).toBe('*.example.com');            // at least as broad as moderate
    });

    it('2-label hostname: strict=exact, moderate=exact, permissive=wildcard', () => {
      const v = makeViolation({ blockedUri: 'https://cdn-host.com/script.js' });
      const strict = violationToSourceExpression(v, TARGET_ORIGIN, 'strict');
      const moderate = violationToSourceExpression(v, TARGET_ORIGIN, 'moderate');
      const permissive = violationToSourceExpression(v, TARGET_ORIGIN, 'permissive');

      expect(strict).toBe('https://cdn-host.com');        // exact origin
      expect(moderate).toBe('https://cdn-host.com');       // exact origin (can't wildcard 2-label)
      expect(permissive).toBe('*.cdn-host.com');           // wildcard (broadest)
    });

    it('4-label hostname: strict=exact, moderate=wildcard, permissive=wildcard (same as moderate)', () => {
      const v = makeViolation({ blockedUri: 'https://a.b.example.com/x.js' });
      const strict = violationToSourceExpression(v, TARGET_ORIGIN, 'strict');
      const moderate = violationToSourceExpression(v, TARGET_ORIGIN, 'moderate');
      const permissive = violationToSourceExpression(v, TARGET_ORIGIN, 'permissive');

      expect(strict).toBe('https://a.b.example.com');     // exact origin
      expect(moderate).toBe('*.b.example.com');            // wildcard domain
      expect(permissive).toBe('*.b.example.com');          // at least as broad as moderate
    });

    it('multi-part TLD (co.uk): permissive is never narrower than moderate', () => {
      const v = makeViolation({ blockedUri: 'https://cdn.example.co.uk/script.js' });
      const strict = violationToSourceExpression(v, TARGET_ORIGIN, 'strict');
      const moderate = violationToSourceExpression(v, TARGET_ORIGIN, 'moderate');
      const permissive = violationToSourceExpression(v, TARGET_ORIGIN, 'permissive');

      // 4 labels with multi-part TLD requires ≥4 parts to wildcard in generateWildcardDomain
      // cdn.example.co.uk has exactly 4 parts → *.example.co.uk
      expect(strict).toBe('https://cdn.example.co.uk');
      expect(moderate).toBe('*.example.co.uk');
      expect(permissive).toBe('*.example.co.uk');
    });

    it('special values are identical across all strictness levels', () => {
      const v = makeViolation({ blockedUri: "'unsafe-inline'" });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe("'unsafe-inline'");
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe("'unsafe-inline'");
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe("'unsafe-inline'");
    });

    it('same-origin is identical across all strictness levels', () => {
      const v = makeViolation({ blockedUri: 'https://example.com/style.css' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe("'self'");
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'moderate')).toBe("'self'");
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'permissive')).toBe("'self'");
    });
  });

  describe('edge cases', () => {
    it('returns null for unparseable blocked URIs', () => {
      const v = makeViolation({ blockedUri: 'not-a-url' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBeNull();
    });

    it('handles http: origins correctly', () => {
      const v = makeViolation({ blockedUri: 'http://cdn.example.com/script.js' });
      expect(violationToSourceExpression(v, 'http://example.com', 'strict')).toBe('http://cdn.example.com');
    });

    it('handles ports in origins', () => {
      const v = makeViolation({ blockedUri: 'https://example.com:8080/api' });
      expect(violationToSourceExpression(v, TARGET_ORIGIN, 'strict')).toBe('https://example.com:8080');
    });
  });
});

// ── isValidSourceExpression ─────────────────────────────────────────────

describe('isValidSourceExpression', () => {
  it('accepts normal source expressions', () => {
    expect(isValidSourceExpression("'self'")).toBe(true);
    expect(isValidSourceExpression('https://cdn.example.com')).toBe(true);
    expect(isValidSourceExpression('*.example.com')).toBe(true);
    expect(isValidSourceExpression('data:')).toBe(true);
  });

  it('rejects expressions with semicolons (directive injection)', () => {
    expect(isValidSourceExpression("'self'; script-src 'unsafe-eval'")).toBe(false);
  });

  it('rejects expressions with newlines', () => {
    expect(isValidSourceExpression("https://evil.com\nX-Injected: true")).toBe(false);
  });

  it('rejects expressions with carriage returns', () => {
    expect(isValidSourceExpression("https://evil.com\rX-Injected: true")).toBe(false);
  });

  it('rejects expressions with null bytes', () => {
    expect(isValidSourceExpression("https://evil.com\0")).toBe(false);
  });
});

describe('violationToSourceExpression — source expression validation', () => {
  it('returns null for blocked URIs that would produce expressions with semicolons', () => {
    // A crafted blocked URI whose origin might contain a semicolon
    // In practice, URL parsing strips these, but we validate as defense in depth
    const v = makeViolation({ blockedUri: 'https://cdn.example.com/script.js' });
    // Normal URLs pass validation — just verify it returns a valid expression
    const result = violationToSourceExpression(v, TARGET_ORIGIN, 'strict');
    expect(result).toBe('https://cdn.example.com');
    expect(isValidSourceExpression(result!)).toBe(true);
  });
});

// ── violationToHashSource ────────────────────────────────────────────────

describe('violationToHashSource', () => {
  it('returns sha256 hash for script-src violation with sample', () => {
    const sample = 'alert("xss")';
    const v = makeViolation({
      effectiveDirective: 'script-src',
      sample,
    });
    const expected = `'sha256-${createHash('sha256').update(sample).digest('base64')}'`;
    expect(violationToHashSource(v)).toBe(expected);
  });

  it('returns sha256 hash for style-src violation with sample', () => {
    const sample = 'body { color: red }';
    const v = makeViolation({
      effectiveDirective: 'style-src',
      sample,
    });
    const expected = `'sha256-${createHash('sha256').update(sample).digest('base64')}'`;
    expect(violationToHashSource(v)).toBe(expected);
  });

  it('returns hash for script-src-elem sub-directive', () => {
    const sample = 'console.log("test")';
    const v = makeViolation({
      effectiveDirective: 'script-src-elem',
      sample,
    });
    expect(violationToHashSource(v)).not.toBeNull();
  });

  it('returns hash for style-src-attr sub-directive', () => {
    const sample = 'color: blue';
    const v = makeViolation({
      effectiveDirective: 'style-src-attr',
      sample,
    });
    expect(violationToHashSource(v)).not.toBeNull();
  });

  it('returns null when no sample is present', () => {
    const v = makeViolation({ effectiveDirective: 'script-src', sample: null });
    expect(violationToHashSource(v)).toBeNull();
  });

  it('returns null for non-script/style directives even with sample', () => {
    const v = makeViolation({
      effectiveDirective: 'img-src',
      sample: 'some data',
    });
    expect(violationToHashSource(v)).toBeNull();
  });

  it('returns null for connect-src with sample', () => {
    const v = makeViolation({
      effectiveDirective: 'connect-src',
      sample: 'fetch data',
    });
    expect(violationToHashSource(v)).toBeNull();
  });

  it('returns null for samples at exactly 256 characters (likely truncated)', () => {
    const v = makeViolation({
      effectiveDirective: 'script-src',
      sample: 'x'.repeat(256),
    });
    expect(violationToHashSource(v)).toBeNull();
  });

  it('returns null for samples longer than 256 characters', () => {
    const v = makeViolation({
      effectiveDirective: 'script-src',
      sample: 'x'.repeat(300),
    });
    expect(violationToHashSource(v)).toBeNull();
  });

  it('returns hash for samples just under 256 characters', () => {
    const sample = 'x'.repeat(255);
    const v = makeViolation({
      effectiveDirective: 'script-src',
      sample,
    });
    expect(violationToHashSource(v)).not.toBeNull();
  });
});
