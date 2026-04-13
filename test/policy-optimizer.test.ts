import { describe, it, expect } from 'vitest';
import { optimizePolicy, shouldUseDefaultSrc } from '../src/policy-optimizer.js';

// ── shouldUseDefaultSrc ─────────────────────────────────────────────────

describe('shouldUseDefaultSrc', () => {
  it('returns null when fewer than 3 fetch directives are present', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://cdn.example.com'],
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no common source across fetch directives', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ['https://a.com'],
      'style-src': ['https://b.com'],
      'img-src': ['https://c.com'],
    });
    expect(result).toBeNull();
  });

  it('factors common sources when at least 3 fetch directives share them', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://cdn.example.com'],
      'img-src': ["'self'", 'https://cdn.example.com'],
    });

    expect(result).not.toBeNull();
    expect(result!.defaultSrc).toEqual(["'self'", 'https://cdn.example.com']);
    // All fetch directives become empty after removing intersection → remaining has none of them
    expect(result!.remaining).toEqual({});
  });

  it('factors partial intersection, keeps remainders', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'", 'https://cdn.example.com', 'https://scripts.example.com'],
      'style-src': ["'self'", 'https://cdn.example.com', 'https://styles.example.com'],
      'img-src': ["'self'", 'https://cdn.example.com', 'https://images.example.com'],
    });

    expect(result).not.toBeNull();
    expect(result!.defaultSrc).toEqual(["'self'", 'https://cdn.example.com']);
    expect(result!.remaining).toEqual({
      'script-src': ['https://scripts.example.com'],
      'style-src': ['https://styles.example.com'],
      'img-src': ['https://images.example.com'],
    });
  });

  it('excludes non-fetch directives from factoring', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'form-action': ["'self'"],
      'base-uri': ["'self'"],
    });

    expect(result).not.toBeNull();
    expect(result!.defaultSrc).toEqual(["'self'"]);
    // Non-fetch directives preserved in remaining
    expect(result!.remaining['form-action']).toEqual(["'self'"]);
    expect(result!.remaining['base-uri']).toEqual(["'self'"]);
  });

  it('returns null for a single directive', () => {
    const result = shouldUseDefaultSrc({
      'script-src': ["'self'"],
    });
    expect(result).toBeNull();
  });
});

// ── optimizePolicy ──────────────────────────────────────────────────────

describe('optimizePolicy', () => {
  it('factors all shared sources into default-src when all directives match', () => {
    const result = optimizePolicy({
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://cdn.example.com'],
      'img-src': ["'self'", 'https://cdn.example.com'],
    });

    expect(result).toEqual({
      'default-src': ["'self'", 'https://cdn.example.com'],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
    });
  });

  it('factors partial overlap and keeps remainders', () => {
    const result = optimizePolicy({
      'script-src': ["'self'", 'https://scripts.example.com'],
      'style-src': ["'self'", 'https://styles.example.com'],
      'img-src': ["'self'"],
    });

    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'script-src': ['https://scripts.example.com'],
      'style-src': ['https://styles.example.com'],
    });
    // img-src dropped — it only had 'self' which was factored into default-src
    expect('img-src' in result).toBe(false);
  });

  it('does not factor when there is no overlap', () => {
    const result = optimizePolicy({
      'script-src': ['https://a.com'],
      'style-src': ['https://b.com'],
      'img-src': ['https://c.com'],
    });

    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'img-src': ['https://c.com'],
      'object-src': ["'none'"],
      'script-src': ['https://a.com'],
      'style-src': ['https://b.com'],
    });
  });

  it('does not factor when only 2 fetch directives present', () => {
    const result = optimizePolicy({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    });

    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    });
  });

  it('preserves non-fetch directives unchanged', () => {
    const result = optimizePolicy({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'"],
      'manifest-src': ["'self'"],
      'form-action': ["'self'"],
      'base-uri': ["'none'"],
    });

    // All four fetch directives (script, style, img, manifest) share 'self' → factored
    expect(result['default-src']).toEqual(["'self'"]);
    // Non-fetch directives preserved as-is
    expect(result['form-action']).toEqual(["'self'"]);
    expect(result['base-uri']).toEqual(["'none'"]);
    // manifest-src is now a fetch directive, so it's absorbed into default-src
    expect('manifest-src' in result).toBe(false);
  });

  it('deduplicates sources within a directive', () => {
    const result = optimizePolicy({
      'script-src': ["'self'", 'https://cdn.example.com', "'self'", 'https://cdn.example.com'],
    });

    expect(result['script-src']).toEqual(["'self'", 'https://cdn.example.com']);
  });

  it('sorts directives with default-src first, then alphabetical', () => {
    const result = optimizePolicy({
      'style-src': ["'self'", 'https://cdn.example.com'],
      'script-src': ["'self'", 'https://cdn.example.com'],
      'img-src': ["'self'", 'https://cdn.example.com'],
    });

    const keys = Object.keys(result);
    expect(keys[0]).toBe('default-src');
  });

  it('sorts sources alphabetically within each directive', () => {
    const result = optimizePolicy({
      'script-src': ['https://z.com', 'https://a.com', "'self'"],
    });

    expect(result['script-src']).toEqual(["'self'", 'https://a.com', 'https://z.com']);
  });

  it('handles empty input', () => {
    const result = optimizePolicy({});
    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
    });
  });

  it('handles single directive', () => {
    const result = optimizePolicy({
      'script-src': ["'self'"],
    });
    expect(result).toEqual({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'script-src': ["'self'"],
    });
  });

  it('deduplicates self and explicit matching origin when targetOrigin provided', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", 'https://example.com'] },
      'https://example.com',
    );
    expect(result['script-src']).toEqual(["'self'"]);
  });

  it('keeps both self and non-matching origin', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", 'https://other.com'] },
      'https://example.com',
    );
    expect(result['script-src']).toEqual(["'self'", 'https://other.com']);
  });

  it('does not dedup self when no targetOrigin provided', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", 'https://example.com'] },
    );
    expect(result['script-src']).toEqual(["'self'", 'https://example.com']);
  });

  it('does not mutate the input', () => {
    const input = {
      'script-src': ["'self'", 'https://cdn.example.com'],
      'style-src': ["'self'", 'https://cdn.example.com'],
      'img-src': ["'self'", 'https://cdn.example.com'],
    };
    const inputCopy = JSON.parse(JSON.stringify(input));
    optimizePolicy(input);
    expect(input).toEqual(inputCopy);
  });
});

// ── Nonce generation ──────────────────────────────────────────────────

describe('nonce generation', () => {
  it('replaces unsafe-inline with nonce placeholder in script-src', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: true },
    );
    expect(result['script-src']).toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['script-src']).not.toContain("'unsafe-inline'");
  });

  it('replaces unsafe-inline with nonce placeholder in style-src', () => {
    const result = optimizePolicy(
      { 'style-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: true },
    );
    expect(result['style-src']).toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['style-src']).not.toContain("'unsafe-inline'");
  });

  it('adds strict-dynamic alongside nonce in script-src when enabled', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: true, useStrictDynamic: true },
    );
    expect(result['script-src']).toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['script-src']).toContain("'strict-dynamic'");
  });

  it('does not add strict-dynamic to style-src', () => {
    const result = optimizePolicy(
      { 'style-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: true, useStrictDynamic: true },
    );
    expect(result['style-src']).toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['style-src']).not.toContain("'strict-dynamic'");
  });

  it('replaces unsafe-inline in default-src when nonces enabled', () => {
    const result = optimizePolicy(
      { 'default-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: true },
    );
    expect(result['default-src']).toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['default-src']).not.toContain("'unsafe-inline'");
  });

  it('does not modify directives without unsafe-inline', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", 'https://cdn.example.com'] },
      undefined,
      { useNonces: true },
    );
    expect(result['script-src']).not.toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['script-src']).toContain("'self'");
  });

  it('does not modify when useNonces is false', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: false },
    );
    expect(result['script-src']).toContain("'unsafe-inline'");
    expect(result['script-src']).not.toContain("'nonce-{{CSP_NONCE}}'");
  });

  it('handles script-src-elem and style-src-attr', () => {
    const result = optimizePolicy(
      {
        'script-src-elem': ["'unsafe-inline'"],
        'style-src-attr': ["'unsafe-inline'"],
      },
      undefined,
      { useNonces: true },
    );
    expect(result['script-src-elem']).toContain("'nonce-{{CSP_NONCE}}'");
    expect(result['style-src-attr']).toContain("'nonce-{{CSP_NONCE}}'");
  });
});
