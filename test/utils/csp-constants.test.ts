import { describe, it, expect } from 'vitest';
import {
  CSP_DIRECTIVES,
  FETCH_DIRECTIVES,
  DIRECTIVE_FALLBACK_MAP,
  buildDenyAllCSP,
  buildReportToHeader,
} from '../../src/utils/csp-constants.js';

describe('CSP_DIRECTIVES', () => {
  const expectedDirectives = [
    'script-src',
    'style-src',
    'img-src',
    'font-src',
    'connect-src',
    'media-src',
    'object-src',
    'frame-src',
    'worker-src',
    'child-src',
    'form-action',
    'base-uri',
    'manifest-src',
  ];

  it.each(expectedDirectives)('includes %s', (directive) => {
    expect(CSP_DIRECTIVES).toContain(directive);
  });

  it('includes default-src', () => {
    expect(CSP_DIRECTIVES).toContain('default-src');
  });

  it('includes script-src-elem and script-src-attr', () => {
    expect(CSP_DIRECTIVES).toContain('script-src-elem');
    expect(CSP_DIRECTIVES).toContain('script-src-attr');
  });

  it('includes style-src-elem and style-src-attr', () => {
    expect(CSP_DIRECTIVES).toContain('style-src-elem');
    expect(CSP_DIRECTIVES).toContain('style-src-attr');
  });
});

describe('DIRECTIVE_FALLBACK_MAP', () => {
  it('maps fetch directives to default-src', () => {
    for (const directive of FETCH_DIRECTIVES) {
      expect(DIRECTIVE_FALLBACK_MAP[directive]).toBe('default-src');
    }
  });

  it('maps script-src-elem to script-src', () => {
    expect(DIRECTIVE_FALLBACK_MAP['script-src-elem']).toBe('script-src');
  });

  it('maps script-src-attr to script-src', () => {
    expect(DIRECTIVE_FALLBACK_MAP['script-src-attr']).toBe('script-src');
  });

  it('maps style-src-elem to style-src', () => {
    expect(DIRECTIVE_FALLBACK_MAP['style-src-elem']).toBe('style-src');
  });

  it('maps style-src-attr to style-src', () => {
    expect(DIRECTIVE_FALLBACK_MAP['style-src-attr']).toBe('style-src');
  });

  it('does not have a fallback for default-src', () => {
    expect(DIRECTIVE_FALLBACK_MAP['default-src']).toBeUndefined();
  });
});

describe('buildDenyAllCSP', () => {
  it('includes report-uri with the given endpoint', () => {
    const csp = buildDenyAllCSP('https://localhost:9999/report');
    expect(csp).toContain('report-uri https://localhost:9999/report');
  });

  it('sets all major directives to none', () => {
    const csp = buildDenyAllCSP('/report');
    const expectedNone = [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'font-src',
      'connect-src',
      'media-src',
      'object-src',
      'frame-src',
      'worker-src',
      'child-src',
      'form-action',
      'base-uri',
      'manifest-src',
    ];

    for (const directive of expectedNone) {
      expect(csp).toContain(`${directive} 'none'`);
    }
  });

  it('does not include report-to when group is not provided', () => {
    const csp = buildDenyAllCSP('/report');
    expect(csp).not.toContain('report-to');
  });

  it('includes report-to when group is provided', () => {
    const csp = buildDenyAllCSP('/report', 'csp-endpoint');
    expect(csp).toContain('report-to csp-endpoint');
  });

  it('produces semicolon-separated directives', () => {
    const csp = buildDenyAllCSP('/report');
    const parts = csp.split('; ');
    expect(parts.length).toBeGreaterThan(1);
  });
});

describe('buildReportToHeader', () => {
  it('returns valid JSON with the correct structure', () => {
    const header = buildReportToHeader('https://localhost:9999/report', 'csp-endpoint');
    const parsed = JSON.parse(header);

    expect(parsed.group).toBe('csp-endpoint');
    expect(parsed.max_age).toBe(86400);
    expect(parsed.endpoints).toEqual([{ url: 'https://localhost:9999/report' }]);
  });
});
