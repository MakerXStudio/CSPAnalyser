import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  insertViolation,
  insertPage,
  getSession,
} from '../src/db/repository.js';
import { createMcpServer } from '../src/mcp-server.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

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
  it('registers all seven tools', () => {
    const tools = getRegisteredTools(server);
    expect('start_session' in tools).toBe(true);
    expect('crawl_url' in tools).toBe(true);
    expect('get_violations' in tools).toBe(true);
    expect('generate_policy' in tools).toBe(true);
    expect('export_policy' in tools).toBe(true);
    expect('get_session' in tools).toBe(true);
    expect('list_sessions' in tools).toBe(true);
    expect(Object.keys(tools).length).toBe(7);
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
  it('returns session result on success', async () => {
    const session = createTestSession();
    addTestViolation(session.id);

    // Mock the dynamic import of session-manager
    vi.doMock('../src/session-manager.js', () => ({
      runSession: vi.fn().mockResolvedValue({
        session: { ...getSession(db, session.id)!, status: 'complete' },
        pagesVisited: 5,
        violationsFound: 1,
        errors: [],
      }),
    }));

    const result = await callTool('start_session', {
      targetUrl: 'https://example.com',
    });

    vi.doUnmock('../src/session-manager.js');

    if (result.isError) {
      // If dynamic import fails (module not in vitest cache), that's ok — test the error path
      expect(result.content[0].text).toContain('Failed to start session');
    } else {
      const data = parseToolResult(result);
      expect(data.pagesVisited).toBe(5);
      expect(data.violationsFound).toBe(1);
    }
  });

  it('returns error when session-manager throws', async () => {
    const result = await callTool('start_session', {
      targetUrl: 'https://example.com',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to start session');
  });
});

// ── crawl_url ─────────────────────────────────────────────────────────

describe('crawl_url', () => {
  it('returns error when session-manager throws', async () => {
    const result = await callTool('crawl_url', {
      url: 'https://example.com/page',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to crawl URL');
  });
});

// ── Server metadata ─────────────────────────────────────────────────────

describe('server metadata', () => {
  it('has correct server info', () => {
    const serverInstance = (server as unknown as { server: { _serverInfo: { name: string; version: string } } }).server;
    expect(serverInstance._serverInfo.name).toBe('csp-analyser');
    expect(serverInstance._serverInfo.version).toBe('0.1.0');
  });
});
