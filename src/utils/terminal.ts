// ── ANSI color utilities ──────────────────────────────────────────────────
// Respects NO_COLOR (https://no-color.org/) and --no-color CLI flag.

let _noColor: boolean | undefined;

/**
 * Returns true if color output should be suppressed.
 * Checks (in order): explicit override, NO_COLOR env var, TERM=dumb.
 */
export function isColorDisabled(): boolean {
  if (_noColor !== undefined) return _noColor;
  return process.env['NO_COLOR'] !== undefined || process.env['TERM'] === 'dumb';
}

/**
 * Explicitly enable or disable color output (e.g. from --no-color flag).
 * Pass `undefined` to reset to env-based detection.
 */
export function setNoColor(value: boolean | undefined): void {
  _noColor = value;
}

function wrap(code: string, reset: string): (text: string) => string {
  return (text: string) => (isColorDisabled() ? text : `\x1b[${code}m${text}\x1b[${reset}m`);
}

export const green = wrap('32', '39');
export const yellow = wrap('33', '39');
export const red = wrap('31', '39');
export const cyan = wrap('36', '39');
export const bold = wrap('1', '22');
export const dim = wrap('2', '22');

/**
 * Strips ANSI escape sequences from a string.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[\d+m/g, '');
}

// ── Progress formatting helpers ───────────────────────────────────────────

/**
 * Formats a crawl progress line: "Crawling [3/10] https://example.com/about"
 */
export function formatCrawlProgress(current: number, total: number, url: string): string {
  return `${cyan('Crawling')} ${dim(`[${current}/${total}]`)} ${url}`;
}

/**
 * Formats elapsed time in human-readable form.
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Formats a summary table after crawl completion.
 */
export function formatSummaryTable(stats: {
  pagesVisited: number;
  violationsFound: number;
  uniqueDirectives: number;
  elapsed: string;
  topDirectives: Array<{ directive: string; count: number }>;
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('── Summary ──────────────────────────────────'));
  lines.push(`  Pages crawled:     ${green(String(stats.pagesVisited))}`);
  lines.push(
    `  Violations found:  ${stats.violationsFound > 0 ? yellow(String(stats.violationsFound)) : green('0')}`,
  );
  lines.push(`  Unique directives: ${cyan(String(stats.uniqueDirectives))}`);
  lines.push(`  Time elapsed:      ${dim(stats.elapsed)}`);

  if (stats.topDirectives.length > 0) {
    lines.push('');
    lines.push(bold('  Top violated directives:'));
    for (const { directive, count } of stats.topDirectives) {
      lines.push(`    ${yellow(directive.padEnd(20))} ${dim(String(count) + ' violations')}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
