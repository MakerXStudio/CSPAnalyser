import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  getSession,
  listSessions,
  getViolations,
  getViolationSummary,
  getPages,
  getPermissionsPolicies,
  getPermissionsPolicyByDirective,
} from './db/repository.js';
import { generatePolicy } from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';
import { formatPolicy, directivesToString } from './policy-formatter.js';
import { createLogger } from './utils/logger.js';
import { validateTargetUrl } from './utils/url-utils.js';
import { getDataDir, detectProjectName } from './utils/file-utils.js';
// Lazy import type for session-manager (dynamic import requires inline type annotation)
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type SessionManagerModule = { runSession: (typeof import('./session-manager.js'))['runSession'] };

const logger = createLogger();

// ── Tool result helpers ─────────────────────────────────────────────────

function toolResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Strips internal file paths from error messages to avoid leaking server internals.
 * Matches absolute paths like /home/user/project/... or C:\Users\...
 */
export function sanitizeErrorMessage(message: string): string {
  return message.replace(/(?:\/[\w.-]+){2,}(?:\/[\w.-]*)*|[A-Z]:\\(?:[\w.-]+\\)*/g, '<path>');
}

function toolError(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: 'text' as const, text: sanitizeErrorMessage(message) }],
    isError: true,
  };
}

// ── Server factory ──────────────────────────────────────────────────────

export function createMcpServer(db: Database.Database): McpServer {
  const server = new McpServer({
    name: 'csp-analyser',
    version: '0.1.0',
  });

  // ── start_session ───────────────────────────────────────────────────

  server.registerTool(
    'start_session',
    {
      description: 'Start a new CSP analysis session: crawl a website with a deny-all report-only CSP and capture all violations',
      inputSchema: {
        targetUrl: z.url().describe('The URL to analyse'),
        depth: z.number().int().min(0).max(10).optional().describe('Crawl depth (default: 1)'),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Maximum pages to crawl (default: 10)'),
        settlementDelay: z
          .number()
          .int()
          .min(0)
          .max(10000)
          .optional()
          .describe('Milliseconds to wait after page load for late violations (default: 2000)'),
        storageStatePath: z
          .string()
          .optional()
          .describe('Path to Playwright storageState JSON for authenticated sessions'),
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe('Policy strictness level (default: moderate)'),
        violationLimit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Maximum violations to accept per session (default: 10000, 0 for unlimited)'),
      },
    },
    async (args) => {
      try {
        validateTargetUrl(args.targetUrl);
        // Dynamic import so the server module compiles even before session-manager exists
        const { runSession } = (await import('./session-manager.js')) as SessionManagerModule;

        const result = await runSession(db, {
          targetUrl: args.targetUrl,
          crawlConfig: {
            depth: args.depth,
            maxPages: args.maxPages,
            settlementDelay: args.settlementDelay,
          },
          storageStatePath: args.storageStatePath,
          violationLimit: args.violationLimit,
          project: detectProjectName() ?? undefined,
        });

        return toolResult({
          sessionId: result.session.id,
          targetUrl: result.session.targetUrl,
          pagesVisited: result.pagesVisited,
          violationsFound: result.violationsFound,
          errors: result.errors,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('start_session failed', { error: message });
        return toolError(`Failed to start session: ${message}`);
      }
    },
  );

  // ── crawl_url ───────────────────────────────────────────────────────

  server.registerTool(
    'crawl_url',
    {
      description: 'Analyse a single page for CSP violations (convenience wrapper: depth=0, maxPages=1)',
      inputSchema: {
        url: z.url().describe('The URL to analyse'),
        storageStatePath: z
          .string()
          .optional()
          .describe('Path to Playwright storageState JSON for authenticated sessions'),
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe('Policy strictness level (default: moderate)'),
      },
    },
    async (args) => {
      try {
        validateTargetUrl(args.url);
        const { runSession } = (await import('./session-manager.js')) as SessionManagerModule;

        const result = await runSession(db, {
          targetUrl: args.url,
          crawlConfig: {
            depth: 0,
            maxPages: 1,
          },
          storageStatePath: args.storageStatePath,
          project: detectProjectName() ?? undefined,
        });

        return toolResult({
          sessionId: result.session.id,
          targetUrl: result.session.targetUrl,
          pagesVisited: result.pagesVisited,
          violationsFound: result.violationsFound,
          errors: result.errors,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('crawl_url failed', { error: message });
        return toolError(`Failed to crawl URL: ${message}`);
      }
    },
  );

  // ── get_violations ──────────────────────────────────────────────────

  server.registerTool(
    'get_violations',
    {
      description: 'Get CSP violations captured during a session, optionally filtered by directive, page URL, or origin',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        directive: z.string().optional().describe('Filter by CSP directive (e.g. script-src)'),
        pageUrl: z.string().optional().describe('Filter by page URL'),
        origin: z.string().optional().describe('Filter by blocked resource origin'),
      },
    },
    async (args) => {
      try {
        const session = getSession(db, args.sessionId);
        if (!session) {
          return toolError(`Session not found: ${args.sessionId}`);
        }

        const violations = getViolations(db, args.sessionId, {
          directive: args.directive,
          pageUrl: args.pageUrl,
          origin: args.origin,
        });

        return toolResult({
          sessionId: args.sessionId,
          count: violations.length,
          violations: violations.map((v) => ({
            id: v.id,
            documentUri: v.documentUri,
            blockedUri: v.blockedUri,
            effectiveDirective: v.effectiveDirective,
            violatedDirective: v.violatedDirective,
            sourceFile: v.sourceFile,
            lineNumber: v.lineNumber,
            sample: v.sample,
            capturedVia: v.capturedVia,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get violations: ${message}`);
      }
    },
  );

  // ── generate_policy ─────────────────────────────────────────────────

  server.registerTool(
    'generate_policy',
    {
      description: 'Generate an optimised CSP policy from violations captured in a session',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe('Policy strictness (default: moderate)'),
        includeHashes: z
          .boolean()
          .optional()
          .describe('Include SHA-256 hashes for inline scripts/styles (default: false)'),
        useHashes: z
          .boolean()
          .optional()
          .describe("Remove 'unsafe-inline' from directives that have hash sources (implies includeHashes, default: false)"),
        stripUnsafeEval: z
          .boolean()
          .optional()
          .describe("Remove 'unsafe-eval' from the generated policy (default: false)"),
      },
    },
    async (args) => {
      try {
        const session = getSession(db, args.sessionId);
        if (!session) {
          return toolError(`Session not found: ${args.sessionId}`);
        }

        const directives = generatePolicy(db, args.sessionId, {
          strictness: args.strictness ?? 'moderate',
          includeHashes: args.includeHashes ?? args.useHashes ?? false,
        });

        const optimized = optimizePolicy(directives, session.targetUrl, {
          useHashes: args.useHashes,
          stripUnsafeEval: args.stripUnsafeEval,
        });
        const policyString = directivesToString(optimized);

        return toolResult({
          sessionId: args.sessionId,
          strictness: args.strictness ?? 'moderate',
          directives: optimized,
          policyString,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to generate policy: ${message}`);
      }
    },
  );

  // ── export_policy ───────────────────────────────────────────────────

  server.registerTool(
    'export_policy',
    {
      description: 'Export a CSP policy in a deployment-ready format (header, meta, nginx, apache, cloudflare, cloudflare-pages, azure-frontdoor, helmet, json)',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        format: z
          .enum(['header', 'meta', 'nginx', 'apache', 'cloudflare', 'cloudflare-pages', 'azure-frontdoor', 'helmet', 'json'])
          .describe('Output format'),
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe('Policy strictness (default: moderate)'),
        isReportOnly: z
          .boolean()
          .optional()
          .describe('Use Content-Security-Policy-Report-Only header (default: false)'),
        useHashes: z
          .boolean()
          .optional()
          .describe("Remove 'unsafe-inline' from directives that have hash sources (default: false)"),
        stripUnsafeEval: z
          .boolean()
          .optional()
          .describe("Remove 'unsafe-eval' from the generated policy (default: false)"),
      },
    },
    async (args) => {
      try {
        const session = getSession(db, args.sessionId);
        if (!session) {
          return toolError(`Session not found: ${args.sessionId}`);
        }

        const directives = generatePolicy(db, args.sessionId, {
          strictness: args.strictness ?? 'moderate',
          includeHashes: args.useHashes ?? false,
        });

        const optimized = optimizePolicy(directives, session.targetUrl, {
          useHashes: args.useHashes,
          stripUnsafeEval: args.stripUnsafeEval,
        });
        const formatted = formatPolicy(optimized, args.format, args.isReportOnly ?? false);

        return toolResult({
          sessionId: args.sessionId,
          format: args.format,
          isReportOnly: args.isReportOnly ?? false,
          policy: formatted,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to export policy: ${message}`);
      }
    },
  );

  // ── score_policy ────────────────────────────────────────────────────

  server.registerTool(
    'score_policy',
    {
      description: 'Score a CSP policy against best practices (0-100 with grade A-F)',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe('Policy strictness (default: moderate)'),
        useHashes: z
          .boolean()
          .optional()
          .describe("Score the hash-optimized policy (removes 'unsafe-inline' where hashes exist, adds 'unsafe-hashes' where required) (default: false)"),
        stripUnsafeEval: z
          .boolean()
          .optional()
          .describe("Score the policy with 'unsafe-eval' stripped (default: false)"),
      },
    },
    async (args) => {
      try {
        const session = getSession(db, args.sessionId);
        if (!session) {
          return toolError(`Session not found: ${args.sessionId}`);
        }

        const directives = generatePolicy(db, args.sessionId, {
          strictness: args.strictness ?? 'moderate',
          includeHashes: args.useHashes ?? false,
        });
        const optimized = optimizePolicy(directives, session.targetUrl, {
          useHashes: args.useHashes,
          stripUnsafeEval: args.stripUnsafeEval,
        });

        const { scoreCspPolicy, formatScore } = await import('./policy-scorer.js');
        const score = scoreCspPolicy(optimized);

        return toolResult({
          ...score,
          formatted: formatScore(score),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to score policy: ${message}`);
      }
    },
  );

  // ── compare_sessions ────────────────────────────────────────────────

  server.registerTool(
    'compare_sessions',
    {
      description: 'Compare two CSP analysis sessions and show policy/violation differences',
      inputSchema: {
        sessionIdA: z.uuid().describe('First session ID (baseline)'),
        sessionIdB: z.uuid().describe('Second session ID (comparison)'),
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe('Policy strictness (default: moderate)'),
      },
    },
    async (args) => {
      try {
        const { compareSessions: compare, formatDiff: format } = await import('./policy-diff.js');
        const comparison = compare(
          db,
          args.sessionIdA,
          args.sessionIdB,
          args.strictness ?? 'moderate',
        );
        return toolResult({
          ...comparison,
          formatted: format(comparison),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to compare sessions: ${message}`);
      }
    },
  );

  // ── get_session ─────────────────────────────────────────────────────

  server.registerTool(
    'get_session',
    {
      description: 'Get details and violation summary for a CSP analysis session',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
      },
    },
    async (args) => {
      try {
        const session = getSession(db, args.sessionId);
        if (!session) {
          return toolError(`Session not found: ${args.sessionId}`);
        }

        const pages = getPages(db, args.sessionId);
        const summary = getViolationSummary(db, args.sessionId);

        return toolResult({
          session: {
            id: session.id,
            targetUrl: session.targetUrl,
            status: session.status,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          },
          pagesVisited: pages.length,
          pages: pages.map((p) => ({ url: p.url, statusCode: p.statusCode })),
          violationSummary: summary,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get session: ${message}`);
      }
    },
  );

  // ── list_sessions ───────────────────────────────────────────────────

  server.registerTool('list_sessions', { description: 'List all CSP analysis sessions' }, async () => {
    try {
      const sessions = listSessions(db);

      return toolResult({
        count: sessions.length,
        sessions: sessions.map((s) => ({
          id: s.id,
          targetUrl: s.targetUrl,
          status: s.status,
          createdAt: s.createdAt,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to list sessions: ${message}`);
    }
  });

  // ── get_permissions_policy ──────────────────────────────────────────

  server.registerTool(
    'get_permissions_policy',
    {
      description: 'Get Permissions-Policy and Feature-Policy headers captured during a session, optionally filtered by directive',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        directive: z
          .string()
          .optional()
          .describe('Filter by directive name (e.g. camera, geolocation)'),
      },
    },
    async (args) => {
      try {
        const session = getSession(db, args.sessionId);
        if (!session) {
          return toolError(`Session not found: ${args.sessionId}`);
        }

        const policies = args.directive
          ? getPermissionsPolicyByDirective(db, args.sessionId, args.directive)
          : getPermissionsPolicies(db, args.sessionId);

        return toolResult({
          sessionId: args.sessionId,
          count: policies.length,
          policies: policies.map((p) => ({
            id: p.id,
            directive: p.directive,
            allowlist: p.allowlist,
            headerType: p.headerType,
            sourceUrl: p.sourceUrl,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to get permissions policies: ${message}`);
      }
    },
  );

  return server;
}

// ── Main entry point ────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const dbPath = path.join(getDataDir(), 'data.db');
  logger.info('Starting CSP Analyser MCP server', { dbPath });

  const db = createDatabase(dbPath);

  try {
    const server = createMcpServer(db);
    const transport = new StdioServerTransport();

    // Graceful shutdown
    const shutdown = async () => {
      logger.info('Shutting down MCP server');
      await server.close();
      db.close();
      process.exit(0);
    };

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    process.on('SIGINT', shutdown);
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    process.on('SIGTERM', shutdown);

    await server.connect(transport);
    logger.info('MCP server connected via stdio');
  } catch (error) {
    db.close();
    throw error;
  }
}

// Run when executed directly
const __mcp_url = new URL(import.meta.url).pathname;
const isDirectExecution =
  process.argv[1] && __mcp_url === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectExecution) {
  main().catch((error: unknown) => {
    logger.error('MCP server failed to start', { error: String(error) });
    process.exit(1);
  });
}
