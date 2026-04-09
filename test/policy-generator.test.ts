import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  insertViolation,
} from '../src/db/repository.js';
import {
  generatePolicyFromViolations,
  generatePolicy,
} from '../src/policy-generator.js';
import type { PolicyGeneratorOptions } from '../src/policy-generator.js';
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

// ── generatePolicyFromViolations (pure function) ─────────────────────────

describe('generatePolicyFromViolations', () => {
  const defaultOptions: PolicyGeneratorOptions = {
    strictness: 'strict',
    includeHashes: false,
  };

  it('generates directive map from violations', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://cdn.example.com/script.js', effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: 'https://fonts.googleapis.com/css', effectiveDirective: 'style-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['script-src']).toEqual(['https://cdn.example.com']);
    expect(result['style-src']).toEqual(['https://fonts.googleapis.com']);
  });

  it('deduplicates sources within a directive', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://cdn.example.com/a.js', effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: 'https://cdn.example.com/b.js', effectiveDirective: 'script-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['script-src']).toEqual(['https://cdn.example.com']);
  });

  it('returns sorted sources', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://z.example.com/x.js', effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: 'https://a.example.com/y.js', effectiveDirective: 'script-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['script-src']).toEqual(['https://a.example.com', 'https://z.example.com']);
  });

  it("maps same-origin URLs to 'self'", () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://example.com/style.css', effectiveDirective: 'style-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['style-src']).toEqual(["'self'"]);
  });

  it('skips violations with null source expressions', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: "'none'", effectiveDirective: 'script-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['script-src']).toBeUndefined();
  });

  it('skips violations with unknown directives', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://cdn.example.com/x.js', effectiveDirective: 'unknown-directive' as any }),
      makeViolation({ blockedUri: 'https://cdn.example.com/y.js', effectiveDirective: 'script-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['unknown-directive']).toBeUndefined();
    expect(result['script-src']).toEqual(['https://cdn.example.com']);
  });

  it('handles special keyword blocked URIs', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: "'unsafe-inline'", effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: "'unsafe-eval'", effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: 'data:', effectiveDirective: 'img-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(result['script-src']).toEqual(["'unsafe-eval'", "'unsafe-inline'"]);
    expect(result['img-src']).toEqual(['data:']);
  });

  it('uses wildcard domains in moderate mode', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://cdn.example.com/script.js', effectiveDirective: 'script-src' }),
    ];
    const options: PolicyGeneratorOptions = { strictness: 'moderate', includeHashes: false };

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, options);

    expect(result['script-src']).toEqual(['*.example.com']);
  });

  it('includes hashes when includeHashes is true', () => {
    const violations: Violation[] = [
      makeViolation({
        blockedUri: "'unsafe-inline'",
        effectiveDirective: 'script-src',
        sample: 'alert("xss")',
      }),
    ];
    const options: PolicyGeneratorOptions = { strictness: 'strict', includeHashes: true };

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, options);

    expect(result['script-src']).toHaveLength(2);
    expect(result['script-src']!.some((s) => s.startsWith("'sha256-"))).toBe(true);
    expect(result['script-src']).toContain("'unsafe-inline'");
  });

  it('does not include hashes when includeHashes is false', () => {
    const violations: Violation[] = [
      makeViolation({
        blockedUri: "'unsafe-inline'",
        effectiveDirective: 'script-src',
        sample: 'alert("xss")',
      }),
    ];
    const options: PolicyGeneratorOptions = { strictness: 'strict', includeHashes: false };

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, options);

    expect(result['script-src']).toEqual(["'unsafe-inline'"]);
  });

  it('returns empty object for empty violations array', () => {
    const result = generatePolicyFromViolations([], TARGET_ORIGIN, defaultOptions);
    expect(result).toEqual({});
  });

  it('groups multiple directives correctly', () => {
    const violations: Violation[] = [
      makeViolation({ blockedUri: 'https://cdn.example.com/a.js', effectiveDirective: 'script-src' }),
      makeViolation({ blockedUri: 'https://fonts.gstatic.com/font.woff2', effectiveDirective: 'font-src' }),
      makeViolation({ blockedUri: 'https://img.example.com/pic.png', effectiveDirective: 'img-src' }),
      makeViolation({ blockedUri: 'https://example.com/style.css', effectiveDirective: 'style-src' }),
    ];

    const result = generatePolicyFromViolations(violations, TARGET_ORIGIN, defaultOptions);

    expect(Object.keys(result).sort()).toEqual(['font-src', 'img-src', 'script-src', 'style-src']);
    expect(result['style-src']).toEqual(["'self'"]);
  });
});

// ── generatePolicy (DB-backed) ──────────────────────────────────────────

describe('generatePolicy', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const session = createSession(db, { targetUrl: 'https://example.com' });
    sessionId = session.id;
  });

  it('generates policy from DB violations', () => {
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/page',
      blockedUri: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'report_uri',
    });

    const result = generatePolicy(db, sessionId, {
      strictness: 'strict',
      includeHashes: false,
    });

    expect(result['script-src']).toEqual(['https://cdn.example.com']);
  });

  it('throws for non-existent session', () => {
    expect(() =>
      generatePolicy(db, 'non-existent', {
        strictness: 'strict',
        includeHashes: false,
      }),
    ).toThrow('Session not found');
  });

  it('returns empty object when session has no violations', () => {
    const result = generatePolicy(db, sessionId, {
      strictness: 'strict',
      includeHashes: false,
    });

    expect(result).toEqual({});
  });

  it('generates policy with multiple violations and hashes', () => {
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: "'unsafe-inline'",
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      sample: 'console.log("test")',
      capturedVia: 'dom_event',
    });
    insertViolation(db, {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/style.css',
      violatedDirective: 'style-src',
      effectiveDirective: 'style-src',
      capturedVia: 'report_uri',
    });

    const result = generatePolicy(db, sessionId, {
      strictness: 'strict',
      includeHashes: true,
    });

    expect(result['script-src']).toBeDefined();
    expect(result['script-src']!.some((s) => s.startsWith("'sha256-"))).toBe(true);
    expect(result['script-src']).toContain("'unsafe-inline'");
    expect(result['style-src']).toEqual(['https://cdn.example.com']);
  });
});
