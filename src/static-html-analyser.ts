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
 * Options for building a policy from scanned hashes. Any hashes in the `extra*`
 * arrays are added to the respective directive to cover content that cannot be
 * discovered by static scanning (e.g. inline scripts or styles injected by
 * framework bundles at runtime). Source expressions are passed through
 * verbatim, so callers can include anything a CSP accepts (hashes, nonces,
 * keywords).
 */
export interface BuildPolicyOptions {
  extraScriptElem?: readonly string[];
  extraStyleElem?: readonly string[];
  extraStyleAttr?: readonly string[];
  extraScriptAttr?: readonly string[];
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

  // style="..." attributes — include empty strings.
  const styleAttrRe = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of html.matchAll(styleAttrRe)) {
    const value = m[1] !== undefined ? m[1] : m[2];
    styleAttr.add(`'sha256-${sha256b64(decodeHtmlEntities(value))}'`);
  }

  // on*="..." event handler attributes — include empty strings.
  const onAttrRe = /\son[a-z]+\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of html.matchAll(onAttrRe)) {
    const value = m[1] !== undefined ? m[1] : m[2];
    scriptAttr.add(`'sha256-${sha256b64(decodeHtmlEntities(value))}'`);
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

  const scriptElem = dedupeSort([
    "'self'",
    ...(options.extraScriptElem ?? []),
    ...hashes.scriptElem,
  ]);
  const styleElem = dedupeSort([
    "'self'",
    ...(options.extraStyleElem ?? []),
    ...hashes.styleElem,
  ]);
  const styleAttr = dedupeSort([...(options.extraStyleAttr ?? []), ...hashes.styleAttr]);
  const scriptAttr = dedupeSort([...(options.extraScriptAttr ?? []), ...hashes.scriptAttr]);

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'font-src': ["'self'"],
    'form-action': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'script-src-elem': scriptElem,
    'style-src-elem': styleElem,
  };

  // Attribute directives require 'unsafe-hashes' for the listed hashes to
  // actually apply to inline attributes (spec quirk).
  if (styleAttr.length > 0) {
    directives['style-src-attr'] = ["'unsafe-hashes'", ...styleAttr];
  }
  if (scriptAttr.length > 0) {
    directives['script-src-attr'] = ["'unsafe-hashes'", ...scriptAttr];
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
