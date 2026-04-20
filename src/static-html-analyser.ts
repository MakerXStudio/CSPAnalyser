import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

/**
 * Accumulated hashes discovered across one or more HTML files, grouped by the
 * CSP directive they apply to. Each set contains fully-formatted source
 * expressions (e.g. `'sha256-...'`) ready to be written into a policy.
 */
export interface StaticHashResult {
  scriptElem: Set<string>;
  styleElem: Set<string>;
  styleAttr: Set<string>;
  scriptAttr: Set<string>;
}

/**
 * Options for building a policy from scanned hashes. Extra directives are
 * merged into the generated policy to cover sources that cannot be discovered
 * by static scanning (e.g. API endpoints, CDN origins, runtime-injected
 * inline content from a prior crawl export).
 */
export interface BuildPolicyOptions {
  /** Extra sources keyed by directive name (from --extra / --merge-json flags) */
  extraDirectives?: ReadonlyMap<string, readonly string[]>;
}

// ── File walking ─────────────────────────────────────────────────────────

/**
 * Recursively walks a directory and returns absolute paths of all `.html`
 * files. Accepts a file path too (returns it if it ends with `.html`).
 */
export async function walkHtmlFiles(root: string): Promise<string[]> {
  const st = statSync(root);
  if (st.isFile()) {
    return root.endsWith('.html') ? [root] : [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkHtmlFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(full);
    }
  }
  return files;
}

// ── Hash extraction ──────────────────────────────────────────────────────

function sha256b64(content: string): string {
  return createHash('sha256').update(content).digest('base64');
}

/**
 * Decodes the subset of HTML entities that commonly appear inside attribute
 * values, matching what a browser resolves before evaluating CSP.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Extracts CSP-relevant inline content hashes from a single HTML document:
 *
 * - `<script>` blocks without a `src` attribute → script-src-elem
 * - `<style>` blocks → style-src-elem
 * - `style="..."` attributes (including empty string) → style-src-attr
 * - `on*="..."` event handler attributes (including empty string) → script-src-attr
 *
 * Empty-string attributes are included: browsers evaluate CSP against them
 * and require the empty-string hash (47DEQpj8...) to be present.
 */
export function extractHashesFromHtml(html: string): StaticHashResult {
  const scriptElem = new Set<string>();
  const styleElem = new Set<string>();
  const styleAttr = new Set<string>();
  const scriptAttr = new Set<string>();

  // <script ...>content</script>, excluding those with a src attribute.
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(scriptRe)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const content = m[2];
    if (content.trim().length === 0) continue;
    scriptElem.add(`'sha256-${sha256b64(content)}'`);
  }

  // <style>content</style>
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const m of html.matchAll(styleRe)) {
    const content = m[1];
    if (content.trim().length === 0) continue;
    styleElem.add(`'sha256-${sha256b64(content)}'`);
  }

  // style="..." attributes — include empty strings. The backreference \2
  // requires the closing quote to match the opening, which avoids false
  // matches across unrelated adjacent attributes.
  const styleAttrRe = /\sstyle\s*=\s*(["'])((?:(?!\1).)*)\1/gi;
  for (const m of html.matchAll(styleAttrRe)) {
    styleAttr.add(`'sha256-${sha256b64(decodeHtmlEntities(m[2]))}'`);
  }

  // on*="..." event handler attributes — include empty strings.
  const onAttrRe = /\son[a-z]+\s*=\s*(["'])((?:(?!\1).)*)\1/gi;
  for (const m of html.matchAll(onAttrRe)) {
    scriptAttr.add(`'sha256-${sha256b64(decodeHtmlEntities(m[2]))}'`);
  }

  return { scriptElem, styleElem, styleAttr, scriptAttr };
}

/**
 * Scans every HTML file under the given paths and accumulates their inline
 * content hashes into one result.
 */
export async function scanHtmlFiles(
  paths: readonly string[],
): Promise<{ result: StaticHashResult; files: string[] }> {
  const allFiles: string[] = [];
  for (const p of paths) {
    allFiles.push(...(await walkHtmlFiles(p)));
  }

  const result: StaticHashResult = {
    scriptElem: new Set(),
    styleElem: new Set(),
    styleAttr: new Set(),
    scriptAttr: new Set(),
  };

  for (const file of allFiles) {
    const html = readFileSync(file, 'utf8');
    const h = extractHashesFromHtml(html);
    for (const s of h.scriptElem) result.scriptElem.add(s);
    for (const s of h.styleElem) result.styleElem.add(s);
    for (const s of h.styleAttr) result.styleAttr.add(s);
    for (const s of h.scriptAttr) result.scriptAttr.add(s);
  }

  return { result, files: allFiles };
}

// ── Source expression normalization ──────────────────────────────────────

/**
 * CSP requires hash and nonce source expressions to be wrapped in single
 * quotes: `'sha256-…'`, `'nonce-…'`. Users frequently pass these values
 * through shell commands where single quotes are stripped by the shell
 * before the CLI sees them. If the resulting unquoted token is written to
 * the policy as-is, browsers parse it as a host expression and the hash
 * silently stops matching — with the hash prefix being lowercased and
 * prefixed with `https://`. This normaliser re-adds the CSP quotes when it
 * detects a bare hash/nonce token, so both quoted and unquoted forms work.
 *
 * Non-hash, non-nonce tokens (plain origins, keywords like 'self') are
 * returned unchanged.
 */
export function normalizeSourceExpression(source: string): string {
  const trimmed = source.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed;
  if (/^(?:sha256-|sha384-|sha512-|nonce-)/i.test(trimmed)) {
    return `'${trimmed}'`;
  }
  return trimmed;
}

// ── Policy building ──────────────────────────────────────────────────────

/**
 * Constructs a directive map from scanned hashes plus a set of secure
 * defaults suitable for typical static sites (same-origin assets, data: URIs
 * for images). Directives without any content are omitted except for the
 * hardened defaults (default-src, object-src, base-uri, form-action).
 */
export function buildStaticPolicy(
  hashes: StaticHashResult,
  options: BuildPolicyOptions = {},
): Record<string, string[]> {
  const dedupeSort = (items: Iterable<string>): string[] => [...new Set(items)].sort();

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'font-src': ["'self'"],
    'form-action': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'script-src-elem': dedupeSort(["'self'", ...hashes.scriptElem]),
    'style-src-elem': dedupeSort(["'self'", ...hashes.styleElem]),
  };

  // Attribute directives require 'unsafe-hashes' for the listed hashes to
  // actually apply to inline attributes (spec quirk).
  if (hashes.styleAttr.size > 0) {
    directives['style-src-attr'] = ["'unsafe-hashes'", ...dedupeSort(hashes.styleAttr)];
  }
  if (hashes.scriptAttr.size > 0) {
    directives['script-src-attr'] = ["'unsafe-hashes'", ...dedupeSort(hashes.scriptAttr)];
  }

  // Merge extra directive sources into the directive map.
  if (options.extraDirectives) {
    for (const [directive, sources] of options.extraDirectives) {
      const normalized = sources.map(normalizeSourceExpression);
      const existing = directive in directives ? directives[directive] : undefined;
      directives[directive] = existing
        ? dedupeSort([...existing, ...normalized])
        : dedupeSort(normalized);
    }
  }

  // Ensure attribute directives contain 'unsafe-hashes' when they have hash
  // sources — without it browsers silently ignore the hashes (CSP3 §2.3.2).
  // This covers both scan-discovered and --extra / --merge-json sources.
  for (const attrDirective of ['style-src-attr', 'script-src-attr'] as const) {
    const values = directives[attrDirective] as string[] | undefined;
    if (values && values.some((s) => s.startsWith("'sha")) && !values.includes("'unsafe-hashes'")) {
      directives[attrDirective] = ["'unsafe-hashes'", ...values];
    }
  }

  return directives;
}

// ── Meta tag injection ───────────────────────────────────────────────────

/**
 * Escapes a CSP policy string for safe embedding in an HTML attribute.
 */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Removes any existing `<meta http-equiv="Content-Security-Policy">` from the
 * HTML and injects a new one directly after the opening `<head>` tag.
 */
export function injectCspMeta(html: string, policyString: string): string {
  const stripped = html.replace(
    /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi,
    '',
  );
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policyString)}">`;
  return stripped.replace(/<head\b([^>]*)>/i, (_m, attrs: string) => `<head${attrs}>${metaTag}`);
}

/**
 * Writes each (path, new html) pair back to disk. Returns the number of files
 * actually updated.
 */
export function writeUpdatedHtml(updates: ReadonlyMap<string, string>): number {
  let written = 0;
  for (const [path, html] of updates) {
    writeFileSync(path, html);
    written++;
  }
  logger.info('Wrote CSP meta tag into HTML files', { count: written });
  return written;
}
