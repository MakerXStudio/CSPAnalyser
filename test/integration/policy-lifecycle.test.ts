/**
 * Integration tests for the full policy lifecycle.
 *
 * Exercises the stack without a real browser: we seed a database with a
 * realistic set of violations + inline hashes, then drive the full pipeline:
 *
 *   generatePolicy → optimizePolicy → scoreCspPolicy → formatPolicy (all formats)
 *
 * The goal is to confirm the module seams don't drift: the directive map
 * from one stage must be consumable by the next, and each export format must
 * produce syntactically valid output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  insertPage,
  insertViolation,
  insertInlineHash,
} from '../../src/db/repository.js';
import { generatePolicy } from '../../src/policy-generator.js';
import { optimizePolicy } from '../../src/policy-optimizer.js';
import { scoreCspPolicy } from '../../src/policy-scorer.js';
import { formatPolicy } from '../../src/policy-formatter.js';
import type { ExportFormat } from '../../src/types.js';

const ALL_FORMATS: ExportFormat[] = [
  'header',
  'meta',
  'nginx',
  'apache',
  'cloudflare',
  'cloudflare-pages',
  'azure-frontdoor',
  'helmet',
  'json',
];

function seedRealisticSession(
  db: Database.Database,
  targetUrl = 'https://app.example.com',
): { sessionId: string } {
  const session = createSession(db, { targetUrl });
  const page = insertPage(db, session.id, `${targetUrl}/`, 200);
  const pageId = page?.id ?? null;

  // connect-src: third-party API
  insertViolation(db, {
    sessionId: session.id,
    pageId,
    documentUri: `${targetUrl}/`,
    blockedUri: 'https://api.example.net/data',
    violatedDirective: 'connect-src',
    effectiveDirective: 'connect-src',
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: null,
    capturedVia: 'dom_event',
    rawReport: '{}',
  });

  // img-src: CDN
  insertViolation(db, {
    sessionId: session.id,
    pageId,
    documentUri: `${targetUrl}/`,
    blockedUri: 'https://cdn.example.net/logo.png',
    violatedDirective: 'img-src',
    effectiveDirective: 'img-src',
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: null,
    capturedVia: 'report_uri',
    rawReport: '{}',
  });

  // font-src: Google fonts
  insertViolation(db, {
    sessionId: session.id,
    pageId,
    documentUri: `${targetUrl}/`,
    blockedUri: 'https://fonts.gstatic.com/s/inter.woff2',
    violatedDirective: 'font-src',
    effectiveDirective: 'font-src',
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: null,
    capturedVia: 'dom_event',
    rawReport: '{}',
  });

  // inline hashes: one script, one style, one style attribute (triggers unsafe-hashes)
  insertInlineHash(db, {
    sessionId: session.id,
    pageId,
    directive: 'script-src-elem',
    hash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    contentLength: 128,
  });
  insertInlineHash(db, {
    sessionId: session.id,
    pageId,
    directive: 'style-src-elem',
    hash: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    sourceSize: 256,
    isExtracted: true,
  });
  insertInlineHash(db, {
    sessionId: session.id,
    pageId,
    directive: 'style-src-attr',
    hash: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    sourceSize: 16,
    isExtracted: true,
  });

  return { sessionId: session.id };
}

describe('policy lifecycle', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('generate → optimize → format', () => {
    it('produces valid output in every export format', () => {
      const { sessionId } = seedRealisticSession(db);

      const directives = generatePolicy(db, sessionId, {
        strictness: 'strict',
        includeHashes: true,
      });
      const optimized = optimizePolicy(directives, 'https://app.example.com', {
        useHashes: true,
      });

      for (const format of ALL_FORMATS) {
        const output = formatPolicy(optimized, format);
        expect(output.length).toBeGreaterThan(0);
      }
    });

    it('produces a well-formed Content-Security-Policy header', () => {
      const { sessionId } = seedRealisticSession(db);
      const directives = generatePolicy(db, sessionId, {
        strictness: 'moderate',
        includeHashes: false,
      });
      const optimized = optimizePolicy(directives, 'https://app.example.com');
      const header = formatPolicy(optimized, 'header');

      expect(header).toMatch(/^Content-Security-Policy: /);
      expect(header).toContain("default-src 'self'");
      // Directives separated by "; "
      const body = header.replace(/^Content-Security-Policy: /, '');
      const parts = body.split(';').map((p) => p.trim()).filter(Boolean);
      expect(parts.length).toBeGreaterThan(3);
    });

    it('produces meta tag with report-uri stripped', () => {
      const directives = {
        'default-src': ["'self'"],
        'report-uri': ['/csp-report'],
        'report-to': ['csp-analyser'],
      };
      const meta = formatPolicy(directives, 'meta');

      expect(meta).toMatch(
        /^<meta http-equiv="Content-Security-Policy" content="[^"]+">$/,
      );
      expect(meta).not.toContain('report-uri');
      expect(meta).not.toContain('report-to');
    });

    it('rejects meta format for Report-Only policies', () => {
      expect(() => formatPolicy({ 'default-src': ["'self'"] }, 'meta', true)).toThrow(
        /not supported in <meta>/,
      );
    });

    it('produces parseable JSON output', () => {
      const { sessionId } = seedRealisticSession(db);
      const directives = generatePolicy(db, sessionId, { strictness: 'strict' });
      const optimized = optimizePolicy(directives, 'https://app.example.com');
      const jsonOutput = formatPolicy(optimized, 'json');

      const parsed = JSON.parse(jsonOutput) as unknown;
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
    });

    it('produces nginx output with add_header directive', () => {
      const directives = { 'default-src': ["'self'"] };
      const nginx = formatPolicy(directives, 'nginx');

      expect(nginx).toContain('add_header');
      expect(nginx).toContain('Content-Security-Policy');
      expect(nginx).toContain('always');
    });

    it('produces apache output with Header directive', () => {
      const directives = { 'default-src': ["'self'"] };
      const apache = formatPolicy(directives, 'apache');

      expect(apache).toMatch(/^Header always set Content-Security-Policy/);
    });

    it('produces cloudflare worker code with header.set', () => {
      const directives = { 'default-src': ["'self'"] };
      const worker = formatPolicy(directives, 'cloudflare');

      expect(worker).toContain('export default');
      expect(worker).toContain("headers.set('Content-Security-Policy'");
      expect(worker).toContain('async fetch(');
    });

    it('produces helmet config with camelCased directive keys', () => {
      const directives = {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
      };
      const helmet = formatPolicy(directives, 'helmet');

      expect(helmet).toContain('defaultSrc');
      expect(helmet).toContain('scriptSrc');
      expect(helmet).not.toContain('default-src');
    });
  });

  // ── Optimizer feature integration ──────────────────────────────────────

  describe('optimizer feature combinations', () => {
    it("adds 'unsafe-hashes' when style-src-attr has hash sources", () => {
      const input = {
        'style-src-attr': [
          "'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'",
        ],
      };
      const optimized = optimizePolicy(input);

      expect(optimized['style-src-attr']).toContain("'unsafe-hashes'");
    });

    it("collapses hashes to 'unsafe-inline' when count exceeds threshold", () => {
      const hashes = Array.from({ length: 10 }, (_, i) => `'sha256-${'A'.repeat(40 + i)}='`);
      const input = { 'style-src-attr': hashes };

      const optimized = optimizePolicy(input, undefined, {
        collapseHashThreshold: 5,
      });

      expect(optimized['style-src-attr']).toContain("'unsafe-inline'");
      expect(
        optimized['style-src-attr'].some((s) => s.startsWith("'sha256-")),
      ).toBe(false);
      expect(optimized['style-src-attr']).not.toContain("'unsafe-hashes'");
    });

    it("leaves hashes alone when count is under the threshold", () => {
      const input = {
        'style-src-elem': ["'sha256-ABC'", "'sha256-DEF'"],
      };
      const optimized = optimizePolicy(input, undefined, {
        collapseHashThreshold: 10,
      });

      expect(optimized['style-src-elem']).toContain("'sha256-ABC'");
      expect(optimized['style-src-elem']).toContain("'sha256-DEF'");
      expect(optimized['style-src-elem']).not.toContain("'unsafe-inline'");
    });

    it("strips 'unsafe-eval' when stripUnsafeEval is set", () => {
      const input = { 'script-src': ["'self'", "'unsafe-eval'"] };
      const optimized = optimizePolicy(input, undefined, {
        stripUnsafeEval: true,
      });

      expect(optimized['script-src']).not.toContain("'unsafe-eval'");
      expect(optimized['script-src']).toContain("'self'");
    });

    it("strips 'unsafe-inline' from directives with hashes when useHashes is set", () => {
      const input = {
        'script-src': ["'self'", "'unsafe-inline'", "'sha256-ABC'"],
      };
      const optimized = optimizePolicy(input, undefined, { useHashes: true });

      expect(optimized['script-src']).not.toContain("'unsafe-inline'");
      expect(optimized['script-src']).toContain("'sha256-ABC'");
    });

    it('injects nonce placeholder when useNonces is set', () => {
      const input = { 'script-src': ["'self'", "'unsafe-inline'"] };
      const optimized = optimizePolicy(input, undefined, { useNonces: true });

      const scriptSrc = optimized['script-src'] ?? [];
      expect(scriptSrc.some((s) => s.includes('{{CSP_NONCE}}'))).toBe(true);
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    });

    it("adds 'strict-dynamic' to script-src when useNonces + useStrictDynamic", () => {
      const input = { 'script-src': ["'self'", "'unsafe-inline'"] };
      const optimized = optimizePolicy(input, undefined, {
        useNonces: true,
        useStrictDynamic: true,
      });

      expect(optimized['script-src']).toContain("'strict-dynamic'");
    });

    it('staticSiteMode skips nonce generation', () => {
      const input = { 'script-src': ["'self'", "'unsafe-inline'"] };
      const optimized = optimizePolicy(input, undefined, {
        useNonces: true,
        staticSiteMode: true,
      });

      const scriptSrc = optimized['script-src'] ?? [];
      expect(scriptSrc.some((s) => s.includes('{{CSP_NONCE}}'))).toBe(false);
    });

    it('adds secure defaults when directives are missing', () => {
      const input = { 'script-src': ["'self'"] };
      const optimized = optimizePolicy(input);

      expect(optimized['default-src']).toEqual(["'self'"]);
      expect(optimized['object-src']).toEqual(["'none'"]);
      expect(optimized['base-uri']).toEqual(["'self'"]);
      expect(optimized['form-action']).toEqual(["'self'"]);
    });
  });

  // ── Scoring ────────────────────────────────────────────────────────────

  describe('scoring', () => {
    it('scores a hash-based policy above a raw unsafe-inline policy', () => {
      const unsafe = {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        'object-src': ["'none'"],
      };
      const withHashes = {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'sha256-ABC'"],
        'object-src': ["'none'"],
      };

      const unsafeScore = scoreCspPolicy(unsafe);
      const safeScore = scoreCspPolicy(withHashes);

      expect(safeScore.overall).toBeGreaterThan(unsafeScore.overall);
    });

    it('flags unsafe-eval as critical', () => {
      const policy = {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-eval'"],
      };
      const score = scoreCspPolicy(policy);

      const criticals = score.findings.filter((f) => f.severity === 'critical');
      expect(criticals.some((f) => f.message.includes('unsafe-eval'))).toBe(true);
    });

    it("assigns a grade between A and F", () => {
      const { sessionId } = seedRealisticSession(db);
      const directives = generatePolicy(db, sessionId, { strictness: 'moderate' });
      const optimized = optimizePolicy(directives, 'https://app.example.com');
      const score = scoreCspPolicy(optimized);

      expect(['A', 'B', 'C', 'D', 'F']).toContain(score.grade);
      expect(score.overall).toBeGreaterThanOrEqual(0);
      expect(score.overall).toBeLessThanOrEqual(100);
    });
  });

  // ── End-to-end: realistic session through the whole stack ─────────────

  describe('end-to-end: seeded session → scored policy in all formats', () => {
    it('survives strict + useHashes + stripUnsafeEval + all formats', () => {
      const { sessionId } = seedRealisticSession(db);
      const directives = generatePolicy(db, sessionId, {
        strictness: 'strict',
        includeHashes: true,
      });
      const optimized = optimizePolicy(directives, 'https://app.example.com', {
        useHashes: true,
        stripUnsafeEval: true,
      });

      const score = scoreCspPolicy(optimized);
      expect(score.grade).toMatch(/^[A-F]$/);

      for (const format of ALL_FORMATS) {
        const output = formatPolicy(optimized, format);
        expect(output).toBeTruthy();
        // JSON must parse
        if (format === 'json') {
          expect(() => JSON.parse(output)).not.toThrow();
        }
        // Header-style formats must not have empty directives (e.g. "key ;")
        if (format === 'header' || format === 'nginx' || format === 'apache') {
          expect(output).not.toMatch(/:\s*$/m);
        }
      }
    });
  });
});
