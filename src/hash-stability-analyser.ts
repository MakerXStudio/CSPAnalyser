import type { InlineHash, HashStabilityWarning, HashStabilityResult } from './types.js';

/** Content size (bytes) above which an inline hash is flagged as likely build-specific. */
const LARGE_CONTENT_THRESHOLD = 1024;

/** Hash count per directive above which the policy becomes impractical to maintain. */
const HIGH_HASH_COUNT_THRESHOLD = 15;

/**
 * Patterns in inline content that strongly suggest build-specific or
 * bundler-generated code that will change on every deployment.
 */
const BUILD_SPECIFIC_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /webpackJsonp|__webpack_|webpack_require/i, label: 'webpack runtime' },
  { pattern: /\._expo\/static\/|__EXPO/i, label: 'Expo bundler' },
  { pattern: /\b[a-f0-9]{16,}\b/, label: 'embedded bundle hash' },
  { pattern: /__NEXT_DATA__|__next|_next\/static/i, label: 'Next.js runtime' },
  { pattern: /__NUXT__|__nuxt/i, label: 'Nuxt.js runtime' },
  { pattern: /\bchunk[.\-_][a-f0-9]+/i, label: 'chunk reference' },
  { pattern: /\bbundle[.\-_][a-f0-9]+/i, label: 'bundle reference' },
];

/**
 * Analyses inline hashes from a session to detect patterns that suggest
 * the hash-based policy is impractical or volatile.
 */
export function analyseHashStability(inlineHashes: InlineHash[]): HashStabilityResult {
  const warnings: HashStabilityWarning[] = [];

  // Group hashes by directive
  const byDirective = new Map<string, InlineHash[]>();
  for (const ih of inlineHashes) {
    const existing = byDirective.get(ih.directive);
    if (existing) {
      existing.push(ih);
    } else {
      byDirective.set(ih.directive, [ih]);
    }
  }

  let hasCriticalWarning = false;

  for (const [directive, hashes] of byDirective) {
    // High hash count
    if (hashes.length > HIGH_HASH_COUNT_THRESHOLD) {
      warnings.push({
        directive,
        hashCount: hashes.length,
        reason: `${hashes.length} unique hashes — too many to maintain manually. Consider 'unsafe-inline' or refactoring to external files.`,
        severity: 'warning',
      });
      if (hashes.length > HIGH_HASH_COUNT_THRESHOLD * 2) {
        hasCriticalWarning = true;
      }
    }

    // Large content sizes suggest bundled code that changes per build
    const largeHashes = hashes.filter((h) => h.contentLength > LARGE_CONTENT_THRESHOLD);
    if (largeHashes.length > 0) {
      warnings.push({
        directive,
        hashCount: largeHashes.length,
        reason: `${largeHashes.length} hash(es) over ${LARGE_CONTENT_THRESHOLD} bytes — large inline content is likely build-specific and will change on each deployment.`,
        severity: 'warning',
      });
      if (largeHashes.length >= 3) {
        hasCriticalWarning = true;
      }
    }

    // Content inspection for build-specific patterns
    const hashesWithContent = hashes.filter((h) => h.content != null);
    for (const hash of hashesWithContent) {
      for (const { pattern, label } of BUILD_SPECIFIC_PATTERNS) {
        if (pattern.test(hash.content ?? '')) {
          warnings.push({
            directive,
            hashCount: 1,
            reason: `Hash ${hash.hash.slice(0, 12)}... contains ${label} references — this content changes on every build.`,
            severity: 'warning',
          });
          hasCriticalWarning = true;
          break; // One match per hash is enough
        }
      }
    }
  }

  return {
    warnings,
    isHashBasedPolicyPractical: !hasCriticalWarning,
  };
}
