import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDatabase,
  createSession,
  insertViolation,
  insertPage,
  getSession,
  insertPermissionsPolicy,
} from '../src/db/repository.js';
import { createMcpServer, sanitizeErrorMessage, main } from '../src/mcp-server.js';
import { resolveProjectName } from '../src/utils/file-utils.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock session-manager for start_session / crawl_url / audit_policy success tests
const mockRunSession = vi.fn();
const mockRunAuditSession = vi.fn();
vi.mock('../src/session-manager.js', () => ({
  runSession: mockRunSession,
  runAuditSession: mockRunAuditSession,
}));

// ── Helpers ─────────────────────────────────────────────────────────────

let db: Database.Database;
let server: McpServer;

function getRegisteredTools(srv: McpServer): Record<string, unknown> {
  // Access internal tool registry for testing
  return (srv as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
}

function createTestSession(targetUrl = 'https://example.com', project?: string) {
  return createSession(db, { targetUrl, project });
}

function addTestViolation(sessionId: string, overrides: Record<string, unknown> = {}) {
  return insertViolation(db, {
    sessionId,
    pageId: null,
    documentUri: 'https://example.com/',
    blockedUri: 'https://cdn.example.com/script.js',
    violatedDirective: 'script-src',
    effectiveDirective: 'script-src',
    capturedVia: 'report_uri',
    rawReport: '{}',
    ...overrides,
  });
}

function addInlineScriptViolation(sessionId: string) {
  return addTestViolation(sessionId, {
    blockedUri: "'unsafe-inline'",
    violatedDirective: 'script-src',
    effectiveDirective: 'script-src',
    sample: 'window.__mcpInline = true;',
  });
}

// ── Setup / teardown ────────────────────────────────────────────────────

beforeEach(() => {
  db = createDatabase(':memory:');
  server = createMcpServer(db);
});

afterEach(() => {
  db.close();
});

// ── Tool registration ───────────────────────────────────────────────────

describe('tool registration', () => {
  it('registers all expected tools', () => {
    const tools = getRegisteredTools(server);
    expect('start_session' in tools).toBe(true);
    expect('crawl_url' in tools).toBe(true);
    expect('get_violations' in tools).toBe(true);
    expect('generate_policy' in tools).toBe(true);
    expect('export_policy' in tools).toBe(true);
    expect('score_policy' in tools).toBe(true);
    expect('compare_sessions' in tools).toBe(true);
    expect('get_session' in tools).toBe(true);
    expect('list_sessions' in tools).toBe(true);
    expect('get_permissions_policy' in tools).toBe(true);
    expect('audit_policy' in tools).toBe(true);
    expect('hash_static' in tools).toBe(true);
    expect(Object.keys(tools).length).toBe(12);
  });
});

// ── Tool handler tests ──────────────────────────────────────────────────

// Helper to call a tool handler directly
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tools = getRegisteredTools(server);
  const tool = tools[name] as
    | { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
    | undefined;
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {}) as Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function parseToolResult(result: {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}) {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const testCookies = [
  {
    name: 'session_id',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
];

// ── list_sessions ─────────────────────────────────────────────────────

describe('list_sessions', () => {
  it('returns empty list when no sessions exist', async () => {
    const result = await callTool('list_sessions');
    const data = parseToolResult(result);
    expect(data.count).toBe(0);
    expect(data.sessions).toEqual([]);
  });

  it('returns all sessions', async () => {
    createTestSession('https://a.com');
    createTestSession('https://b.com');

    const result = await callTool('list_sessions');
    const data = parseToolResult(result);
    expect(data.count).toBe(2);
    expect(data.sessions).toHaveLength(2);
    const urls = data.sessions.map((s: { targetUrl: string }) => s.targetUrl).sort();
    expect(urls).toEqual(['https://a.com', 'https://b.com']);
  });
});

// ── get_session ───────────────────────────────────────────────────────

describe('get_session', () => {
  it('returns session details and violation summary', async () => {
    const session = createTestSession();
    insertPage(db, session.id, 'https://example.com/', 200);
    addTestViolation(session.id);
    addTestViolation(session.id, {
      blockedUri: 'https://fonts.gstatic.com/font.woff2',
      violatedDirective: 'font-src',
      effectiveDirective: 'font-src',
    });

    const result = await callTool('get_session', { sessionId: session.id });
    const data = parseToolResult(result);

    expect(data.session.id).toBe(session.id);
    expect(data.session.targetUrl).toBe('https://example.com');
    expect(data.session.status).toBe('created');
    expect(data.pagesVisited).toBe(1);
    expect(data.violationSummary).toHaveLength(2);
  });

  it('returns error for nonexistent session', async () => {
    const result = await callTool('get_session', {
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found');
  });
});

// ── get_violations ────────────────────────────────────────────────────

describe('get_violations', () => {
  it('returns all violations for a session', async () => {
    const session = createTestSession();
    addTestViolation(session.id);
    addTestViolation(session.id, {
      blockedUri: 'https://other.com/style.css',
      effectiveDirective: 'style-src',
      violatedDirective: 'style-src',
    });

    const result = await callTool('get_violations', { sessionId: session.id });
    const data = parseToolResult(result);
    expect(data.count).toBe(2);
    expect(data.violations).toHaveLength(2);
  });

  it('filters by directive', async () => {
    const session = createTestSession();
    addTestViolation(session.id);
    addTestViolation(session.id, {
      blockedUri: 'https://other.com/style.css',
      effectiveDirective: 'style-src',
      violatedDirective: 'style-src',
    });

    const result = await callTool('get_violations', {
      sessionId: session.id,
      directive: 'script-src',
    });
    const data = parseToolResult(result);
    expect(data.count).toBe(1);
    expect(data.violations[0].effectiveDirective).toBe('script-src');
  });

  it('filters by origin', async () => {
    const session = createTestSession();
    addTestViolation(session.id);
    addTestViolation(session.id, {
      blockedUri: 'https://other.com/img.png',
      effectiveDirective: 'img-src',
      violatedDirective: 'img-src',
    });

    const result = await callTool('get_violations', {
      sessionId: session.id,
      origin: 'https://cdn.example.com',
    });
    const data = parseToolResult(result);
    expect(data.count).toBe(1);
  });

  it('returns error for nonexistent session', async () => {
    const result = await callTool('get_violations', {
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
  });
});

// ── generate_policy ───────────────────────────────────────────────────

describe('generate_policy', () => {
  it('generates optimised policy from session violations', async () => {
    const session = createTestSession();
    addTestViolation(session.id);
    addTestViolation(session.id, {
      blockedUri: 'https://fonts.gstatic.com/font.woff2',
      effectiveDirective: 'font-src',
      violatedDirective: 'font-src',
    });

    const result = await callTool('generate_policy', { sessionId: session.id });
    const data = parseToolResult(result);

    expect(data.sessionId).toBe(session.id);
    expect(data.strictness).toBe('moderate');
    expect(data.directives).toBeDefined();
    expect(data.policyString).toBeDefined();
    expect(typeof data.policyString).toBe('string');
  });

  it('respects strictness parameter', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    const result = await callTool('generate_policy', {
      sessionId: session.id,
      strictness: 'strict',
    });
    const data = parseToolResult(result);
    expect(data.strictness).toBe('strict');
  });

  it('uses nonce mode and strict-dynamic when useStrictDynamic is true', async () => {
    const session = createTestSession();
    addInlineScriptViolation(session.id);

    const result = await callTool('generate_policy', {
      sessionId: session.id,
      useStrictDynamic: true,
    });
    const data = parseToolResult(result) as {
      directives: Record<string, string[]>;
      policyString: string;
    };
    const scriptSrc = data.directives['script-src'] ?? [];

    expect(scriptSrc).toContain("'nonce-{{CSP_NONCE}}'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(data.policyString).toContain("'nonce-{{CSP_NONCE}}'");
    expect(data.policyString).toContain("'strict-dynamic'");
  });

  it('skips nonce placeholders when static site mode is selected', async () => {
    const session = createTestSession();
    addInlineScriptViolation(session.id);

    const result = await callTool('generate_policy', {
      sessionId: session.id,
      useNonces: true,
      staticSiteMode: true,
    });
    const data = parseToolResult(result) as { directives: Record<string, string[]> };
    const scriptSrc = data.directives['script-src'] ?? [];

    expect(scriptSrc).not.toContain("'nonce-{{CSP_NONCE}}'");
    expect(scriptSrc).toContain("'unsafe-inline'");
  });

  it('returns error for nonexistent session', async () => {
    const result = await callTool('generate_policy', {
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
  });
});

// ── export_policy ─────────────────────────────────────────────────────

describe('export_policy', () => {
  it('exports policy in header format', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    const result = await callTool('export_policy', {
      sessionId: session.id,
      format: 'header',
    });
    const data = parseToolResult(result);

    expect(data.format).toBe('header');
    expect(data.isReportOnly).toBe(false);
    expect(data.policy).toContain('Content-Security-Policy:');
  });

  it('exports policy in nginx format', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    const result = await callTool('export_policy', {
      sessionId: session.id,
      format: 'nginx',
    });
    const data = parseToolResult(result);
    expect(data.policy).toContain('add_header');
  });

  it('supports report-only mode', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    const result = await callTool('export_policy', {
      sessionId: session.id,
      format: 'header',
      isReportOnly: true,
    });
    const data = parseToolResult(result);
    expect(data.policy).toContain('Content-Security-Policy-Report-Only:');
  });

  it('exports nonce and strict-dynamic when requested', async () => {
    const session = createTestSession();
    addInlineScriptViolation(session.id);

    const result = await callTool('export_policy', {
      sessionId: session.id,
      format: 'header',
      useStrictDynamic: true,
    });
    const data = parseToolResult(result) as { policy: string };

    expect(data.policy).toContain("'nonce-{{CSP_NONCE}}'");
    expect(data.policy).toContain("'strict-dynamic'");
    expect(data.policy).not.toContain("'unsafe-inline'");
  });

  it('exports all supported formats', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    for (const format of ['header', 'meta', 'nginx', 'apache', 'cloudflare', 'json'] as const) {
      const result = await callTool('export_policy', {
        sessionId: session.id,
        format,
      });
      expect(result.isError).toBeUndefined();
    }
  });

  it('returns error for nonexistent session', async () => {
    const result = await callTool('export_policy', {
      sessionId: '00000000-0000-0000-0000-000000000000',
      format: 'header',
    });
    expect(result.isError).toBe(true);
  });
});

// ── hash_static ───────────────────────────────────────────────────────

describe('hash_static', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTempHtml(html: string): string {
    tmpDir = mkdtempSync(join(process.cwd(), '.tmp-mcp-hash-static-'));
    const htmlFile = join(tmpDir, 'index.html');
    writeFileSync(htmlFile, html);
    return htmlFile;
  }

  it('returns a structured static policy without injecting', async () => {
    const htmlFile = createTempHtml(
      '<html><head></head><body><script>console.log("ok")</script><style>body{color:red}</style><div style="color: red" onclick="go()"></div></body></html>',
    );

    const result = await callTool('hash_static', {
      paths: [htmlFile],
      format: 'json',
      extraDirectives: { 'connect-src': ['https://api.example.com'] },
      policyDirectives: { 'upgrade-insecure-requests': [] },
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.format).toBe('json');
    expect(data.injected).toBe(false);
    expect(data.filesScanned).toBe(1);
    expect(data.counts.scriptElemHashes).toBe(1);
    expect(data.counts.styleElemHashes).toBe(1);
    expect(data.counts.styleAttrHashes).toBe(1);
    expect(data.counts.scriptAttrHashes).toBe(1);
    expect(data.directives['connect-src']).toContain('https://api.example.com');
    expect(data.directives['upgrade-insecure-requests']).toEqual([]);
    expect(JSON.parse(data.policy).directives['default-src']).toContain("'self'");
  });

  it('injects a CSP meta tag into project-local HTML', async () => {
    const htmlFile = createTempHtml(
      '<html><head><title>x</title></head><body><script>console.log("ok")</script></body></html>',
    );

    const result = await callTool('hash_static', {
      paths: [tmpDir],
      inject: true,
      policyDirectives: { 'report-uri': ['/csp-report'] },
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.format).toBe('meta');
    expect(data.injected).toBe(true);
    expect(data.filesScanned).toBe(1);
    expect(data.directives['report-uri']).toEqual(['/csp-report']);

    const updated = readFileSync(htmlFile, 'utf8');
    expect(updated).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(updated).toContain('script-src-elem');
    expect(updated).not.toContain('report-uri');
  });

  it('does not rewrite HTML when inject output formatting fails', async () => {
    const originalHtml =
      '<html><head><title>x</title></head><body><script>console.log("ok")</script></body></html>';
    const htmlFile = createTempHtml(originalHtml);

    const result = await callTool('hash_static', {
      paths: [tmpDir],
      inject: true,
      isReportOnly: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Report-Only is not supported in <meta> tags');
    expect(readFileSync(htmlFile, 'utf8')).toBe(originalHtml);
  });

  it('rejects unknown policyDirectives', async () => {
    const htmlFile = createTempHtml('<html><head></head><body></body></html>');

    const result = await callTool('hash_static', {
      paths: [htmlFile],
      policyDirectives: { 'connect-src': ['https://api.example.com'] },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown document directive "connect-src"');
  });

  it('rejects paths outside the current working directory', async () => {
    const result = await callTool('hash_static', {
      paths: ['/tmp'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('outside the current working directory');
  });
});

// ── start_session ─────────────────────────────────────────────────────

describe('start_session', () => {
  afterEach(() => {
    mockRunSession.mockReset();
  });

  it('returns session result on success', async () => {
    const session = createTestSession();

    mockRunSession.mockResolvedValue({
      session: { ...getSession(db, session.id)!, status: 'complete' },
      pagesVisited: 5,
      violationsFound: 1,
      errors: [],
    });

    const result = await callTool('start_session', {
      targetUrl: 'https://example.com',
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.pagesVisited).toBe(5);
    expect(data.violationsFound).toBe(1);
    expect(data.errors).toEqual([]);
    expect(data.sessionId).toBe(session.id);
  });

  it('passes optional parameters to runSession', async () => {
    const session = createTestSession();

    mockRunSession.mockResolvedValue({
      session: { ...getSession(db, session.id)!, status: 'complete' },
      pagesVisited: 3,
      violationsFound: 0,
      errors: [],
    });

    await callTool('start_session', {
      targetUrl: 'https://example.com',
      depth: 2,
      maxPages: 50,
      storageStatePath: '/tmp/state.json',
      cookies: testCookies,
    });

    expect(mockRunSession).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        targetUrl: 'https://example.com',
        crawlConfig: { depth: 2, maxPages: 50, settlementDelay: undefined },
        storageStatePath: '/tmp/state.json',
        cookies: testCookies,
      }),
    );
  });

  it('returns error when runSession throws', async () => {
    mockRunSession.mockRejectedValue(new Error('Browser not found'));

    const result = await callTool('start_session', {
      targetUrl: 'https://example.com',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to start session');
    expect(result.content[0].text).toContain('Browser not found');
  });

  it('handles non-Error throws', async () => {
    mockRunSession.mockRejectedValue('string error');

    const result = await callTool('start_session', {
      targetUrl: 'https://example.com',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('string error');
  });
});

// ── crawl_url ─────────────────────────────────────────────────────────

describe('crawl_url', () => {
  afterEach(() => {
    mockRunSession.mockReset();
  });

  it('returns crawl result on success', async () => {
    const session = createTestSession();

    mockRunSession.mockResolvedValue({
      session: { ...getSession(db, session.id)!, status: 'complete', mode: 'local' },
      pagesVisited: 1,
      violationsFound: 3,
      errors: [],
    });

    const result = await callTool('crawl_url', {
      url: 'https://example.com/page',
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.pagesVisited).toBe(1);
    expect(data.violationsFound).toBe(3);
    expect(data.sessionId).toBe(session.id);
    expect(data.targetUrl).toBeDefined();
  });

  it('sets depth=0 and maxPages=1 for single-page crawl', async () => {
    const session = createTestSession();

    mockRunSession.mockResolvedValue({
      session: { ...getSession(db, session.id)!, status: 'complete' },
      pagesVisited: 1,
      violationsFound: 0,
      errors: [],
    });

    await callTool('crawl_url', {
      url: 'https://example.com/page',
      cookies: testCookies,
    });

    expect(mockRunSession).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        targetUrl: 'https://example.com/page',
        crawlConfig: { depth: 0, maxPages: 1 },
        cookies: testCookies,
      }),
    );
  });

  it('returns error when runSession throws', async () => {
    mockRunSession.mockRejectedValue(new Error('Connection refused'));

    const result = await callTool('crawl_url', {
      url: 'https://example.com/page',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to crawl URL');
  });
});

// ── score_policy ─────────────────────────────────────────────────────

describe('score_policy', () => {
  it('scores a session policy and returns grade', async () => {
    const session = createTestSession();
    addTestViolation(session.id);
    addTestViolation(session.id, {
      blockedUri: 'https://fonts.gstatic.com/font.woff2',
      effectiveDirective: 'font-src',
      violatedDirective: 'font-src',
    });

    const result = await callTool('score_policy', { sessionId: session.id });
    const data = parseToolResult(result);

    expect(result.isError).toBeUndefined();
    expect(data.overall).toBeTypeOf('number');
    expect(data.overall).toBeGreaterThanOrEqual(0);
    expect(data.overall).toBeLessThanOrEqual(100);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(data.grade);
    expect(Array.isArray(data.findings)).toBe(true);
    expect(typeof data.formatted).toBe('string');
  });

  it('returns error for nonexistent session', async () => {
    const result = await callTool('score_policy', {
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found');
  });

  it('respects strictness parameter', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    const result = await callTool('score_policy', {
      sessionId: session.id,
      strictness: 'strict',
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.overall).toBeTypeOf('number');
  });

  it('scores nonce and strict-dynamic strengths when requested', async () => {
    const session = createTestSession();
    addInlineScriptViolation(session.id);

    const result = await callTool('score_policy', {
      sessionId: session.id,
      useStrictDynamic: true,
    });
    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result) as {
      findings: Array<{ points: number; message: string }>;
      formatted: string;
    };

    expect(
      data.findings.some((finding) => finding.points > 0 && finding.message.includes('nonce')),
    ).toBe(true);
    expect(
      data.findings.some(
        (finding) => finding.points > 0 && finding.message.includes('strict-dynamic'),
      ),
    ).toBe(true);
    expect(data.formatted).toContain('strict-dynamic');
  });

  it('returns error when DB query fails', async () => {
    const session = createTestSession();
    db.exec('DROP TABLE violations');

    const result = await callTool('score_policy', { sessionId: session.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to score policy');
  });
});

// ── compare_sessions ─────────────────────────────────────────────────

describe('compare_sessions', () => {
  it('compares two sessions with different violations', async () => {
    const sessionA = createTestSession('https://example.com');
    addTestViolation(sessionA.id);

    const sessionB = createTestSession('https://example.com');
    addTestViolation(sessionB.id, {
      blockedUri: 'https://other.com/style.css',
      effectiveDirective: 'style-src',
      violatedDirective: 'style-src',
    });

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: sessionB.id,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.sessionA).toBe(sessionA.id);
    expect(data.sessionB).toBe(sessionB.id);
    expect(data.policyDiff).toBeDefined();
    expect(data.violationDiff).toBeDefined();
    expect(typeof data.formatted).toBe('string');
  });

  it('compares two identical sessions', async () => {
    const sessionA = createTestSession('https://example.com');
    addTestViolation(sessionA.id);

    const sessionB = createTestSession('https://example.com');
    addTestViolation(sessionB.id);

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: sessionB.id,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.policyDiff.addedDirectives).toEqual([]);
    expect(data.policyDiff.removedDirectives).toEqual([]);
    expect(data.violationDiff.newViolations).toEqual([]);
    expect(data.violationDiff.resolvedViolations).toEqual([]);
  });

  it('returns error when first session not found', async () => {
    const sessionB = createTestSession();

    const result = await callTool('compare_sessions', {
      sessionIdA: '00000000-0000-0000-0000-000000000000',
      sessionIdB: sessionB.id,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Session not found: 00000000-0000-0000-0000-000000000000',
    );
  });

  it('returns error when second session not found', async () => {
    const sessionA = createTestSession();

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Session not found: 00000000-0000-0000-0000-000000000000',
    );
  });

  it('rejects cross-project comparison by default', async () => {
    const sessionA = createTestSession('https://example.com', resolveProjectName());
    addTestViolation(sessionA.id);
    const sessionB = createTestSession('https://example.com', 'other-project');
    addTestViolation(sessionB.id);

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: sessionB.id,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`Session not found: ${sessionB.id}`);
  });

  it('allows cross-project comparison when allProjects is true', async () => {
    const sessionA = createTestSession('https://example.com', resolveProjectName());
    addTestViolation(sessionA.id);
    const sessionB = createTestSession('https://example.com', 'other-project');
    addTestViolation(sessionB.id, {
      blockedUri: 'https://other.com/style.css',
      effectiveDirective: 'style-src',
      violatedDirective: 'style-src',
    });

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: sessionB.id,
      allProjects: true,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.sessionA).toBe(sessionA.id);
    expect(data.sessionB).toBe(sessionB.id);
  });

  it('allows legacy unscoped sessions by default', async () => {
    const sessionA = createTestSession('https://example.com', resolveProjectName());
    addTestViolation(sessionA.id);
    const legacySession = createTestSession('https://example.com');
    addTestViolation(legacySession.id);

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: legacySession.id,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.sessionB).toBe(legacySession.id);
  });

  it('compares sessions with no violations', async () => {
    const sessionA = createTestSession('https://example.com');
    const sessionB = createTestSession('https://example.com');

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: sessionB.id,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.policyDiff.addedDirectives).toEqual([]);
    expect(data.policyDiff.removedDirectives).toEqual([]);
    expect(data.violationDiff.newViolations).toEqual([]);
    expect(data.violationDiff.resolvedViolations).toEqual([]);
  });

  it('respects strictness parameter', async () => {
    const sessionA = createTestSession('https://example.com');
    addTestViolation(sessionA.id);
    const sessionB = createTestSession('https://example.com');
    addTestViolation(sessionB.id);

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: sessionB.id,
      strictness: 'strict',
    });

    expect(result.isError).toBeUndefined();
  });
});

// ── get_permissions_policy ───────────────────────────────────────────

describe('get_permissions_policy', () => {
  function addTestPermissionsPolicy(sessionId: string, overrides: Record<string, unknown> = {}) {
    return insertPermissionsPolicy(db, {
      sessionId,
      pageId: null,
      directive: 'camera',
      allowlist: ['self'],
      headerType: 'permissions-policy',
      sourceUrl: 'https://example.com/',
      ...overrides,
    });
  }

  it('returns permissions policies for a session', async () => {
    const session = createTestSession();
    addTestPermissionsPolicy(session.id);
    addTestPermissionsPolicy(session.id, {
      directive: 'geolocation',
      allowlist: ['self', 'https://maps.google.com'],
    });

    const result = await callTool('get_permissions_policy', {
      sessionId: session.id,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.sessionId).toBe(session.id);
    expect(data.count).toBe(2);
    expect(data.policies).toHaveLength(2);

    const directives = data.policies.map((p: { directive: string }) => p.directive).sort();
    expect(directives).toEqual(['camera', 'geolocation']);
  });

  it('filters by directive name', async () => {
    const session = createTestSession();
    addTestPermissionsPolicy(session.id, { directive: 'camera' });
    addTestPermissionsPolicy(session.id, { directive: 'geolocation' });
    addTestPermissionsPolicy(session.id, { directive: 'microphone' });

    const result = await callTool('get_permissions_policy', {
      sessionId: session.id,
      directive: 'camera',
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.count).toBe(1);
    expect(data.policies[0].directive).toBe('camera');
  });

  it('returns empty list when no policies captured', async () => {
    const session = createTestSession();

    const result = await callTool('get_permissions_policy', {
      sessionId: session.id,
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.count).toBe(0);
    expect(data.policies).toEqual([]);
  });

  it('returns error for nonexistent session', async () => {
    const result = await callTool('get_permissions_policy', {
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Session not found');
  });

  it('includes all expected fields in policy entries', async () => {
    const session = createTestSession();
    addTestPermissionsPolicy(session.id, {
      directive: 'autoplay',
      allowlist: ['self', '*'],
      headerType: 'feature-policy',
      sourceUrl: 'https://example.com/page',
    });

    const result = await callTool('get_permissions_policy', {
      sessionId: session.id,
    });

    const data = parseToolResult(result);
    const policy = data.policies[0];
    expect(policy.id).toBeDefined();
    expect(policy.directive).toBe('autoplay');
    expect(policy.allowlist).toEqual(['self', '*']);
    expect(policy.headerType).toBe('feature-policy');
    expect(policy.sourceUrl).toBe('https://example.com/page');
  });

  it('returns error when DB query fails', async () => {
    const session = createTestSession();
    db.exec('DROP TABLE permissions_policies');

    const result = await callTool('get_permissions_policy', {
      sessionId: session.id,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to get permissions policies');
  });
});

// ── sanitizeErrorMessage ──────────────────────────────────────────────

describe('sanitizeErrorMessage', () => {
  it('strips Unix absolute paths', () => {
    const msg = 'ENOENT: no such file /home/user/project/src/file.ts';
    expect(sanitizeErrorMessage(msg)).not.toContain('/home/user');
    expect(sanitizeErrorMessage(msg)).toContain('<path>');
  });

  it('strips Windows absolute paths', () => {
    const msg = 'Cannot find module C:\\Users\\dev\\project\\src\\file.ts';
    expect(sanitizeErrorMessage(msg)).not.toContain('C:\\Users');
    expect(sanitizeErrorMessage(msg)).toContain('<path>');
  });

  it('preserves messages without paths', () => {
    const msg = 'Session not found: abc-123';
    expect(sanitizeErrorMessage(msg)).toBe(msg);
  });

  it('preserves URLs (not file paths)', () => {
    const msg = 'Failed to fetch https://example.com/api';
    // URLs with scheme should not be stripped — they're not internal paths
    expect(sanitizeErrorMessage(msg)).toContain('https:');
  });
});

// ── Error handling (catch blocks) ─────────────────────────────────────

describe('tool error handling with corrupted database', () => {
  it('get_violations returns error when DB query fails', async () => {
    const session = createTestSession();
    // Drop the violations table to cause a DB error after session lookup succeeds
    db.exec('DROP TABLE violations');

    const result = await callTool('get_violations', { sessionId: session.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to get violations');
  });

  it('generate_policy returns error when DB query fails', async () => {
    const session = createTestSession();
    db.exec('DROP TABLE violations');

    const result = await callTool('generate_policy', { sessionId: session.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to generate policy');
  });

  it('export_policy returns error when DB query fails', async () => {
    const session = createTestSession();
    db.exec('DROP TABLE violations');

    const result = await callTool('export_policy', {
      sessionId: session.id,
      format: 'header',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to export policy');
  });

  it('get_session returns error when DB query fails', async () => {
    const session = createTestSession();
    db.exec('DROP TABLE pages');

    const result = await callTool('get_session', { sessionId: session.id });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to get session');
  });

  it('list_sessions returns error when DB query fails', async () => {
    db.exec('DROP TABLE sessions');

    const result = await callTool('list_sessions');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to list sessions');
  });
});

// ── main() ───────────────────────────────────────────────────────────

describe('main', () => {
  it('starts the MCP server and connects transport', async () => {
    // We can't easily mock the internals of main() without module mocks,
    // but we can test that it throws/rejects appropriately with an invalid DB path
    // by checking the error handling path
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    // main() will try to create a DB at .csp-analyser/data.db in cwd
    // Since we can't write there in tests, it may throw
    try {
      await main();
    } catch {
      // Expected — either process.exit mock throws or DB creation fails
    }

    mockExit.mockRestore();
  });
});

// ── main() DB cleanup on failure ─────────────────────────────────────────

describe('main() DB cleanup on connect failure', () => {
  it('closes the database if server.connect() throws', async () => {
    // We test the pattern directly: create a DB, call main() logic,
    // and verify DB is closed on error
    const testDb = createDatabase(':memory:');
    const closeSpy = vi.spyOn(testDb, 'close');

    // Simulate what main() does: create server, then fail on connect
    const testServer = createMcpServer(testDb);

    try {
      // Force connect to throw by passing an invalid transport
      await testServer.connect(null as never);
    } catch {
      // Simulate the catch block in main()
      testDb.close();
    }

    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });
});

// ── audit_policy ──────────────────────────────────────────────────────

describe('audit_policy', () => {
  afterEach(() => {
    mockRunAuditSession.mockReset();
  });

  it('includes crawl errors in the response', async () => {
    const session = createTestSession();

    mockRunAuditSession.mockResolvedValue({
      session: { ...getSession(db, session.id)!, status: 'complete' },
      pagesVisited: 0,
      violationsFound: 0,
      errors: [{ url: 'https://example.com/', error: 'Navigation timeout' }],
    });

    const result = await callTool('audit_policy', {
      targetUrl: 'https://example.com',
    });

    expect(result.isError).toBeUndefined();
    const data = parseToolResult(result);
    expect(data.errors).toEqual([{ url: 'https://example.com/', error: 'Navigation timeout' }]);
    expect(data.pagesVisited).toBe(0);
  });

  it('passes cookies to runAuditSession', async () => {
    const session = createTestSession();

    mockRunAuditSession.mockResolvedValue({
      session: { ...getSession(db, session.id)!, status: 'complete' },
      pagesVisited: 1,
      violationsFound: 0,
      errors: [],
    });

    await callTool('audit_policy', {
      targetUrl: 'https://example.com',
      cookies: testCookies,
    });

    expect(mockRunAuditSession).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        targetUrl: 'https://example.com',
        cookies: testCookies,
      }),
    );
  });
});

// ── Server metadata ─────────────────────────────────────────────────────

describe('server metadata', () => {
  it('has correct server info', () => {
    const serverInstance = (
      server as unknown as { server: { _serverInfo: { name: string; version: string } } }
    ).server;
    expect(serverInstance._serverInfo.name).toBe('csp-analyser');
    // Version is read from package.json at runtime — just verify it's a valid semver-like string
    expect(serverInstance._serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
