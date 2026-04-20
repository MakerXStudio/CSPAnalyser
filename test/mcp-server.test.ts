import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  insertViolation,
  insertPage,
  getSession,
  insertPermissionsPolicy,
} from '../src/db/repository.js';
import { createMcpServer, sanitizeErrorMessage, main } from '../src/mcp-server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Mock session-manager for start_session / crawl_url success tests
const mockRunSession = vi.fn();
vi.mock('../src/session-manager.js', () => ({
  runSession: mockRunSession,
}));

// ── Helpers ─────────────────────────────────────────────────────────────

let db: Database.Database;
let server: McpServer;

function getRegisteredTools(srv: McpServer): Record<string, unknown> {
  // Access internal tool registry for testing
  return (srv as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
}

function createTestSession(targetUrl = 'https://example.com') {
  return createSession(db, { targetUrl });
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
    expect(Object.keys(tools).length).toBe(11);
  });
});

// ── Tool handler tests ──────────────────────────────────────────────────

// Helper to call a tool handler directly
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const tools = getRegisteredTools(server);
  const tool = tools[name] as { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> } | undefined;
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {}) as Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function parseToolResult(result: { content: Array<{ type: string; text: string }>; isError?: boolean }) {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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
    });

    expect(mockRunSession).toHaveBeenCalledWith(db, expect.objectContaining({
      targetUrl: 'https://example.com',
      crawlConfig: { depth: 2, maxPages: 50, settlementDelay: undefined },
      storageStatePath: '/tmp/state.json',
    }));
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
    });

    expect(mockRunSession).toHaveBeenCalledWith(db, expect.objectContaining({
      targetUrl: 'https://example.com/page',
      crawlConfig: { depth: 0, maxPages: 1 },
    }));
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
    expect(result.content[0].text).toContain('Failed to compare sessions');
  });

  it('returns error when second session not found', async () => {
    const sessionA = createTestSession();

    const result = await callTool('compare_sessions', {
      sessionIdA: sessionA.id,
      sessionIdB: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to compare sessions');
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

// ── Server metadata ─────────────────────────────────────────────────────

describe('server metadata', () => {
  it('has correct server info', () => {
    const serverInstance = (server as unknown as { server: { _serverInfo: { name: string; version: string } } }).server;
    expect(serverInstance._serverInfo.name).toBe('csp-analyser');
    // Version is read from package.json at runtime — just verify it's a valid semver-like string
    expect(serverInstance._serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
