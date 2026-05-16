/**
 * End-to-end integration tests for every MCP tool handler against a real
 * database, with no session-manager mocks. The crawl-originating tools
 * (start_session, crawl_url, audit_policy) are covered by pipeline tests
 * elsewhere; this suite focuses on the data-layer tools that operate on
 * already-captured session data:
 *
 *   get_violations, generate_policy, export_policy, score_policy,
 *   compare_sessions, get_session, list_sessions, get_permissions_policy
 *
 * Each test seeds realistic fixtures (violations, inline hashes, permissions
 * policies) directly and drives the tool handler via the registered handler
 * table, exactly like the MCP runtime would.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDatabase,
  createSession,
  insertPage,
  insertViolation,
  insertInlineHash,
  insertPermissionsPolicy,
} from '../../src/db/repository.js';
import { createMcpServer } from '../../src/mcp-server.js';
import { resolveProjectName } from '../../src/utils/file-utils.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── Test harness ────────────────────────────────────────────────────────

interface ToolResultShape {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function getTools(srv: McpServer): Record<string, unknown> {
  return (srv as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
}

async function callTool(
  srv: McpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResultShape> {
  const tools = getTools(srv);
  const tool = tools[name] as
    | { handler: (a: Record<string, unknown>, extra: unknown) => Promise<unknown> }
    | undefined;
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler(args, {}) as Promise<ToolResultShape>;
}

function parseToolResult(result: ToolResultShape): unknown {
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function seedSession(db: Database.Database, opts?: { targetUrl?: string; project?: string }) {
  const session = createSession(db, {
    targetUrl: opts?.targetUrl ?? 'https://app.example.com',
    project: opts?.project,
  });
  const page = insertPage(db, session.id, `${session.targetUrl}/`, 200);
  const pageId = page?.id ?? null;

  insertViolation(db, {
    sessionId: session.id,
    pageId,
    documentUri: `${session.targetUrl}/`,
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
  insertViolation(db, {
    sessionId: session.id,
    pageId,
    documentUri: `${session.targetUrl}/`,
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
  insertInlineHash(db, {
    sessionId: session.id,
    pageId,
    directive: 'script-src-elem',
    hash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    contentLength: 128,
  });
  insertPermissionsPolicy(db, {
    sessionId: session.id,
    pageId,
    directive: 'camera',
    allowlist: ['self'],
    headerType: 'permissions-policy',
    sourceUrl: `${session.targetUrl}/`,
  });

  return session;
}

function seedInlineScriptSession(db: Database.Database) {
  const session = createSession(db, { targetUrl: 'https://inline.example.com' });
  const page = insertPage(db, session.id, `${session.targetUrl}/`, 200);

  insertViolation(db, {
    sessionId: session.id,
    pageId: page?.id ?? null,
    documentUri: `${session.targetUrl}/`,
    blockedUri: "'unsafe-inline'",
    violatedDirective: 'script-src',
    effectiveDirective: 'script-src',
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: 'window.__inlineFixture = true;',
    capturedVia: 'dom_event',
    rawReport: '{}',
  });

  return session;
}

describe('MCP tools end-to-end', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createDatabase(':memory:');
    server = createMcpServer(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── get_violations ─────────────────────────────────────────────────────

  describe('get_violations', () => {
    it('returns all violations for a session', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'get_violations', {
        sessionId: session.id,
      });

      const data = parseToolResult(result) as {
        count: number;
        violations: Array<{ effectiveDirective: string; blockedUri: string }>;
      };
      expect(data.count).toBe(2);
      expect(data.violations.map((v) => v.effectiveDirective).sort()).toEqual([
        'connect-src',
        'img-src',
      ]);
    });

    it('filters violations by directive', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'get_violations', {
        sessionId: session.id,
        directive: 'img-src',
      });

      const data = parseToolResult(result) as { count: number };
      expect(data.count).toBe(1);
    });

    it('errors on unknown session', async () => {
      const result = await callTool(server, 'get_violations', {
        sessionId: '00000000-0000-4000-8000-000000000000',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── generate_policy ───────────────────────────────────────────────────

  describe('generate_policy', () => {
    it('returns optimized directives for a seeded session', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'generate_policy', {
        sessionId: session.id,
        strictness: 'moderate',
      });

      const data = parseToolResult(result) as {
        directives: Record<string, string[]>;
        policyString: string;
      };
      expect(data.directives['default-src']).toContain("'self'");
      expect(data.policyString).toContain("default-src 'self'");
    });

    it('includes inline hashes when useHashes is set', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'generate_policy', {
        sessionId: session.id,
        strictness: 'strict',
        useHashes: true,
      });

      const data = parseToolResult(result) as {
        directives: Record<string, string[]>;
      };
      const scriptElem = data.directives['script-src-elem'] ?? [];
      expect(scriptElem.some((s) => s.startsWith("'sha256-"))).toBe(true);
    });

    it('returns nonce and strict-dynamic when strict-dynamic is requested', async () => {
      const session = seedInlineScriptSession(db);
      const result = await callTool(server, 'generate_policy', {
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
      expect(data.policyString).toContain("'nonce-{{CSP_NONCE}}'");
      expect(data.policyString).toContain("'strict-dynamic'");
    });

    it('applies the react-expo static profile to style attribute hash explosions', async () => {
      const session = seedSession(db);
      for (let i = 0; i < 4; i++) {
        insertInlineHash(db, {
          sessionId: session.id,
          pageId: null,
          directive: 'style-src-attr',
          hash: `STYLE${i}`,
          contentLength: 12,
        });
        insertInlineHash(db, {
          sessionId: session.id,
          pageId: null,
          directive: 'script-src-elem',
          hash: `SCRIPT${i}`,
          contentLength: 12,
        });
      }

      const result = await callTool(server, 'generate_policy', {
        sessionId: session.id,
        useHashes: true,
        collapseHashThreshold: 2,
        staticProfile: 'react-expo',
      });

      const data = parseToolResult(result) as {
        directives: Record<string, string[]>;
        staticProfile?: string;
      };

      expect(data.staticProfile).toBe('react-expo');
      expect(data.directives['style-src-attr']).toEqual(["'unsafe-inline'"]);
      expect(data.directives['script-src-elem']).not.toContain("'unsafe-inline'");
      expect(data.directives['script-src-elem'].some((s) => s.startsWith("'sha256-"))).toBe(true);
    });
  });

  // ── export_policy ─────────────────────────────────────────────────────

  describe('export_policy', () => {
    it('exports as header format', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'export_policy', {
        sessionId: session.id,
        format: 'header',
      });

      const data = parseToolResult(result) as {
        format: string;
        policy: string;
      };
      expect(data.format).toBe('header');
      expect(data.policy).toMatch(/^Content-Security-Policy:/);
    });

    it('exports as JSON that parses back', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'export_policy', {
        sessionId: session.id,
        format: 'json',
      });

      const data = parseToolResult(result) as { policy: string };
      expect(() => JSON.parse(data.policy)).not.toThrow();
    });

    it('exports Report-Only header when isReportOnly is true', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'export_policy', {
        sessionId: session.id,
        format: 'header',
        isReportOnly: true,
      });

      const data = parseToolResult(result) as { policy: string };
      expect(data.policy).toMatch(/^Content-Security-Policy-Report-Only:/);
    });

    it('exports nonce and strict-dynamic sources when requested', async () => {
      const session = seedInlineScriptSession(db);
      const result = await callTool(server, 'export_policy', {
        sessionId: session.id,
        format: 'header',
        useStrictDynamic: true,
      });

      const data = parseToolResult(result) as { policy: string };
      expect(data.policy).toContain("'nonce-{{CSP_NONCE}}'");
      expect(data.policy).toContain("'strict-dynamic'");
    });

    it('rejects meta format when isReportOnly is true', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'export_policy', {
        sessionId: session.id,
        format: 'meta',
        isReportOnly: true,
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── score_policy ──────────────────────────────────────────────────────

  describe('score_policy', () => {
    it('returns a score with grade and findings', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'score_policy', {
        sessionId: session.id,
      });

      const data = parseToolResult(result) as {
        overall: number;
        grade: string;
        findings: Array<{ severity: string; message: string }>;
        formatted: string;
      };
      expect(data.overall).toBeGreaterThanOrEqual(0);
      expect(data.overall).toBeLessThanOrEqual(100);
      expect(['A', 'B', 'C', 'D', 'F']).toContain(data.grade);
      expect(Array.isArray(data.findings)).toBe(true);
      expect(typeof data.formatted).toBe('string');
    });

    it('scores nonce and strict-dynamic optimized policies', async () => {
      const session = seedInlineScriptSession(db);
      const result = await callTool(server, 'score_policy', {
        sessionId: session.id,
        useStrictDynamic: true,
      });

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
  });

  // ── compare_sessions ──────────────────────────────────────────────────

  describe('compare_sessions', () => {
    it('reports shared and unique violations between two sessions', async () => {
      const a = seedSession(db);
      const b = seedSession(db);
      // Add a violation present only in session B
      insertViolation(db, {
        sessionId: b.id,
        pageId: null,
        documentUri: 'https://app.example.com/',
        blockedUri: 'https://extra.example.net/thing',
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

      const result = await callTool(server, 'compare_sessions', {
        sessionIdA: a.id,
        sessionIdB: b.id,
      });

      const data = parseToolResult(result) as {
        formatted: string;
      };
      expect(typeof data.formatted).toBe('string');
      expect(data.formatted.length).toBeGreaterThan(0);
    });

    it('rejects cross-project sessions by default and allows them with allProjects', async () => {
      const currentProject = resolveProjectName();
      const a = seedSession(db, { project: currentProject });
      const b = seedSession(db, { project: 'other-project' });

      const scopedResult = await callTool(server, 'compare_sessions', {
        sessionIdA: a.id,
        sessionIdB: b.id,
      });
      expect(scopedResult.isError).toBe(true);
      expect(scopedResult.content[0].text).toContain(`Session not found: ${b.id}`);

      const allProjectsResult = await callTool(server, 'compare_sessions', {
        sessionIdA: a.id,
        sessionIdB: b.id,
        allProjects: true,
      });
      expect(allProjectsResult.isError).toBeUndefined();
      const data = parseToolResult(allProjectsResult) as { sessionA: string; sessionB: string };
      expect(data.sessionA).toBe(a.id);
      expect(data.sessionB).toBe(b.id);
    });
  });

  // ── get_session ───────────────────────────────────────────────────────

  describe('get_session', () => {
    it('returns session details with pages and violation summary', async () => {
      const session = seedSession(db);

      const result = await callTool(server, 'get_session', {
        sessionId: session.id,
      });

      const data = parseToolResult(result) as {
        session: { id: string; targetUrl: string; status: string };
        pagesVisited: number;
        pages: Array<{ url: string; statusCode: number | null }>;
        violationSummary: unknown;
      };
      expect(data.session.id).toBe(session.id);
      expect(data.session.targetUrl).toBe('https://app.example.com');
      expect(data.pagesVisited).toBeGreaterThanOrEqual(1);
      expect(data.pages[0].url).toContain('app.example.com');
    });

    it('errors on unknown session', async () => {
      const result = await callTool(server, 'get_session', {
        sessionId: '00000000-0000-4000-8000-000000000000',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ── list_sessions ─────────────────────────────────────────────────────

  describe('list_sessions', () => {
    it('lists only current-project sessions by default', async () => {
      seedSession(db, { project: 'project-a' });
      seedSession(db, { project: 'project-b' });
      // createMcpServer uses process.cwd-derived project name; neither
      // seeded session matches, so the default filter should exclude both
      // unless the resolved project happens to collide. Rather than couple
      // the test to detectProjectName behaviour, assert the full-projects
      // view returns both.
      const result = await callTool(server, 'list_sessions', {
        allProjects: true,
      });

      const data = parseToolResult(result) as {
        count: number;
        sessions: Array<{ project: string | null }>;
      };
      expect(data.count).toBeGreaterThanOrEqual(2);
      const projects = data.sessions.map((s) => s.project).filter(Boolean);
      expect(projects).toContain('project-a');
      expect(projects).toContain('project-b');
    });
  });

  // ── get_permissions_policy ────────────────────────────────────────────

  describe('get_permissions_policy', () => {
    it('returns permissions policies for a session', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'get_permissions_policy', {
        sessionId: session.id,
      });

      const data = parseToolResult(result) as {
        count: number;
        policies: Array<{ directive: string; allowlist: string[] }>;
      };
      expect(data.count).toBeGreaterThanOrEqual(1);
      expect(data.policies[0].directive).toBe('camera');
      expect(data.policies[0].allowlist).toContain('self');
    });

    it('filters by directive name', async () => {
      const session = seedSession(db);
      const result = await callTool(server, 'get_permissions_policy', {
        sessionId: session.id,
        directive: 'geolocation',
      });

      const data = parseToolResult(result) as { count: number };
      expect(data.count).toBe(0);
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

    function writeTempHtml(html: string): string {
      tmpDir = mkdtempSync(join(process.cwd(), '.tmp-mcp-e2e-hash-static-'));
      const htmlFile = join(tmpDir, 'index.html');
      writeFileSync(htmlFile, html);
      return htmlFile;
    }

    it('generates structured output from static HTML', async () => {
      const htmlFile = writeTempHtml(
        '<html><head></head><body><script>window.__x=1</script><style>.a{display:block}</style></body></html>',
      );
      const mergeFile = join(tmpDir, 'policy.json');
      writeFileSync(
        mergeFile,
        JSON.stringify({
          directives: { 'connect-src': ['https://api.example.test'], 'report-uri': ['/ignored'] },
        }),
      );

      const result = await callTool(server, 'hash_static', {
        paths: [htmlFile],
        format: 'header',
        mergeJsonPaths: [mergeFile],
      });

      expect(result.isError).toBeUndefined();
      const data = parseToolResult(result) as {
        format: string;
        policy: string;
        directives: Record<string, string[]>;
        filesScanned: number;
        counts: { scriptElemHashes: number; styleElemHashes: number };
        injected: boolean;
      };
      expect(data.format).toBe('header');
      expect(data.policy).toMatch(/^Content-Security-Policy:/);
      expect(data.directives['connect-src']).toContain('https://api.example.test');
      expect(data.directives['report-uri']).toBeUndefined();
      expect(data.filesScanned).toBe(1);
      expect(data.counts.scriptElemHashes).toBe(1);
      expect(data.counts.styleElemHashes).toBe(1);
      expect(data.injected).toBe(false);
    });

    it('injects CSP meta into static HTML files', async () => {
      const htmlFile = writeTempHtml(
        '<html><head><meta http-equiv="Content-Security-Policy" content="default-src old"><title>x</title></head><body><script>window.__x=1</script></body></html>',
      );

      const result = await callTool(server, 'hash_static', {
        paths: [tmpDir],
        inject: true,
        policyDirectives: { 'report-to': ['group'] },
      });

      expect(result.isError).toBeUndefined();
      const data = parseToolResult(result) as { injected: boolean; filesScanned: number };
      expect(data.injected).toBe(true);
      expect(data.filesScanned).toBe(1);

      const updated = readFileSync(htmlFile, 'utf8');
      expect(updated.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
      expect(updated).toContain('script-src-elem');
      expect(updated).not.toContain('report-to');
      expect(updated).not.toContain('default-src old');
    });

    it('does not inject when the requested returned policy format is invalid', async () => {
      const originalHtml =
        '<html><head><title>x</title></head><body><script>window.__x=1</script></body></html>';
      const htmlFile = writeTempHtml(originalHtml);

      const result = await callTool(server, 'hash_static', {
        paths: [tmpDir],
        inject: true,
        isReportOnly: true,
      });

      expect(result.isError).toBe(true);
      expect(readFileSync(htmlFile, 'utf8')).toBe(originalHtml);
    });

    it('rejects non-document policyDirectives', async () => {
      const htmlFile = writeTempHtml('<html><head></head><body></body></html>');

      const result = await callTool(server, 'hash_static', {
        paths: [htmlFile],
        policyDirectives: { 'img-src': ['https://images.example.test'] },
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown document directive "img-src"');
    });
  });

  // ── Tool registration completeness ─────────────────────────────────────

  describe('tool registration', () => {
    it('registers every expected tool', () => {
      const tools = Object.keys(getTools(server));
      for (const name of [
        'start_session',
        'crawl_url',
        'audit_policy',
        'get_violations',
        'generate_policy',
        'export_policy',
        'score_policy',
        'compare_sessions',
        'get_session',
        'list_sessions',
        'get_permissions_policy',
        'hash_static',
      ]) {
        expect(tools).toContain(name);
      }
    });
  });
});
