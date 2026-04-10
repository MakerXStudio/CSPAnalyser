import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  green, yellow, red, cyan, bold, dim,
  stripAnsi, isColorDisabled, setNoColor,
  formatCrawlProgress, formatElapsed, formatSummaryTable,
} from '../../src/utils/terminal.js';

describe('terminal color utilities', () => {
  const originalNoColor = process.env['NO_COLOR'];
  const originalTerm = process.env['TERM'];

  beforeEach(() => {
    // Reset state before each test
    setNoColor(undefined);
    delete process.env['NO_COLOR'];
    delete process.env['TERM'];
  });

  afterEach(() => {
    setNoColor(undefined);
    if (originalNoColor !== undefined) {
      process.env['NO_COLOR'] = originalNoColor;
    } else {
      delete process.env['NO_COLOR'];
    }
    if (originalTerm !== undefined) {
      process.env['TERM'] = originalTerm;
    } else {
      delete process.env['TERM'];
    }
  });

  describe('color functions with color enabled', () => {
    it('wraps text with ANSI green', () => {
      expect(green('ok')).toBe('\x1b[32mok\x1b[39m');
    });

    it('wraps text with ANSI yellow', () => {
      expect(yellow('warn')).toBe('\x1b[33mwarn\x1b[39m');
    });

    it('wraps text with ANSI red', () => {
      expect(red('err')).toBe('\x1b[31merr\x1b[39m');
    });

    it('wraps text with ANSI cyan', () => {
      expect(cyan('info')).toBe('\x1b[36minfo\x1b[39m');
    });

    it('wraps text with ANSI bold', () => {
      expect(bold('title')).toBe('\x1b[1mtitle\x1b[22m');
    });

    it('wraps text with ANSI dim', () => {
      expect(dim('muted')).toBe('\x1b[2mmuted\x1b[22m');
    });
  });

  describe('NO_COLOR env var', () => {
    it('disables colors when NO_COLOR is set', () => {
      process.env['NO_COLOR'] = '';
      expect(isColorDisabled()).toBe(true);
      expect(green('ok')).toBe('ok');
    });

    it('disables colors when NO_COLOR is set to any value', () => {
      process.env['NO_COLOR'] = '1';
      expect(isColorDisabled()).toBe(true);
      expect(red('err')).toBe('err');
    });
  });

  describe('TERM=dumb', () => {
    it('disables colors when TERM is dumb', () => {
      process.env['TERM'] = 'dumb';
      expect(isColorDisabled()).toBe(true);
      expect(cyan('info')).toBe('info');
    });
  });

  describe('setNoColor', () => {
    it('explicitly disables colors', () => {
      setNoColor(true);
      expect(isColorDisabled()).toBe(true);
      expect(yellow('warn')).toBe('warn');
    });

    it('explicitly enables colors even with NO_COLOR set', () => {
      process.env['NO_COLOR'] = '1';
      setNoColor(false);
      expect(isColorDisabled()).toBe(false);
      expect(green('ok')).toBe('\x1b[32mok\x1b[39m');
    });

    it('resets to env-based detection when set to undefined', () => {
      setNoColor(true);
      expect(isColorDisabled()).toBe(true);
      setNoColor(undefined);
      expect(isColorDisabled()).toBe(false); // NO_COLOR not set
    });
  });

  describe('stripAnsi', () => {
    it('removes ANSI escape sequences', () => {
      expect(stripAnsi('\x1b[32mok\x1b[39m')).toBe('ok');
    });

    it('removes multiple ANSI sequences', () => {
      expect(stripAnsi('\x1b[1m\x1b[32mok\x1b[39m\x1b[22m')).toBe('ok');
    });

    it('returns plain text unchanged', () => {
      expect(stripAnsi('hello')).toBe('hello');
    });

    it('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });
  });
});

describe('formatCrawlProgress', () => {
  beforeEach(() => setNoColor(true));
  afterEach(() => setNoColor(undefined));

  it('formats progress with page count and URL', () => {
    const result = formatCrawlProgress(3, 10, 'https://example.com/about');
    expect(result).toBe('Crawling [3/10] https://example.com/about');
  });

  it('handles first page', () => {
    const result = formatCrawlProgress(1, 5, 'https://example.com');
    expect(result).toContain('[1/5]');
    expect(result).toContain('https://example.com');
  });
});

describe('formatElapsed', () => {
  it('formats seconds only', () => {
    expect(formatElapsed(5000)).toBe('5s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsed(125000)).toBe('2m 5s');
  });

  it('formats zero seconds', () => {
    expect(formatElapsed(500)).toBe('0s');
  });

  it('formats exact minutes', () => {
    expect(formatElapsed(120000)).toBe('2m 0s');
  });
});

describe('formatSummaryTable', () => {
  beforeEach(() => setNoColor(true));
  afterEach(() => setNoColor(undefined));

  it('includes all stats', () => {
    const result = formatSummaryTable({
      pagesVisited: 5,
      violationsFound: 12,
      uniqueDirectives: 4,
      elapsed: '3s',
      topDirectives: [
        { directive: 'script-src', count: 7 },
        { directive: 'style-src', count: 5 },
      ],
    });

    expect(result).toContain('Pages crawled:');
    expect(result).toContain('5');
    expect(result).toContain('Violations found:');
    expect(result).toContain('12');
    expect(result).toContain('Unique directives:');
    expect(result).toContain('4');
    expect(result).toContain('Time elapsed:');
    expect(result).toContain('3s');
    expect(result).toContain('script-src');
    expect(result).toContain('7 violations');
    expect(result).toContain('style-src');
    expect(result).toContain('5 violations');
  });

  it('handles zero violations without top directives section', () => {
    const result = formatSummaryTable({
      pagesVisited: 1,
      violationsFound: 0,
      uniqueDirectives: 0,
      elapsed: '1s',
      topDirectives: [],
    });

    expect(result).toContain('0');
    expect(result).not.toContain('Top violated');
  });

  it('includes summary header', () => {
    const result = formatSummaryTable({
      pagesVisited: 1,
      violationsFound: 0,
      uniqueDirectives: 0,
      elapsed: '1s',
      topDirectives: [],
    });

    expect(result).toContain('Summary');
  });
});
