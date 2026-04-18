import { DIRECTIVE_FALLBACK_MAP } from './csp-constants.js';

/**
 * Parses a CSP header string into a directive map.
 *
 * Example: "default-src 'self'; script-src 'self' https://cdn.example.com"
 * → { "default-src": ["'self'"], "script-src": ["'self'", "https://cdn.example.com"] }
 */
export function parseCspHeader(headerValue: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};

  for (const part of headerValue.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;

    const tokens = trimmed.split(/\s+/);
    const name = tokens[0].toLowerCase();
    const sources = tokens.slice(1);

    // Skip report-uri and report-to — these are reporting directives, not policy
    if (name === 'report-uri' || name === 'report-to') continue;

    directives[name] = sources;
  }

  return directives;
}

/**
 * Unions multiple parsed CSP directive maps into one.
 * For directives present in multiple maps, all unique sources are combined.
 */
export function unionDirectives(
  ...maps: ReadonlyArray<Record<string, string[]>>
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  for (const map of maps) {
    for (const [directive, sources] of Object.entries(map)) {
      if (directive in result) {
        const existing = new Set(result[directive]);
        for (const s of sources) existing.add(s);
        result[directive] = [...existing];
      } else {
        result[directive] = [...sources];
      }
    }
  }

  return result;
}

/**
 * Merges additions into a base directive map.
 *
 * Respects CSP fallback hierarchy: if the base has `default-src` but not
 * `script-src`, and additions need `script-src`, creates an explicit
 * `script-src` inheriting `default-src` sources plus the new sources.
 */
export function mergeDirectives(
  base: Record<string, string[]>,
  additions: Record<string, string[]>,
): Record<string, string[]> {
  // Deep copy base
  const result: Record<string, string[]> = {};
  for (const [directive, sources] of Object.entries(base)) {
    result[directive] = [...sources];
  }

  for (const [directive, addedSources] of Object.entries(additions)) {
    if (directive in result) {
      // Directive exists in base — union sources
      const existing = new Set(result[directive]);
      for (const s of addedSources) existing.add(s);
      result[directive] = [...existing];
    } else {
      // Directive not in base — check if parent directive covers it
      const fallbackKey = directive as keyof typeof DIRECTIVE_FALLBACK_MAP;
      const parentDirective = DIRECTIVE_FALLBACK_MAP[fallbackKey];

      if (parentDirective && parentDirective in result) {
        // Create explicit directive inheriting parent sources + new sources
        const inherited = new Set(result[parentDirective]);
        for (const s of addedSources) inherited.add(s);
        result[directive] = [...inherited];
      } else {
        // No parent — add directive with just the new sources
        result[directive] = [...addedSources];
      }
    }
  }

  return result;
}
