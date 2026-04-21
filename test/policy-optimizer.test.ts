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

// ── Hash-based unsafe-inline removal ────────────────────────────────────

describe('hash-based unsafe-inline removal', () => {
  it('removes unsafe-inline from script-src when hash sources exist', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'", "'sha256-abc123'"] },
      undefined,
      { useHashes: true },
    );
    expect(result['script-src']).toContain("'sha256-abc123'");
    expect(result['script-src']).toContain("'self'");
    expect(result['script-src']).not.toContain("'unsafe-inline'");
  });

  it('removes unsafe-inline from style-src when hash sources exist', () => {
    const result = optimizePolicy(
      { 'style-src': ["'self'", "'unsafe-inline'", "'sha256-xyz789'"] },
      undefined,
      { useHashes: true },
    );
    expect(result['style-src']).toContain("'sha256-xyz789'");
    expect(result['style-src']).not.toContain("'unsafe-inline'");
  });

  it('keeps unsafe-inline when no hash sources exist', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useHashes: true },
    );
    expect(result['script-src']).toContain("'unsafe-inline'");
  });

  it('does not modify when useHashes is false', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'", "'sha256-abc123'"] },
      undefined,
      { useHashes: false },
    );
    expect(result['script-src']).toContain("'unsafe-inline'");
    expect(result['script-src']).toContain("'sha256-abc123'");
  });

  it('removes unsafe-inline from default-src when hash sources exist', () => {
    const result = optimizePolicy(
      { 'default-src': ["'self'", "'unsafe-inline'", "'sha256-def456'"] },
      undefined,
      { useHashes: true },
    );
    expect(result['default-src']).toContain("'sha256-def456'");
    expect(result['default-src']).not.toContain("'unsafe-inline'");
  });

  it('handles sha384 and sha512 hash sources', () => {
    const result = optimizePolicy(
      { 'script-src': ["'unsafe-inline'", "'sha384-longhash'", "'sha512-longerhash'"] },
      undefined,
      { useHashes: true },
    );
    expect(result['script-src']).not.toContain("'unsafe-inline'");
    expect(result['script-src']).toContain("'sha384-longhash'");
    expect(result['script-src']).toContain("'sha512-longerhash'");
  });

  it('handles script-src-elem and style-src-attr sub-directives', () => {
    const result = optimizePolicy(
      {
        'script-src-elem': ["'unsafe-inline'", "'sha256-abc'"],
        'style-src-attr': ["'unsafe-inline'", "'sha256-def'"],
      },
      undefined,
      { useHashes: true },
    );
    expect(result['script-src-elem']).not.toContain("'unsafe-inline'");
    expect(result['script-src-elem']).toContain("'sha256-abc'");
    expect(result['style-src-attr']).not.toContain("'unsafe-inline'");
    expect(result['style-src-attr']).toContain("'sha256-def'");
  });

  it('does not affect directives without unsafe-inline', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'sha256-abc123'"] },
      undefined,
      { useHashes: true },
    );
    expect(result['script-src']).toEqual(["'self'", "'sha256-abc123'"]);
  });
});

// ── 'unsafe-hashes' required for -attr directives with hashes ──────────

describe("auto-add 'unsafe-hashes' to attr directives with hashes", () => {
  it("adds 'unsafe-hashes' to style-src-attr when a hash is present", () => {
    const result = optimizePolicy({
      'style-src-attr': ["'sha256-abc'"],
    });
    expect(result['style-src-attr']).toContain("'unsafe-hashes'");
    expect(result['style-src-attr']).toContain("'sha256-abc'");
  });

  it("adds 'unsafe-hashes' to script-src-attr when a hash is present", () => {
    const result = optimizePolicy({
      'script-src-attr': ["'sha256-xyz'"],
    });
    expect(result['script-src-attr']).toContain("'unsafe-hashes'");
  });

  it("supports sha384 and sha512", () => {
    const result = optimizePolicy({
      'style-src-attr': ["'sha384-longhash'"],
      'script-src-attr': ["'sha512-longerhash'"],
    });
    expect(result['style-src-attr']).toContain("'unsafe-hashes'");
    expect(result['script-src-attr']).toContain("'unsafe-hashes'");
  });

  it("does not add 'unsafe-hashes' when no hashes are present", () => {
    const result = optimizePolicy({
      'style-src-attr': ["'unsafe-inline'"],
    });
    expect(result['style-src-attr']).not.toContain("'unsafe-hashes'");
  });

  it("does not add 'unsafe-hashes' to non-attr hash directives", () => {
    const result = optimizePolicy({
      'script-src-elem': ["'self'", "'sha256-abc'"],
      'style-src-elem': ["'self'", "'sha256-def'"],
    });
    expect(result['script-src-elem']).not.toContain("'unsafe-hashes'");
    expect(result['style-src-elem']).not.toContain("'unsafe-hashes'");
  });

  it("does not duplicate 'unsafe-hashes' when already present", () => {
    const result = optimizePolicy({
      'style-src-attr': ["'unsafe-hashes'", "'sha256-abc'"],
    });
    const count = result['style-src-attr'].filter((s) => s === "'unsafe-hashes'").length;
    expect(count).toBe(1);
  });
});

// ── Strip 'unsafe-eval' ─────────────────────────────────────────────────

describe('stripUnsafeEval', () => {
  it('removes unsafe-eval from script-src', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-eval'"] },
      undefined,
      { stripUnsafeEval: true },
    );
    expect(result['script-src']).not.toContain("'unsafe-eval'");
    expect(result['script-src']).toContain("'self'");
  });

  it('removes unsafe-eval from default-src', () => {
    const result = optimizePolicy(
      { 'default-src': ["'self'", "'unsafe-eval'"] },
      undefined,
      { stripUnsafeEval: true },
    );
    expect(result['default-src']).not.toContain("'unsafe-eval'");
  });

  it('removes unsafe-eval from script-src-elem and script-src-attr', () => {
    const result = optimizePolicy(
      {
        'script-src-elem': ["'unsafe-eval'", "'self'"],
        'script-src-attr': ["'unsafe-eval'", "'self'"],
      },
      undefined,
      { stripUnsafeEval: true },
    );
    expect(result['script-src-elem']).not.toContain("'unsafe-eval'");
    expect(result['script-src-attr']).not.toContain("'unsafe-eval'");
  });

  it('drops directives entirely when stripUnsafeEval removes the only source', () => {
    const result = optimizePolicy(
      {
        'script-src-elem': ["'unsafe-eval'"],
      },
      undefined,
      { stripUnsafeEval: true },
    );
    expect(result['script-src-elem']).toBeUndefined();
  });

  it('does not modify when stripUnsafeEval is false', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-eval'"] },
      undefined,
      { stripUnsafeEval: false },
    );
    expect(result['script-src']).toContain("'unsafe-eval'");
  });

  it('does not affect other unsafe keywords', () => {
    const result = optimizePolicy(
      { 'script-src': ["'unsafe-inline'", "'unsafe-eval'"] },
      undefined,
      { stripUnsafeEval: true },
    );
    expect(result['script-src']).not.toContain("'unsafe-eval'");
    expect(result['script-src']).toContain("'unsafe-inline'");
  });

  it('does not touch style-src directives (eval is script-only)', () => {
    const result = optimizePolicy(
      { 'style-src': ["'self'", "'unsafe-eval'"] },
      undefined,
      { stripUnsafeEval: true },
    );
    // unsafe-eval is only meaningful on script-src, but if captured on style-src
    // for some reason we leave it — we target script directives explicitly
    expect(result['style-src']).toContain("'unsafe-eval'");
  });
});

// ── Strip 'unsafe-inline' (audit strict mode) ──────────────────────────

describe('stripUnsafeInline', () => {
  it('removes unsafe-inline from script-src unconditionally', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { stripUnsafeInline: true },
    );
    expect(result['script-src']).not.toContain("'unsafe-inline'");
    expect(result['script-src']).toContain("'self'");
  });

  it('removes unsafe-inline from style-src unconditionally', () => {
    const result = optimizePolicy(
      { 'style-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { stripUnsafeInline: true },
    );
    expect(result['style-src']).not.toContain("'unsafe-inline'");
  });

  it('removes unsafe-inline from default-src', () => {
    const result = optimizePolicy(
      { 'default-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { stripUnsafeInline: true },
    );
    expect(result['default-src']).not.toContain("'unsafe-inline'");
  });

  it('removes unsafe-inline from sub-directives', () => {
    const result = optimizePolicy(
      {
        'script-src-elem': ["'unsafe-inline'", "'sha256-abc'"],
        'script-src-attr': ["'unsafe-inline'", "'self'"],
        'style-src-elem': ["'unsafe-inline'", "'self'"],
        'style-src-attr': ["'unsafe-inline'", "'sha256-def'"],
      },
      undefined,
      { stripUnsafeInline: true },
    );
    expect(result['script-src-elem']).not.toContain("'unsafe-inline'");
    expect(result['script-src-attr']).not.toContain("'unsafe-inline'");
    expect(result['style-src-elem']).not.toContain("'unsafe-inline'");
    expect(result['style-src-attr']).not.toContain("'unsafe-inline'");
  });

  it('drops directives entirely when stripUnsafeInline removes the only source', () => {
    const result = optimizePolicy(
      {
        'script-src-attr': ["'unsafe-inline'"],
      },
      undefined,
      { stripUnsafeInline: true },
    );
    expect(result['script-src-attr']).toBeUndefined();
  });

  it('does not remove unsafe-inline when option is false', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { stripUnsafeInline: false },
    );
    expect(result['script-src']).toContain("'unsafe-inline'");
  });

  it('removes unsafe-inline even without hashes present', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { stripUnsafeInline: true },
    );
    // Unlike useHashes which only removes when hashes exist,
    // stripUnsafeInline is unconditional
    expect(result['script-src']).not.toContain("'unsafe-inline'");
  });

  it('does not affect unsafe-eval', () => {
    const result = optimizePolicy(
      { 'script-src': ["'unsafe-inline'", "'unsafe-eval'"] },
      undefined,
      { stripUnsafeInline: true },
    );
    expect(result['script-src']).not.toContain("'unsafe-inline'");
    expect(result['script-src']).toContain("'unsafe-eval'");
  });
});

// ── collapseHashThreshold ─────────────────────────────────────────────

describe('collapseHashThreshold', () => {
  it('does not collapse hashes below the threshold', () => {
    const hashes = Array.from({ length: 5 }, (_, i) => `'sha256-hash${i}='`);
    const result = optimizePolicy(
      { 'style-src-attr': [...hashes, "'unsafe-hashes'"] },
      undefined,
      { collapseHashThreshold: 10 },
    );
    // All hashes preserved
    for (const h of hashes) {
      expect(result['style-src-attr']).toContain(h);
    }
    expect(result['style-src-attr']).not.toContain("'unsafe-inline'");
  });

  it('collapses hashes above the threshold to unsafe-inline', () => {
    const hashes = Array.from({ length: 20 }, (_, i) => `'sha256-hash${i}='`);
    const result = optimizePolicy(
      { 'style-src-attr': [...hashes, "'unsafe-hashes'", "'self'"] },
      undefined,
      { collapseHashThreshold: 10 },
    );
    expect(result['style-src-attr']).toContain("'unsafe-inline'");
    expect(result['style-src-attr']).toContain("'self'");
    // All hashes removed
    for (const h of hashes) {
      expect(result['style-src-attr']).not.toContain(h);
    }
    // unsafe-hashes also removed
    expect(result['style-src-attr']).not.toContain("'unsafe-hashes'");
  });

  it('collapses script-src-elem hashes above the threshold', () => {
    const hashes = Array.from({ length: 15 }, (_, i) => `'sha256-script${i}='`);
    const result = optimizePolicy(
      { 'script-src-elem': ["'self'", ...hashes] },
      undefined,
      { collapseHashThreshold: 10 },
    );
    expect(result['script-src-elem']).toContain("'unsafe-inline'");
    expect(result['script-src-elem']).toContain("'self'");
    for (const h of hashes) {
      expect(result['script-src-elem']).not.toContain(h);
    }
  });

  it('does not collapse when threshold is 0 (disabled)', () => {
    const hashes = Array.from({ length: 50 }, (_, i) => `'sha256-hash${i}='`);
    const result = optimizePolicy(
      { 'style-src-attr': hashes },
      undefined,
      { collapseHashThreshold: 0 },
    );
    // All hashes preserved, plus 'unsafe-hashes' added by the attr-hash correctness logic
    expect(result['style-src-attr']).toHaveLength(51);
    expect(result['style-src-attr']).toContain("'unsafe-hashes'");
  });

  it('does not add duplicate unsafe-inline if already present', () => {
    const hashes = Array.from({ length: 20 }, (_, i) => `'sha256-hash${i}='`);
    const result = optimizePolicy(
      { 'style-src-attr': ["'unsafe-inline'", ...hashes] },
      undefined,
      { collapseHashThreshold: 10 },
    );
    const unsafeInlineCount = result['style-src-attr'].filter(
      (s) => s === "'unsafe-inline'",
    ).length;
    expect(unsafeInlineCount).toBe(1);
  });

  it('does not affect directives that are not script/style', () => {
    const hashes = Array.from({ length: 20 }, (_, i) => `'sha256-hash${i}='`);
    const result = optimizePolicy(
      { 'img-src': ["'self'", ...hashes] },
      undefined,
      { collapseHashThreshold: 10 },
    );
    // img-src is not eligible for collapse
    for (const h of hashes) {
      expect(result['img-src']).toContain(h);
    }
  });
});

// ── staticSiteMode ────────────────────────────────────────────────────

describe('staticSiteMode', () => {
  it('skips nonce replacement when static site mode is enabled', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-inline'"] },
      undefined,
      { useNonces: true, staticSiteMode: true },
    );
    // Nonces should not be injected
    expect(result['script-src']).toContain("'unsafe-inline'");
    expect(result['script-src']).not.toContain("'nonce-{{CSP_NONCE}}'");
  });

  it('still applies other optimizations in static site mode', () => {
    const result = optimizePolicy(
      { 'script-src': ["'self'", "'unsafe-eval'"] },
      undefined,
      { staticSiteMode: true, stripUnsafeEval: true },
    );
    expect(result['script-src']).not.toContain("'unsafe-eval'");
  });
});
