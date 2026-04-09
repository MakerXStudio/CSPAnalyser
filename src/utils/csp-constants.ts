import type { CspDirective } from '../types.js';

/**
 * All CSP directives supported by the analyser.
 */
export const CSP_DIRECTIVES: readonly CspDirective[] = [
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
  'script-src-elem',
  'script-src-attr',
  'style-src-elem',
  'style-src-attr',
] as const;

/**
 * Fetch directives that fall back to default-src when not explicitly set.
 */
export const FETCH_DIRECTIVES: readonly CspDirective[] = [
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
] as const;

/**
 * Maps each directive to its fallback directive.
 * Most fetch directives fall back to default-src.
 * script-src-elem/attr fall back to script-src, style-src-elem/attr to style-src.
 */
export const DIRECTIVE_FALLBACK_MAP: Readonly<Partial<Record<CspDirective, CspDirective>>> = {
  'script-src': 'default-src',
  'style-src': 'default-src',
  'img-src': 'default-src',
  'font-src': 'default-src',
  'connect-src': 'default-src',
  'media-src': 'default-src',
  'object-src': 'default-src',
  'frame-src': 'default-src',
  'worker-src': 'default-src',
  'child-src': 'default-src',
  'script-src-elem': 'script-src',
  'script-src-attr': 'script-src',
  'style-src-elem': 'style-src',
  'style-src-attr': 'style-src',
};

/**
 * Constructs the deny-all Content-Security-Policy-Report-Only header value.
 * Sets all directives to 'none' and includes report-uri (and optionally report-to).
 */
export function buildDenyAllCSP(reportUri: string, reportToGroup?: string): string {
  const directives = [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'none'",
    "img-src 'none'",
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "child-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "manifest-src 'none'",
    `report-uri ${reportUri}`,
  ];

  if (reportToGroup) {
    directives.push(`report-to ${reportToGroup}`);
  }

  return directives.join('; ');
}

/**
 * Constructs the Report-To JSON header value for the Reporting API v1.
 */
export function buildReportToHeader(endpoint: string, group: string): string {
  return JSON.stringify({
    group,
    max_age: 86400,
    endpoints: [{ url: endpoint }],
  });
}
