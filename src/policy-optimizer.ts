import { FETCH_DIRECTIVES } from './utils/csp-constants.js';
import { extractOrigin } from './utils/url-utils.js';

/**
 * Determines whether factoring common sources into default-src is beneficial.
 *
 * Only fetch directives (those that fall back to default-src) are considered.
 * Factoring is recommended when at least 1 common source exists across at least 3 fetch directives.
 */
export function shouldUseDefaultSrc(
  directives: Record<string, string[]>,
): { defaultSrc: string[]; remaining: Record<string, string[]> } | null {
  const fetchDirectiveNames = FETCH_DIRECTIVES as readonly string[];

  // Collect fetch directives present in input
  const presentFetchDirectives = Object.entries(directives).filter(([name]) =>
    fetchDirectiveNames.includes(name),
  );

  if (presentFetchDirectives.length < 3) {
    return null;
  }

  // Find intersection of sources across all present fetch directives
  const [first, ...rest] = presentFetchDirectives;
  const intersection = first[1].filter((source) =>
    rest.every(([, sources]) => sources.includes(source)),
  );

  if (intersection.length === 0) {
    return null;
  }

  // Build remaining directives with intersection sources removed
  const remaining: Record<string, string[]> = {};
  for (const [name, sources] of Object.entries(directives)) {
    if (fetchDirectiveNames.includes(name)) {
      const filtered = sources.filter((s) => !intersection.includes(s));
      if (filtered.length > 0) {
        remaining[name] = filtered;
      }
      // Drop directive entirely if empty (it falls back to default-src)
    } else {
      // Non-fetch directives are preserved as-is
      remaining[name] = sources;
    }
  }

  return { defaultSrc: intersection, remaining };
}

export interface OptimizePolicyOptions {
  /** Replace 'unsafe-inline' with nonce placeholders in script/style directives */
  useNonces?: boolean;
  /** Add 'strict-dynamic' alongside nonces in script-src directives */
  useStrictDynamic?: boolean;
  /** Remove 'unsafe-inline' from directives that already contain hash sources (sha256/sha384/sha512) */
  useHashes?: boolean;
}

/**
 * Optimizes a directive map by factoring common sources into default-src,
 * deduplicating sources, and sorting output deterministically.
 *
 * @param targetOrigin if provided, enables deduplication of 'self' vs explicit
 *   matching origin (e.g. 'self' + 'https://example.com' -> 'self')
 * @param options additional optimization options (nonce generation, strict-dynamic)
 */
export function optimizePolicy(
  directives: Record<string, string[]>,
  targetOrigin?: string,
  options?: OptimizePolicyOptions,
): Record<string, string[]> {
  let result: Record<string, string[]>;

  const factoring = shouldUseDefaultSrc(directives);
  if (factoring) {
    result = { 'default-src': factoring.defaultSrc, ...factoring.remaining };
  } else {
    // Deep copy to avoid mutating input
    result = {};
    for (const [name, sources] of Object.entries(directives)) {
      result[name] = [...sources];
    }
  }

  // Deduplicate and sort sources within each directive
  for (const name of Object.keys(result)) {
    result[name] = deduplicateSources([...new Set(result[name])], targetOrigin);
    result[name].sort();
  }

  // Add security defaults for critical directives that have no violations.
  // A missing directive means nothing was blocked — but it also means
  // nothing is restricted. These defaults lock down common attack vectors.
  if (!('default-src' in result)) {
    result['default-src'] = ["'self'"];
  }
  if (!('object-src' in result)) {
    result['object-src'] = ["'none'"];
  }
  if (!('base-uri' in result)) {
    result['base-uri'] = ["'self'"];
  }
  if (!('form-action' in result)) {
    result['form-action'] = ["'self'"];
  }

  // Remove 'unsafe-inline' from directives that already have hash-based sources.
  // Per CSP3 spec, when a hash source is present, 'unsafe-inline' is ignored by
  // conformant browsers — removing it makes the policy explicit and avoids confusion.
  if (options?.useHashes) {
    const hashDirectives = [
      'script-src', 'script-src-elem', 'script-src-attr',
      'style-src', 'style-src-elem', 'style-src-attr',
    ];
    for (const directive of hashDirectives) {
      if (directive in result) {
        const sources = result[directive];
        const hasHash = sources.some((s) =>
          s.startsWith("'sha256-") || s.startsWith("'sha384-") || s.startsWith("'sha512-"),
        );
        if (hasHash && sources.includes("'unsafe-inline'")) {
          result[directive] = sources.filter((s) => s !== "'unsafe-inline'");
        }
      }
    }
    // Also check default-src
    if ('default-src' in result) {
      const sources = result['default-src'];
      const hasHash = sources.some((s) =>
        s.startsWith("'sha256-") || s.startsWith("'sha384-") || s.startsWith("'sha512-"),
      );
      if (hasHash && sources.includes("'unsafe-inline'")) {
        result['default-src'] = sources.filter((s) => s !== "'unsafe-inline'");
      }
    }
  }

  // Replace 'unsafe-inline' with nonce placeholder in script/style directives
  if (options?.useNonces) {
    const nonceDirectives = [
      'script-src', 'script-src-elem', 'script-src-attr',
      'style-src', 'style-src-elem', 'style-src-attr',
    ];
    for (const directive of nonceDirectives) {
      if (directive in result) {
        const sources = result[directive];
        const hasUnsafeInline = sources.includes("'unsafe-inline'");
        if (hasUnsafeInline) {
          result[directive] = sources.filter((s) => s !== "'unsafe-inline'");
          result[directive].push("'nonce-{{CSP_NONCE}}'");
          // Add strict-dynamic for script-src directives to propagate trust
          if (directive.startsWith('script-src') && options.useStrictDynamic) {
            result[directive].push("'strict-dynamic'");
          }
        }
      }
    }
    // Also check default-src (unsafe-inline may be inherited)
    if ('default-src' in result) {
      const sources = result['default-src'];
      if (sources.includes("'unsafe-inline'")) {
        result['default-src'] = sources.filter((s) => s !== "'unsafe-inline'");
        result['default-src'].push("'nonce-{{CSP_NONCE}}'");
      }
    }
  }

  // Sort directives: default-src first, then alphabetical
  const sorted: Record<string, string[]> = {};
  const keys = Object.keys(result).sort((a, b) => {
    if (a === 'default-src') return -1;
    if (b === 'default-src') return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    sorted[key] = result[key];
  }

  return sorted;
}

/**
 * If 'self' is present and an explicit origin matching the target exists, keep only 'self'.
 * When targetOrigin is provided, resolves 'self' to the actual origin and removes redundant
 * explicit entries.
 */
function deduplicateSources(sources: string[], targetOrigin?: string): string[] {
  const unique = [...new Set(sources)];

  if (!targetOrigin || !unique.includes("'self'")) {
    return unique;
  }

  // Resolve what 'self' means: the origin of the target URL
  let selfOrigin: string;
  try {
    selfOrigin = extractOrigin(targetOrigin);
  } catch {
    return unique;
  }

  // Remove explicit origins that match 'self'
  return unique.filter((s) => s === "'self'" || s !== selfOrigin);
}
