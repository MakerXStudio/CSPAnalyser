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

/**
 * Optimizes a directive map by factoring common sources into default-src,
 * deduplicating sources, and sorting output deterministically.
 *
 * @param targetOrigin — if provided, enables deduplication of 'self' vs explicit
 *   matching origin (e.g. 'self' + 'https://example.com' → 'self')
 */
export function optimizePolicy(
  directives: Record<string, string[]>,
  targetOrigin?: string,
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
