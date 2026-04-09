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
      'img-src': ['https://c.com'],
      'script-src': ['https://a.com'],
      'style-src': ['https://b.com'],
    });
    expect('default-src' in result).toBe(false);
  });

  it('does not factor when only 2 fetch directives present', () => {
    const result = optimizePolicy({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    });

    expect(result).toEqual({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    });
    expect('default-src' in result).toBe(false);
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
    expect(result).toEqual({});
  });

  it('handles single directive', () => {
    const result = optimizePolicy({
      'script-src': ["'self'"],
    });
    expect(result).toEqual({
      'script-src': ["'self'"],
    });
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
