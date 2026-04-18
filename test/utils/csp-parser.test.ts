import { describe, it, expect } from 'vitest';
import { parseCspHeader, unionDirectives, mergeDirectives } from '../../src/utils/csp-parser.js';

// ── parseCspHeader ─────────────────────────────────────────────────────

describe('parseCspHeader', () => {
  it('parses a simple CSP header', () => {
    const result = parseCspHeader("default-src 'self'; script-src 'self' https://cdn.example.com");
    expect(result).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://cdn.example.com'],
    });
  });

  it('handles empty string', () => {
    expect(parseCspHeader('')).toEqual({});
  });

  it('handles trailing semicolons', () => {
    const result = parseCspHeader("default-src 'self';");
    expect(result).toEqual({ 'default-src': ["'self'"] });
  });

  it('handles extra whitespace', () => {
    const result = parseCspHeader("  default-src   'self'  ;  script-src   'none'  ");
    expect(result).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'none'"],
    });
  });

  it('lowercases directive names', () => {
    const result = parseCspHeader("Default-Src 'self'");
    expect(result).toEqual({ 'default-src': ["'self'"] });
  });

  it('strips report-uri and report-to directives', () => {
    const result = parseCspHeader(
      "default-src 'self'; report-uri /csp-report; report-to csp-endpoint",
    );
    expect(result).toEqual({ 'default-src': ["'self'"] });
  });

  it('handles directive with no sources', () => {
    const result = parseCspHeader('upgrade-insecure-requests');
    expect(result).toEqual({ 'upgrade-insecure-requests': [] });
  });

  it('parses complex real-world CSP', () => {
    const result = parseCspHeader(
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.example.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.example.com; object-src 'none'",
    );
    expect(result['default-src']).toEqual(["'self'"]);
    expect(result['script-src']).toEqual(["'self'", "'unsafe-inline'", 'https://cdn.example.com']);
    expect(result['img-src']).toEqual(["'self'", 'data:', 'https:']);
    expect(result['object-src']).toEqual(["'none'"]);
  });
});

// ── unionDirectives ─────────────────────────────────────────────────────

describe('unionDirectives', () => {
  it('unions sources from multiple maps', () => {
    const a = { 'script-src': ["'self'", 'https://a.com'] };
    const b = { 'script-src': ["'self'", 'https://b.com'] };
    const result = unionDirectives(a, b);
    expect(result['script-src']).toEqual(expect.arrayContaining(["'self'", 'https://a.com', 'https://b.com']));
    expect(result['script-src']).toHaveLength(3);
  });

  it('adds directives from both maps', () => {
    const a = { 'script-src': ["'self'"] };
    const b = { 'style-src': ["'self'"] };
    const result = unionDirectives(a, b);
    expect(result).toEqual({
      'script-src': ["'self'"],
      'style-src': ["'self'"],
    });
  });

  it('handles empty maps', () => {
    expect(unionDirectives({}, {})).toEqual({});
  });

  it('handles single map', () => {
    const a = { 'default-src': ["'self'"] };
    expect(unionDirectives(a)).toEqual(a);
  });
});

// ── mergeDirectives ─────────────────────────────────────────────────────

describe('mergeDirectives', () => {
  it('adds new sources to existing directives', () => {
    const base = { 'script-src': ["'self'"] };
    const additions = { 'script-src': ['https://cdn.example.com'] };
    const result = mergeDirectives(base, additions);
    expect(result['script-src']).toEqual(expect.arrayContaining(["'self'", 'https://cdn.example.com']));
  });

  it('adds new directives not in base', () => {
    const base = { 'default-src': ["'self'"] };
    const additions = { 'font-src': ['https://fonts.gstatic.com'] };
    const result = mergeDirectives(base, additions);
    // font-src inherits from default-src + new source
    expect(result['font-src']).toEqual(expect.arrayContaining(["'self'", 'https://fonts.gstatic.com']));
    // base is preserved
    expect(result['default-src']).toEqual(["'self'"]);
  });

  it('does not mutate the base', () => {
    const base = { 'script-src': ["'self'"] };
    const additions = { 'script-src': ['https://cdn.example.com'] };
    mergeDirectives(base, additions);
    expect(base['script-src']).toEqual(["'self'"]);
  });

  it('adds directive without parent fallback', () => {
    const base = {};
    const additions = { 'form-action': ["'self'"] };
    const result = mergeDirectives(base, additions);
    expect(result['form-action']).toEqual(["'self'"]);
  });

  it('inherits from parent when sub-directive is missing', () => {
    const base = { 'script-src': ["'self'", 'https://existing.com'] };
    const additions = { 'script-src-elem': ['https://new-scripts.com'] };
    const result = mergeDirectives(base, additions);
    // script-src-elem falls back to script-src
    expect(result['script-src-elem']).toEqual(
      expect.arrayContaining(["'self'", 'https://existing.com', 'https://new-scripts.com']),
    );
  });

  it('deduplicates when merging', () => {
    const base = { 'script-src': ["'self'", 'https://cdn.example.com'] };
    const additions = { 'script-src': ["'self'", 'https://cdn.example.com', 'https://new.com'] };
    const result = mergeDirectives(base, additions);
    expect(result['script-src']).toHaveLength(3);
    expect(result['script-src']).toEqual(
      expect.arrayContaining(["'self'", 'https://cdn.example.com', 'https://new.com']),
    );
  });
});
