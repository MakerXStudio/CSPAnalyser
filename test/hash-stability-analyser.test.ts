import { describe, it, expect } from 'vitest';
import { analyseHashStability } from '../src/hash-stability-analyser.js';
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

describe('analyseHashStability', () => {
  it('returns no warnings for a small number of hashes', () => {
    const hashes = Array.from({ length: 5 }, (_, i) =>
      makeHash({ id: String(i), hash: `hash${i}==`, contentLength: 50 }),
    );
    const result = analyseHashStability(hashes);
    expect(result.warnings).toEqual([]);
    expect(result.isHashBasedPolicyPractical).toBe(true);
  });

  it('warns when hash count exceeds threshold', () => {
    const hashes = Array.from({ length: 20 }, (_, i) =>
      makeHash({ id: String(i), hash: `hash${i}==` }),
    );
    const result = analyseHashStability(hashes);
    const highCountWarning = result.warnings.find((w) =>
      w.reason.includes('unique hashes'),
    );
    expect(highCountWarning).toBeDefined();
    expect(highCountWarning!.hashCount).toBe(20);
    expect(highCountWarning!.severity).toBe('warning');
  });

  it('marks policy as impractical for very high hash counts', () => {
    const hashes = Array.from({ length: 50 }, (_, i) =>
      makeHash({ id: String(i), hash: `hash${i}==` }),
    );
    const result = analyseHashStability(hashes);
    expect(result.isHashBasedPolicyPractical).toBe(false);
  });

  it('warns about large inline content', () => {
    const hashes = [
      makeHash({ hash: 'large1==', contentLength: 2000 }),
      makeHash({ hash: 'large2==', contentLength: 5000 }),
    ];
    const result = analyseHashStability(hashes);
    const sizeWarning = result.warnings.find((w) =>
      w.reason.includes('bytes'),
    );
    expect(sizeWarning).toBeDefined();
    expect(sizeWarning!.hashCount).toBe(2);
  });

  it('marks policy as impractical with 3+ large content hashes', () => {
    const hashes = Array.from({ length: 3 }, (_, i) =>
      makeHash({ id: String(i), hash: `large${i}==`, contentLength: 5000 }),
    );
    const result = analyseHashStability(hashes);
    expect(result.isHashBasedPolicyPractical).toBe(false);
  });

  it('detects webpack build patterns in content', () => {
    const hashes = [
      makeHash({
        content: 'window.__webpack_require__ = function(moduleId) { /* ... */ }',
        contentLength: 100,
      }),
    ];
    const result = analyseHashStability(hashes);
    const patternWarning = result.warnings.find((w) =>
      w.reason.includes('webpack runtime'),
    );
    expect(patternWarning).toBeDefined();
    expect(result.isHashBasedPolicyPractical).toBe(false);
  });

  it('detects Expo build patterns in content', () => {
    const hashes = [
      makeHash({
        content: 'window.__EXPO_ENV = { API_URL: "https://api.example.com" }',
        contentLength: 80,
      }),
    ];
    const result = analyseHashStability(hashes);
    const patternWarning = result.warnings.find((w) =>
      w.reason.includes('Expo bundler'),
    );
    expect(patternWarning).toBeDefined();
  });

  it('detects Next.js build patterns in content', () => {
    const hashes = [
      makeHash({
        content: '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
        contentLength: 100,
      }),
    ];
    const result = analyseHashStability(hashes);
    const patternWarning = result.warnings.find((w) =>
      w.reason.includes('Next.js runtime'),
    );
    expect(patternWarning).toBeDefined();
  });

  it('detects embedded bundle hash patterns', () => {
    const hashes = [
      makeHash({
        content: 'import("./chunk-6ba611cfc63e2583a2177e6681b8ee57.js")',
        contentLength: 60,
      }),
    ];
    const result = analyseHashStability(hashes);
    const patternWarning = result.warnings.find((w) =>
      w.reason.includes('embedded bundle hash'),
    );
    expect(patternWarning).toBeDefined();
  });

  it('groups warnings by directive', () => {
    const hashes = [
      ...Array.from({ length: 20 }, (_, i) =>
        makeHash({ id: `s${i}`, hash: `script${i}==`, directive: 'script-src-elem' }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        makeHash({ id: `t${i}`, hash: `style${i}==`, directive: 'style-src-attr' }),
      ),
    ];
    const result = analyseHashStability(hashes);
    const directives = new Set(result.warnings.map((w) => w.directive));
    expect(directives.has('script-src-elem')).toBe(true);
    expect(directives.has('style-src-attr')).toBe(true);
  });

  it('skips content inspection for hashes without content', () => {
    const hashes = [makeHash({ content: null, contentLength: 50 })];
    const result = analyseHashStability(hashes);
    // No build-pattern warnings since content is null
    const patternWarnings = result.warnings.filter((w) =>
      w.reason.includes('contains'),
    );
    expect(patternWarnings).toEqual([]);
  });

  it('returns empty warnings for empty input', () => {
    const result = analyseHashStability([]);
    expect(result.warnings).toEqual([]);
    expect(result.isHashBasedPolicyPractical).toBe(true);
  });
});
