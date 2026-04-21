import type { InlineHash, StaticSiteSignals } from './types.js';

/**
 * Patterns in inline content that indicate server-side rendering (SSR) frameworks.
 * Their presence suggests the site has a server that could generate nonces.
 */
const SSR_INDICATORS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /__NEXT_DATA__|_next\/static/i, label: 'Next.js SSR' },
  { pattern: /__NUXT__|window\.__NUXT__/i, label: 'Nuxt.js SSR' },
  { pattern: /<!--\s*astro/i, label: 'Astro SSR' },
  { pattern: /\bnonce=["'][a-zA-Z0-9+/=]+["']/i, label: 'existing nonce attribute' },
];

/**
 * Patterns that suggest a static site generator or client-side framework
 * where no server is available to inject nonces per-request.
 */
const STATIC_INDICATORS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\._expo\/static\/|__EXPO_ENV|expo-router/i, label: 'Expo static export' },
  { pattern: /webpackJsonp|__webpack_/i, label: 'webpack static bundle' },
  { pattern: /__GATSBY/i, label: 'Gatsby static site' },
  { pattern: /vite|@vite\/client/i, label: 'Vite static build' },
];

/**
 * Threshold for style-src-attr hashes above which the site almost certainly
 * uses CSS-in-JS with dynamic inline styles (a static site pattern).
 */
const DYNAMIC_STYLE_HASH_THRESHOLD = 50;

/**
 * Detects whether a site is likely static (no server-side rendering)
 * based on inline hash patterns and policy directives.
 *
 * This helps adjust recommendations: static sites cannot use nonces
 * because there is no server to generate a unique value per request.
 */
export function detectStaticSite(
  inlineHashes: InlineHash[],
  directives: Record<string, string[]>,
): StaticSiteSignals {
  const reasons: string[] = [];
  let ssrScore = 0;
  let staticScore = 0;

  // Check inline content for SSR vs static indicators
  const hashesWithContent = inlineHashes.filter((h) => h.content != null);
  for (const hash of hashesWithContent) {
    const content = hash.content ?? '';
    for (const { pattern, label } of SSR_INDICATORS) {
      if (pattern.test(content)) {
        ssrScore += 2;
        reasons.push(`SSR indicator found: ${label}`);
        break;
      }
    }
    for (const { pattern, label } of STATIC_INDICATORS) {
      if (pattern.test(content)) {
        staticScore += 2;
        reasons.push(`Static site indicator found: ${label}`);
        break;
      }
    }
  }

  // High style-src-attr hash count strongly suggests CSS-in-JS on a static SPA
  const styleAttrHashes = inlineHashes.filter((h) => h.directive === 'style-src-attr');
  if (styleAttrHashes.length > DYNAMIC_STYLE_HASH_THRESHOLD) {
    staticScore += 3;
    reasons.push(
      `${styleAttrHashes.length} style-src-attr hashes — CSS-in-JS generating dynamic inline styles (typical of static SPAs)`,
    );
  }

  // unsafe-eval in script-src often comes from bundler/framework runtime (static SPA pattern)
  const scriptSources = [
    ...(directives['script-src'] ?? []),
    ...(directives['script-src-elem'] ?? []),
  ];
  if (scriptSources.includes("'unsafe-eval'")) {
    staticScore += 1;
    reasons.push("'unsafe-eval' in script-src — common in static SPA builds (bundler runtime)");
  }

  // Many script-src-elem hashes suggest inline scripts from a static HTML shell
  const scriptElemHashes = inlineHashes.filter((h) => h.directive === 'script-src-elem');
  if (scriptElemHashes.length > 5) {
    staticScore += 1;
    reasons.push(
      `${scriptElemHashes.length} script-src-elem hashes — multiple inline scripts in static HTML`,
    );
  }

  // meta tag export format can't use nonces at all
  const hasMetaExport = directives['meta-export'] !== undefined;
  if (hasMetaExport) {
    staticScore += 3;
    reasons.push('Policy uses meta tag format — nonces cannot be set in meta tags');
  }

  const isLikelyStatic = staticScore > ssrScore && staticScore >= 2;

  let confidence: StaticSiteSignals['confidence'];
  if (staticScore >= 5 && ssrScore === 0) {
    confidence = 'high';
  } else if (staticScore >= 3) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    isLikelyStatic,
    confidence,
    reasons,
    noncesFeasible: !isLikelyStatic,
  };
}
