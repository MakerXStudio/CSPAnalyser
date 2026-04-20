import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  extractHashesFromHtml,
  scanHtmlFiles,
  buildStaticPolicy,
  injectCspMeta,
  walkHtmlFiles,
  normalizeSourceExpression,
} from '../src/static-html-analyser.js';

function sha256(content: string): string {
  return `'sha256-${createHash('sha256').update(content).digest('base64')}'`;
}

describe('extractHashesFromHtml', () => {
  it('hashes inline <script> blocks without src', () => {
    const html = `<!DOCTYPE html><html><head><script>alert(1)</script></head></html>`;
    const result = extractHashesFromHtml(html);
    expect(result.scriptElem).toContain(sha256('alert(1)'));
  });

  it('skips <script> tags with src=', () => {
    const html = `<script src="/app.js"></script>`;
    const result = extractHashesFromHtml(html);
    expect(result.scriptElem.size).toBe(0);
  });

  it('skips empty / whitespace-only <script> blocks', () => {
    const html = `<script>   </script><script></script>`;
    const result = extractHashesFromHtml(html);
    expect(result.scriptElem.size).toBe(0);
  });

  it('hashes inline <style> blocks', () => {
    const html = `<style>body { color: red; }</style>`;
    const result = extractHashesFromHtml(html);
    expect(result.styleElem).toContain(sha256('body { color: red; }'));
  });

  it('hashes inline style="..." attributes', () => {
    const html = `<div style="color: red"></div>`;
    const result = extractHashesFromHtml(html);
    expect(result.styleAttr).toContain(sha256('color: red'));
  });

  it('hashes empty style="" attributes — browsers evaluate CSP against them', () => {
    const html = `<div style=""></div>`;
    const result = extractHashesFromHtml(html);
    expect(result.styleAttr).toContain(sha256(''));
  });

  it('hashes inline on* event handler attributes', () => {
    const html = `<button onclick="alert(1)"></button>`;
    const result = extractHashesFromHtml(html);
    expect(result.scriptAttr).toContain(sha256('alert(1)'));
  });

  it('hashes empty on*="" attributes', () => {
    const html = `<button onclick=""></button>`;
    const result = extractHashesFromHtml(html);
    expect(result.scriptAttr).toContain(sha256(''));
  });

  it('decodes HTML entities in attribute values so hashes match the decoded form', () => {
    // Browsers see the decoded value when applying CSP, so the hash must be
    // computed against the decoded form (not the raw HTML source).
    const html = `<div style="color: &quot;red&quot;"></div>`;
    const result = extractHashesFromHtml(html);
    expect(result.styleAttr).toContain(sha256('color: "red"'));
  });

  it('dedupes identical inline content across the same file', () => {
    const html = `<script>foo()</script><script>foo()</script>`;
    const result = extractHashesFromHtml(html);
    expect(result.scriptElem.size).toBe(1);
  });

  it('handles mixed quoting in attributes', () => {
    const html = `<div style='color: red'></div><div style="color: blue"></div>`;
    const result = extractHashesFromHtml(html);
    expect(result.styleAttr).toContain(sha256('color: red'));
    expect(result.styleAttr).toContain(sha256('color: blue'));
  });
});

describe('scanHtmlFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'csp-analyser-static-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('walks a directory and aggregates hashes across all HTML files', async () => {
    writeFileSync(join(tmpDir, 'a.html'), '<script>a()</script>');
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'sub', 'b.html'), '<script>b()</script>');
    writeFileSync(join(tmpDir, 'ignored.txt'), '<script>c()</script>');

    const { result, files } = await scanHtmlFiles([tmpDir]);

    expect(files.length).toBe(2);
    expect(result.scriptElem).toContain(sha256('a()'));
    expect(result.scriptElem).toContain(sha256('b()'));
    expect(result.scriptElem.size).toBe(2);
  });

  it('accepts a file path directly', async () => {
    const file = join(tmpDir, 'a.html');
    writeFileSync(file, '<script>a()</script>');

    const { files } = await scanHtmlFiles([file]);
    expect(files).toEqual([file]);
  });

  it('deduplicates hashes across multiple files', async () => {
    writeFileSync(join(tmpDir, 'a.html'), '<script>shared()</script>');
    writeFileSync(join(tmpDir, 'b.html'), '<script>shared()</script>');

    const { result } = await scanHtmlFiles([tmpDir]);
    expect(result.scriptElem.size).toBe(1);
  });
});

describe('walkHtmlFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'csp-analyser-walk-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when file has non-html extension', async () => {
    const file = join(tmpDir, 'not-html.txt');
    writeFileSync(file, '<script>a()</script>');
    const result = await walkHtmlFiles(file);
    expect(result).toEqual([]);
  });
});

describe('normalizeSourceExpression', () => {
  it('wraps bare sha256 hashes in CSP single quotes', () => {
    expect(normalizeSourceExpression('sha256-abc=')).toBe("'sha256-abc='");
  });

  it('wraps bare sha384 / sha512 hashes', () => {
    expect(normalizeSourceExpression('sha384-x')).toBe("'sha384-x'");
    expect(normalizeSourceExpression('sha512-y')).toBe("'sha512-y'");
  });

  it('wraps bare nonces', () => {
    expect(normalizeSourceExpression('nonce-abc123')).toBe("'nonce-abc123'");
  });

  it('leaves already-quoted hashes untouched', () => {
    expect(normalizeSourceExpression("'sha256-abc='")).toBe("'sha256-abc='");
  });

  it('leaves origin sources untouched', () => {
    expect(normalizeSourceExpression('https://cdn.example.com')).toBe(
      'https://cdn.example.com',
    );
  });

  it("leaves keyword sources like 'self' untouched", () => {
    expect(normalizeSourceExpression("'self'")).toBe("'self'");
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeSourceExpression('  sha256-abc=  ')).toBe("'sha256-abc='");
  });
});

describe('buildStaticPolicy', () => {
  it('auto-wraps unquoted hash values passed as extra sources', () => {
    // Shells strip single quotes; users frequently pass bare hashes via CLI
    // args. The policy must still come out quoted.
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes, {
      extraDirectives: new Map([
        ['style-src-elem', ['sha256-skqujXORqzxt1aE0NNXxujEanPTX6raoqSscTV/Ww/Y=']],
      ]),
    });
    expect(directives['style-src-elem']).toContain(
      "'sha256-skqujXORqzxt1aE0NNXxujEanPTX6raoqSscTV/Ww/Y='",
    );
    // and never the bare form
    expect(directives['style-src-elem']).not.toContain(
      'sha256-skqujXORqzxt1aE0NNXxujEanPTX6raoqSscTV/Ww/Y=',
    );
  });

  it('produces a secure baseline with no discovered hashes', () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes);
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['script-src-elem']).toEqual(["'self'"]);
    expect(directives['style-src-elem']).toEqual(["'self'"]);
    // No attribute directives when no hashes
    expect(directives['style-src-attr']).toBeUndefined();
    expect(directives['script-src-attr']).toBeUndefined();
  });

  it("adds 'unsafe-hashes' automatically to attribute directives with hashes", () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>([sha256('color: red')]),
      scriptAttr: new Set<string>([sha256('alert(1)')]),
    };
    const directives = buildStaticPolicy(hashes);
    expect(directives['style-src-attr']?.[0]).toBe("'unsafe-hashes'");
    expect(directives['script-src-attr']?.[0]).toBe("'unsafe-hashes'");
  });

  it("adds 'unsafe-hashes' when extraDirectives injects hashes into attribute directives", () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes, {
      extraDirectives: new Map([
        ['style-src-attr', [sha256('color: red')]],
        ['script-src-attr', [sha256('alert(1)')]],
      ]),
    });
    expect(directives['style-src-attr']?.[0]).toBe("'unsafe-hashes'");
    expect(directives['script-src-attr']?.[0]).toBe("'unsafe-hashes'");
    expect(directives['style-src-attr']).toContain(sha256('color: red'));
    expect(directives['script-src-attr']).toContain(sha256('alert(1)'));
  });

  it('adds a new directive via extraDirectives', () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes, {
      extraDirectives: new Map([
        ['connect-src', ['https://api.example.com', 'https://cdn.example.com']],
      ]),
    });
    expect(directives['connect-src']).toEqual([
      'https://api.example.com',
      'https://cdn.example.com',
    ]);
  });

  it('appends extraDirectives sources to existing baseline directives', () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes, {
      extraDirectives: new Map([
        ['font-src', ['https://fonts.gstatic.com']],
        ['img-src', ['https://cdn.example.com']],
      ]),
    });
    expect(directives['font-src']).toEqual(["'self'", 'https://fonts.gstatic.com']);
    expect(directives['img-src']).toEqual(["'self'", 'data:', 'https://cdn.example.com']);
  });

  it('dedupes extraDirectives sources against existing values', () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes, {
      extraDirectives: new Map([['font-src', ["'self'", 'https://fonts.gstatic.com']]]),
    });
    // 'self' should not be duplicated
    expect(directives['font-src']!.filter((s) => s === "'self'").length).toBe(1);
    expect(directives['font-src']).toContain('https://fonts.gstatic.com');
  });

  it('omits extra directives when extraDirectives is not provided', () => {
    const hashes = {
      scriptElem: new Set<string>(),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes);
    expect(directives['connect-src']).toBeUndefined();
    expect(directives['frame-src']).toBeUndefined();
  });

  it('merges extra directive sources and dedupes against scanned hashes', () => {
    const scanHash = sha256('inline');
    const hashes = {
      scriptElem: new Set<string>([scanHash]),
      styleElem: new Set<string>(),
      styleAttr: new Set<string>(),
      scriptAttr: new Set<string>(),
    };
    const directives = buildStaticPolicy(hashes, {
      extraDirectives: new Map([['script-src-elem', [scanHash, "'sha256-extra='"]]]),
    });
    const sources = directives['script-src-elem'];
    // extra hash that was already scanned is not duplicated
    expect(sources.filter((s) => s === scanHash).length).toBe(1);
    expect(sources).toContain("'sha256-extra='");
    expect(sources).toContain("'self'");
  });
});

describe('injectCspMeta', () => {
  it('inserts a meta tag directly after the opening <head>', () => {
    const html = `<html><head><title>x</title></head></html>`;
    const out = injectCspMeta(html, "default-src 'self'");
    expect(out).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"><title>x</title>`,
    );
  });

  it('removes any existing CSP meta tag before injecting (idempotent)', () => {
    const html =
      `<html><head><meta http-equiv="Content-Security-Policy" content="old-policy"><title>x</title></head></html>`;
    const out = injectCspMeta(html, "default-src 'self'");
    expect(out).not.toContain('old-policy');
    // And only one meta tag remains
    const matches = out.match(/http-equiv="Content-Security-Policy"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('escapes double quotes in the policy string', () => {
    const html = `<html><head></head></html>`;
    const out = injectCspMeta(html, 'x "y"');
    expect(out).toContain('content="x &quot;y&quot;"');
  });

  it('preserves attributes on the existing <head> tag', () => {
    const html = `<html><head lang="en"></head></html>`;
    const out = injectCspMeta(html, 'p');
    expect(out).toContain('<head lang="en"><meta');
  });
});
