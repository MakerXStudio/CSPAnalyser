import { describe, it, expect } from 'vitest';
import { detectStaticSite } from '../src/static-site-detector.js';
import type { InlineHash } from '../src/types.js';

function makeHash(overrides: Partial<InlineHash> = {}): InlineHash {
  return {
    id: '1',
    sessionId: 'session-1',
    pageId: null,
    directive: 'script-src-elem',
    hash: 'testhash==',
    contentLength: 50,
    content: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('detectStaticSite', () => {
  it('detects Expo static export', () => {
    const hashes = [
      makeHash({
        content: 'window.__EXPO_ENV = { API_URL: "https://api.example.com" }',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.isLikelyStatic).toBe(true);
    expect(result.noncesFeasible).toBe(false);
    expect(result.reasons.some((r) => r.includes('Expo'))).toBe(true);
  });

  it('detects high style-src-attr count as static SPA', () => {
    const hashes = Array.from({ length: 100 }, (_, i) =>
      makeHash({
        id: String(i),
        hash: `style${i}==`,
        directive: 'style-src-attr',
        content: `color: rgb(${i}, 0, 0)`,
      }),
    );
    const result = detectStaticSite(hashes, { 'style-src-attr': ["'unsafe-inline'"] });
    expect(result.isLikelyStatic).toBe(true);
    expect(result.reasons.some((r) => r.includes('style-src-attr'))).toBe(true);
  });

  it('detects unsafe-eval as static SPA signal', () => {
    const result = detectStaticSite([], {
      'script-src': ["'self'", "'unsafe-eval'"],
    });
    // unsafe-eval alone gives 1 point — not enough for isLikelyStatic
    expect(result.reasons.some((r) => r.includes("'unsafe-eval'"))).toBe(true);
  });

  it('detects Next.js SSR as non-static', () => {
    const hashes = [
      makeHash({
        content: '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    // SSR indicator should counteract static signals
    expect(result.reasons.some((r) => r.includes('Next.js SSR'))).toBe(true);
  });

  it('detects Nuxt SSR as non-static', () => {
    const hashes = [
      makeHash({
        content: 'window.__NUXT__ = { data: {} }',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.reasons.some((r) => r.includes('Nuxt.js SSR'))).toBe(true);
  });

  it('detects existing nonce attribute as SSR signal', () => {
    const hashes = [
      makeHash({
        content: '<script nonce="abc123def456">console.log("hi")</script>',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.reasons.some((r) => r.includes('nonce'))).toBe(true);
    expect(result.noncesFeasible).toBe(true);
  });

  it('reports high confidence for strong static signals with no SSR', () => {
    const styleHashes = Array.from({ length: 100 }, (_, i) =>
      makeHash({
        id: `s${i}`,
        hash: `style${i}==`,
        directive: 'style-src-attr',
      }),
    );
    const scriptHashes = [
      makeHash({
        id: 'expo',
        hash: 'expo==',
        directive: 'script-src-elem',
        content: 'window.__EXPO_ENV = { API_URL: "https://api.example.com" }',
      }),
    ];
    const result = detectStaticSite([...styleHashes, ...scriptHashes], {
      'script-src': ["'self'", "'unsafe-eval'"],
    });
    expect(result.isLikelyStatic).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('reports low confidence with minimal signals', () => {
    const result = detectStaticSite([], { 'script-src': ["'self'"] });
    expect(result.isLikelyStatic).toBe(false);
    expect(result.confidence).toBe('low');
  });

  it('handles empty hashes and directives', () => {
    const result = detectStaticSite([], {});
    expect(result.isLikelyStatic).toBe(false);
    expect(result.noncesFeasible).toBe(true);
    expect(result.warnings).toBeUndefined;
  });

  it('multiple script-src-elem hashes are a static signal', () => {
    const hashes = Array.from({ length: 10 }, (_, i) =>
      makeHash({
        id: String(i),
        hash: `script${i}==`,
        directive: 'script-src-elem',
      }),
    );
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.reasons.some((r) => r.includes('script-src-elem'))).toBe(true);
  });

  it('webpack bundle is a static signal', () => {
    const hashes = [
      makeHash({
        content: 'var __webpack_require__ = function(moduleId) {}',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.isLikelyStatic).toBe(true);
    expect(result.reasons.some((r) => r.includes('webpack'))).toBe(true);
  });

  it('Gatsby static site is detected', () => {
    const hashes = [
      makeHash({
        content: 'window.__GATSBY = { id: "app" }',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.isLikelyStatic).toBe(true);
    expect(result.reasons.some((r) => r.includes('Gatsby'))).toBe(true);
  });

  it('Vite static build is detected', () => {
    const hashes = [
      makeHash({
        content: 'import { createApp } from "@vite/client"',
      }),
    ];
    const result = detectStaticSite(hashes, { 'script-src': ["'self'"] });
    expect(result.isLikelyStatic).toBe(true);
  });
});
