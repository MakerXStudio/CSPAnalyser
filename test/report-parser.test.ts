import { describe, it, expect } from 'vitest';
import {
  parseCspReport,
  parseReportingApiReport,
  parseDomViolation,
} from '../src/report-parser.js';

const SESSION_ID = 'test-session-id';
const PAGE_ID = 'test-page-id';

// ── parseCspReport ───────────────────────────────────────────────────────

describe('parseCspReport', () => {
  it('parses a valid csp-report envelope', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/page',
        'blocked-uri': 'https://cdn.example.com/script.js',
        'violated-directive': "script-src 'none'",
        'effective-directive': 'script-src',
        'source-file': 'https://example.com/page',
        'line-number': 42,
        'column-number': 10,
        'disposition': 'report',
      },
    };

    const result = parseCspReport(body, SESSION_ID, PAGE_ID);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(SESSION_ID);
    expect(result!.pageId).toBe(PAGE_ID);
    expect(result!.documentUri).toBe('https://example.com/page');
    expect(result!.blockedUri).toBe('https://cdn.example.com/script.js');
    expect(result!.violatedDirective).toBe('script-src');
    expect(result!.effectiveDirective).toBe('script-src');
    expect(result!.sourceFile).toBe('https://example.com/page');
    expect(result!.lineNumber).toBe(42);
    expect(result!.columnNumber).toBe(10);
    expect(result!.disposition).toBe('report');
    expect(result!.capturedVia).toBe('report_uri');
    expect(result!.rawReport).toBe(JSON.stringify(body));
  });

  it('extracts directive name from full violated-directive value', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'inline',
        'violated-directive': "style-src 'none'",
        'effective-directive': "style-src",
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.violatedDirective).toBe('style-src');
  });

  it('normalizes special blocked-uri values', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'inline',
        'violated-directive': 'style-src',
        'effective-directive': 'style-src',
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.blockedUri).toBe("'unsafe-inline'");
  });

  it('normalizes empty blocked-uri to none', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': '',
        'violated-directive': 'default-src',
        'effective-directive': 'default-src',
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.blockedUri).toBe("'none'");
  });

  it('falls back effective-directive to violated-directive', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'https://evil.com/x.js',
        'violated-directive': 'script-src',
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.effectiveDirective).toBe('script-src');
  });

  it('returns null for non-object body', () => {
    expect(parseCspReport('not-an-object', SESSION_ID, null)).toBeNull();
    expect(parseCspReport(null, SESSION_ID, null)).toBeNull();
    expect(parseCspReport(42, SESSION_ID, null)).toBeNull();
  });

  it('returns null when csp-report envelope is missing', () => {
    expect(parseCspReport({}, SESSION_ID, null)).toBeNull();
    expect(parseCspReport({ other: 'data' }, SESSION_ID, null)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const noDocUri = {
      'csp-report': {
        'blocked-uri': 'https://cdn.example.com/x.js',
        'violated-directive': 'script-src',
      },
    };
    expect(parseCspReport(noDocUri, SESSION_ID, null)).toBeNull();

    const noDirective = {
      'csp-report': {
        'document-uri': 'https://example.com/',
      },
    };
    expect(parseCspReport(noDirective, SESSION_ID, null)).toBeNull();
  });

  it('defaults disposition to report when not specified', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'https://cdn.example.com/x.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.disposition).toBe('report');
  });

  it('handles disposition enforce', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'blocked-uri': 'https://cdn.example.com/x.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
        'disposition': 'enforce',
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.disposition).toBe('enforce');
  });

  it('handles null optional fields gracefully', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
      },
    };

    const result = parseCspReport(body, SESSION_ID, PAGE_ID);
    expect(result!.sourceFile).toBeNull();
    expect(result!.lineNumber).toBeNull();
    expect(result!.columnNumber).toBeNull();
  });
});

// ── parseReportingApiReport ──────────────────────────────────────────────

describe('parseReportingApiReport', () => {
  it('parses an array of csp-violation reports', () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/page',
          blockedURL: 'https://cdn.example.com/style.css',
          effectiveDirective: 'style-src',
          sourceFile: 'https://example.com/page',
          lineNumber: 5,
          columnNumber: 1,
          disposition: 'report',
        },
      },
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/page',
          blockedURL: 'https://cdn.example.com/img.png',
          effectiveDirective: 'img-src',
          disposition: 'enforce',
        },
      },
    ];

    const results = parseReportingApiReport(body, SESSION_ID, PAGE_ID);

    expect(results).toHaveLength(2);
    expect(results[0]!.effectiveDirective).toBe('style-src');
    expect(results[0]!.capturedVia).toBe('reporting_api');
    expect(results[0]!.lineNumber).toBe(5);
    expect(results[1]!.effectiveDirective).toBe('img-src');
    expect(results[1]!.disposition).toBe('enforce');
  });

  it('skips non-csp-violation report types', () => {
    const body = [
      { type: 'deprecation', body: { id: 'foo' } },
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: 'eval',
          effectiveDirective: 'script-src',
        },
      },
    ];

    const results = parseReportingApiReport(body, SESSION_ID, null);
    expect(results).toHaveLength(1);
    expect(results[0]!.blockedUri).toBe("'unsafe-eval'");
  });

  it('skips entries missing required fields', () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          blockedURL: 'https://cdn.example.com/x.js',
          // missing documentURL and effectiveDirective
        },
      },
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          // missing effectiveDirective
        },
      },
    ];

    const results = parseReportingApiReport(body, SESSION_ID, null);
    expect(results).toHaveLength(0);
  });

  it('returns empty array for non-array body', () => {
    expect(parseReportingApiReport('string', SESSION_ID, null)).toEqual([]);
    expect(parseReportingApiReport({}, SESSION_ID, null)).toEqual([]);
    expect(parseReportingApiReport(null, SESSION_ID, null)).toEqual([]);
  });

  it('skips entries with non-object body', () => {
    const body = [
      { type: 'csp-violation', body: 'not-an-object' },
      'not-an-object',
    ];

    const results = parseReportingApiReport(body, SESSION_ID, null);
    expect(results).toHaveLength(0);
  });

  it('stores rawReport as stringified individual entry', () => {
    const entry = {
      type: 'csp-violation',
      body: {
        documentURL: 'https://example.com/',
        blockedURL: 'data:image/png;base64,abc',
        effectiveDirective: 'img-src',
      },
    };

    const results = parseReportingApiReport([entry], SESSION_ID, null);
    expect(results[0]!.rawReport).toBe(JSON.stringify(entry));
  });

  it('sets violatedDirective same as effectiveDirective', () => {
    const body = [
      {
        type: 'csp-violation',
        body: {
          documentURL: 'https://example.com/',
          blockedURL: 'https://cdn.example.com/x.js',
          effectiveDirective: 'script-src',
        },
      },
    ];

    const results = parseReportingApiReport(body, SESSION_ID, null);
    expect(results[0]!.violatedDirective).toBe('script-src');
  });
});

// ── parseDomViolation ────────────────────────────────────────────────────

describe('parseDomViolation', () => {
  it('parses a valid SecurityPolicyViolationEvent', () => {
    const data = {
      documentURI: 'https://example.com/page',
      blockedURI: 'https://cdn.example.com/font.woff2',
      violatedDirective: 'font-src',
      effectiveDirective: 'font-src',
      sourceFile: 'https://example.com/page',
      lineNumber: 100,
      columnNumber: 20,
      disposition: 'enforce',
    };

    const result = parseDomViolation(data, SESSION_ID, PAGE_ID);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(SESSION_ID);
    expect(result!.pageId).toBe(PAGE_ID);
    expect(result!.documentUri).toBe('https://example.com/page');
    expect(result!.blockedUri).toBe('https://cdn.example.com/font.woff2');
    expect(result!.violatedDirective).toBe('font-src');
    expect(result!.effectiveDirective).toBe('font-src');
    expect(result!.capturedVia).toBe('dom_event');
    expect(result!.disposition).toBe('enforce');
    expect(result!.rawReport).toBe(JSON.stringify(data));
  });

  it('normalizes blocked-uri special values', () => {
    const data = {
      documentURI: 'https://example.com/',
      blockedURI: 'eval',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
    };

    const result = parseDomViolation(data, SESSION_ID, null);
    expect(result!.blockedUri).toBe("'unsafe-eval'");
  });

  it('extracts directive name from full directive value', () => {
    const data = {
      documentURI: 'https://example.com/',
      blockedURI: 'blob:https://example.com/abc',
      violatedDirective: "worker-src 'none'",
      effectiveDirective: 'worker-src',
    };

    const result = parseDomViolation(data, SESSION_ID, null);
    expect(result!.violatedDirective).toBe('worker-src');
    expect(result!.blockedUri).toBe('blob:');
  });

  it('returns null for non-object data', () => {
    expect(parseDomViolation(null, SESSION_ID, null)).toBeNull();
    expect(parseDomViolation('string', SESSION_ID, null)).toBeNull();
    expect(parseDomViolation([], SESSION_ID, null)).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseDomViolation({ blockedURI: 'x' }, SESSION_ID, null)).toBeNull();
    expect(parseDomViolation({ documentURI: 'x' }, SESSION_ID, null)).toBeNull();
  });

  it('falls back effective-directive to violated-directive', () => {
    const data = {
      documentURI: 'https://example.com/',
      blockedURI: 'https://evil.com/x.js',
      violatedDirective: 'script-src',
    };

    const result = parseDomViolation(data, SESSION_ID, null);
    expect(result!.effectiveDirective).toBe('script-src');
  });

  it('handles missing optional fields', () => {
    const data = {
      documentURI: 'https://example.com/',
      blockedURI: 'https://cdn.example.com/x.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
    };

    const result = parseDomViolation(data, SESSION_ID, null);
    expect(result!.sourceFile).toBeNull();
    expect(result!.lineNumber).toBeNull();
    expect(result!.columnNumber).toBeNull();
  });

  it('defaults disposition to report', () => {
    const data = {
      documentURI: 'https://example.com/',
      blockedURI: 'https://cdn.example.com/x.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
    };

    const result = parseDomViolation(data, SESSION_ID, null);
    expect(result!.disposition).toBe('report');
  });
});

// ── String length truncation ─────────────────────────────────────────────

describe('string length truncation', () => {
  const longUri = 'https://example.com/' + 'a'.repeat(2048);
  const longSourceFile = 'https://example.com/src/' + 'b'.repeat(2048);
  const longDirective = 'x'.repeat(200);

  describe('parseCspReport truncation', () => {
    it('truncates documentUri to 2048 chars', () => {
      const body = {
        'csp-report': {
          'document-uri': longUri,
          'blocked-uri': 'https://cdn.example.com/x.js',
          'violated-directive': 'script-src',
          'effective-directive': 'script-src',
        },
      };

      const result = parseCspReport(body, SESSION_ID, null);
      expect(result!.documentUri.length).toBe(2048);
    });

    it('truncates blockedUri to 2048 chars', () => {
      const body = {
        'csp-report': {
          'document-uri': 'https://example.com/',
          'blocked-uri': longUri,
          'violated-directive': 'script-src',
          'effective-directive': 'script-src',
        },
      };

      const result = parseCspReport(body, SESSION_ID, null);
      expect(result!.blockedUri.length).toBe(2048);
    });

    it('truncates sourceFile to 2048 chars', () => {
      const body = {
        'csp-report': {
          'document-uri': 'https://example.com/',
          'blocked-uri': 'https://cdn.example.com/x.js',
          'violated-directive': 'script-src',
          'effective-directive': 'script-src',
          'source-file': longSourceFile,
        },
      };

      const result = parseCspReport(body, SESSION_ID, null);
      expect(result!.sourceFile!.length).toBe(2048);
    });

    it('truncates directive names to 128 chars', () => {
      const body = {
        'csp-report': {
          'document-uri': 'https://example.com/',
          'blocked-uri': 'https://cdn.example.com/x.js',
          'violated-directive': longDirective,
          'effective-directive': longDirective,
        },
      };

      const result = parseCspReport(body, SESSION_ID, null);
      expect(result!.violatedDirective.length).toBe(128);
      expect(result!.effectiveDirective.length).toBe(128);
    });

    it('truncates rawReport to 64KB', () => {
      const hugeValue = 'x'.repeat(70_000);
      const body = {
        'csp-report': {
          'document-uri': 'https://example.com/',
          'blocked-uri': hugeValue,
          'violated-directive': 'script-src',
          'effective-directive': 'script-src',
        },
      };

      const result = parseCspReport(body, SESSION_ID, null);
      expect(result!.rawReport!.length).toBe(64 * 1024);
    });
  });

  describe('parseReportingApiReport truncation', () => {
    it('truncates URI and directive fields', () => {
      const body = [
        {
          type: 'csp-violation',
          body: {
            documentURL: longUri,
            blockedURL: longUri,
            effectiveDirective: longDirective,
            sourceFile: longSourceFile,
          },
        },
      ];

      const results = parseReportingApiReport(body, SESSION_ID, null);
      expect(results).toHaveLength(1);
      expect(results[0]!.documentUri.length).toBe(2048);
      expect(results[0]!.blockedUri.length).toBe(2048);
      expect(results[0]!.effectiveDirective.length).toBe(128);
      expect(results[0]!.violatedDirective.length).toBe(128);
      expect(results[0]!.sourceFile!.length).toBe(2048);
    });

    it('truncates rawReport to 64KB', () => {
      const hugeValue = 'x'.repeat(70_000);
      const body = [
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://example.com/',
            blockedURL: hugeValue,
            effectiveDirective: 'script-src',
          },
        },
      ];

      const results = parseReportingApiReport(body, SESSION_ID, null);
      expect(results[0]!.rawReport!.length).toBe(64 * 1024);
    });
  });

  describe('parseDomViolation truncation', () => {
    it('truncates URI and directive fields', () => {
      const data = {
        documentURI: longUri,
        blockedURI: longUri,
        violatedDirective: longDirective,
        effectiveDirective: longDirective,
        sourceFile: longSourceFile,
      };

      const result = parseDomViolation(data, SESSION_ID, null);
      expect(result!.documentUri.length).toBe(2048);
      expect(result!.blockedUri.length).toBe(2048);
      expect(result!.violatedDirective.length).toBe(128);
      expect(result!.effectiveDirective.length).toBe(128);
      expect(result!.sourceFile!.length).toBe(2048);
    });

    it('truncates rawReport to 64KB', () => {
      const hugeValue = 'x'.repeat(70_000);
      const data = {
        documentURI: 'https://example.com/',
        blockedURI: hugeValue,
        violatedDirective: 'script-src',
        effectiveDirective: 'script-src',
      };

      const result = parseDomViolation(data, SESSION_ID, null);
      expect(result!.rawReport!.length).toBe(64 * 1024);
    });
  });

  it('does not truncate strings within limits', () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://example.com/page',
        'blocked-uri': 'https://cdn.example.com/script.js',
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
        'source-file': 'https://example.com/page',
      },
    };

    const result = parseCspReport(body, SESSION_ID, null);
    expect(result!.documentUri).toBe('https://example.com/page');
    expect(result!.blockedUri).toBe('https://cdn.example.com/script.js');
    expect(result!.violatedDirective).toBe('script-src');
    expect(result!.sourceFile).toBe('https://example.com/page');
  });
});
