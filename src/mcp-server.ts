import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  getSession,
  listSessions,
  listSessionsByProject,
  getViolations,
  getViolationSummary,
  getPages,
  getPermissionsPolicies,
  getPermissionsPolicyByDirective,
  getEvalSourceAttribution,
  getInlineHashes,
} from './db/repository.js';
import { generatePolicy } from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';
import { formatPolicy, directivesToString, META_STRIPPED_DIRECTIVES } from './policy-formatter.js';
import { createLogger } from './utils/logger.js';
import { validateTargetUrlWithDns } from './utils/url-utils.js';
import { getDataDir, resolveProjectName } from './utils/file-utils.js';
import { CSP_DIRECTIVES } from './utils/csp-constants.js';
import type { ExportFormat } from './types.js';
// Lazy import type for session-manager (dynamic import requires inline type annotation)
import type { runSession, runAuditSession } from './session-manager.js';
import type { CookieParam } from './types.js';
type SessionManagerModule = {
  runSession: typeof runSession;
  runAuditSession: typeof runAuditSession;
};

const logger = createLogger();
const exportFormatSchema = z.enum([
  'header',
  'meta',
  'nginx',
  'apache',
  'cloudflare',
  'cloudflare-pages',
  'azure-frontdoor',
  'helmet',
  'json',
]);
const staticProfileSchema = z
  .enum(['react-expo'])
  .optional()
  .describe(
    "Static framework profile. 'react-expo' keeps script hashes strict while allowing style-src-attr hash explosions to collapse to 'unsafe-inline' when collapseHashThreshold is exceeded.",
  );
const useNoncesSchema = z
  .boolean()
  .optional()
  .describe(
    "Replace 'unsafe-inline' in script/style directives with 'nonce-{{CSP_NONCE}}' placeholders (default: false). Static site mode and static profiles skip nonce replacement.",
  );
const useStrictDynamicSchema = z
  .boolean()
  .optional()
  .describe(
    "Add 'strict-dynamic' alongside script nonces and imply nonce mode when useNonces is not set (default: false).",
  );
const cookieSchema: z.ZodType<CookieParam> = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});
const cookiesSchema = z
  .array(cookieSchema)
  .optional()
  .describe('Cookies to inject into the browser context before crawling');
const knownCspDirectives: ReadonlySet<string> = new Set(CSP_DIRECTIVES);
const documentDirectives: ReadonlySet<string> = new Set([
  'report-uri',
  'report-to',
  'sandbox',
  'upgrade-insecure-requests',
  'require-trusted-types-for',
  'trusted-types',
  'plugin-types',
]);

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

function resolveUnderCurrentWorkingDirectory(inputPath: string): string {
  const cwd = realpathSync(process.cwd());
  const absolute = path.resolve(cwd, inputPath);
  let resolvedPath: string;

  try {
    resolvedPath = realpathSync(absolute);
  } catch {
    resolvedPath = absolute;
  }

  const relative = path.relative(cwd, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the current working directory: ${inputPath}`);
  }

  return resolvedPath;
}

function mergeDirectiveRecord(
  into: Map<string, string[]>,
  directives: Record<string, string[]>,
): void {
  for (const [directive, sources] of Object.entries(directives)) {
    if (!knownCspDirectives.has(directive)) continue;
    const existing = into.get(directive);
    if (existing) {
      existing.push(...sources);
    } else {
      into.set(directive, [...sources]);
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMergeJsonFiles(paths: readonly string[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();

  for (const rawPath of paths) {
    const filePath = resolveUnderCurrentWorkingDirectory(rawPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read merge JSON file "${rawPath}": ${message}`, { cause: error });
    }

    if (!isObjectRecord(parsed)) {
      throw new Error(`Merge JSON file must contain an object: ${rawPath}`);
    }

    const parsedRecord = parsed;
    const candidate = parsedRecord.directives;
    const directivesSource = isObjectRecord(candidate) ? candidate : parsedRecord;

    const directiveMap: Record<string, string[]> = {};
    for (const [directive, value] of Object.entries(directivesSource)) {
      if (!knownCspDirectives.has(directive)) continue;
      if (
        !Array.isArray(value) ||
        !value.every((source): source is string => typeof source === 'string')
      ) {
        throw new Error(`Directive "${directive}" in ${rawPath} must be an array of strings`);
      }
      directiveMap[directive] = value;
    }
    mergeDirectiveRecord(merged, directiveMap);
  }

  return merged;
}

function mergeInputDirectives(
  extraDirectives?: Record<string, string[]>,
  mergeJsonPaths?: readonly string[],
): Map<string, string[]> | undefined {
  const merged = new Map<string, string[]>();
  if (extraDirectives) {
    mergeDirectiveRecord(merged, extraDirectives);
  }
  if (mergeJsonPaths && mergeJsonPaths.length > 0) {
    const fromFiles = readMergeJsonFiles(mergeJsonPaths);
    for (const [directive, sources] of fromFiles) {
      const existing = merged.get(directive);
      if (existing) {
        existing.push(...sources);
      } else {
        merged.set(directive, sources);
      }
    }
  }
  return merged.size > 0 ? merged : undefined;
}

function withoutMetaStrippedDirectives(
  directives: Record<string, string[]>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(directives).filter(
      ([directive]) => !META_STRIPPED_DIRECTIVES.includes(directive),
    ),
  );
}

function appendPolicyDirectives(
  directives: Record<string, string[]>,
  policyDirectives: Record<string, string[]>,
): void {
  for (const [directive, values] of Object.entries(policyDirectives)) {
    if (!documentDirectives.has(directive)) {
      throw new Error(
        `Unknown document directive "${directive}". Supported directives: ${[
          ...documentDirectives,
        ].join(', ')}`,
      );
    }
    directives[directive] = [...values];
  }
}

// ── Server factory ──────────────────────────────────────────────────────

/**
 * Retrieves a session by ID with project-scoping enforcement.
 * Returns null if the session doesn't exist or belongs to a different project
 * (unless allProjects is true).
 * Sessions with no project set (legacy/global) are always accessible.
 */
function getProjectScopedSession(
  db: Database.Database,
  sessionId: string,
  allProjects?: boolean,
): ReturnType<typeof getSession> {
  const session = getSession(db, sessionId);
  if (!session) return null;

  if (!allProjects) {
    const currentProject = resolveProjectName();
    if (session.project && session.project !== currentProject) {
      return null;
    }
  }

  return session;
}

function getPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export function createMcpServer(db: Database.Database): McpServer {
  const server = new McpServer({
    name: 'csp-analyser',
    version: getPackageVersion(),
  });

  // ── start_session ───────────────────────────────────────────────────

  server.registerTool(
    'start_session',
    {
      description:
        'Start a new CSP analysis session: crawl a website with a deny-all report-only CSP and capture all violations',
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
        cookies: cookiesSchema,
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
        await validateTargetUrlWithDns(args.targetUrl);
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
          cookies: args.cookies,
          violationLimit: args.violationLimit,
          project: resolveProjectName(),
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
      description:
        'Analyse a single page for CSP violations (convenience wrapper: depth=0, maxPages=1)',
      inputSchema: {
        url: z.url().describe('The URL to analyse'),
        storageStatePath: z
          .string()
          .optional()
          .describe('Path to Playwright storageState JSON for authenticated sessions'),
        cookies: cookiesSchema,
      },
    },
    async (args) => {
      try {
        await validateTargetUrlWithDns(args.url);
        const { runSession } = (await import('./session-manager.js')) as SessionManagerModule;

        const result = await runSession(db, {
          targetUrl: args.url,
          crawlConfig: {
            depth: 0,
            maxPages: 1,
          },
          storageStatePath: args.storageStatePath,
          cookies: args.cookies,
          project: resolveProjectName(),
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
      description:
        'Get CSP violations captured during a session, optionally filtered by directive, page URL, or origin',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        directive: z.string().optional().describe('Filter by CSP directive (e.g. script-src)'),
        pageUrl: z.string().optional().describe('Filter by page URL'),
        origin: z.string().optional().describe('Filter by blocked resource origin'),
      },
    },
    async (args) => {
      try {
        const session = getProjectScopedSession(db, args.sessionId);
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
          .describe(
            "Remove 'unsafe-inline' from directives that have hash sources (implies includeHashes, default: false)",
          ),
        stripUnsafeEval: z
          .boolean()
          .optional()
          .describe("Remove 'unsafe-eval' from the generated policy (default: false)"),
        useNonces: useNoncesSchema,
        useStrictDynamic: useStrictDynamicSchema,
        collapseHashThreshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Collapse hashes to 'unsafe-inline' when a directive exceeds this many hashes (default: disabled)",
          ),
        staticSiteMode: z
          .boolean()
          .optional()
          .describe(
            'Target is a static site — skips nonce suggestions and enables aggressive hash collapsing recommendations (default: false)',
          ),
        staticProfile: staticProfileSchema,
      },
    },
    async (args) => {
      try {
        const session = getProjectScopedSession(db, args.sessionId);
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
          useNonces: args.useNonces ?? args.useStrictDynamic ?? false,
          useStrictDynamic: args.useStrictDynamic,
          collapseHashThreshold: args.collapseHashThreshold,
          staticSiteMode: args.staticSiteMode,
          staticProfile: args.staticProfile,
        });
        const policyString = directivesToString(optimized);

        // Eval source attribution: show which files/lines require unsafe-eval
        const hasUnsafeEval = Object.values(optimized).some((sources) =>
          sources.includes("'unsafe-eval'"),
        );
        const evalSources = hasUnsafeEval ? getEvalSourceAttribution(db, args.sessionId) : [];

        // Hash stability analysis
        const { analyseHashStability } = await import('./hash-stability-analyser.js');
        const inlineHashes = getInlineHashes(db, args.sessionId);
        const hashStability = analyseHashStability(inlineHashes);

        // Static site detection
        const { detectStaticSite } = await import('./static-site-detector.js');
        const staticSiteAnalysis = detectStaticSite(inlineHashes, optimized);

        return toolResult({
          sessionId: args.sessionId,
          strictness: args.strictness ?? 'moderate',
          ...(args.staticProfile ? { staticProfile: args.staticProfile } : {}),
          directives: optimized,
          policyString,
          ...(evalSources.length > 0 ? { evalSources } : {}),
          ...(hashStability.warnings.length > 0 ? { hashStability } : {}),
          ...(staticSiteAnalysis.isLikelyStatic ? { staticSiteAnalysis } : {}),
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
      description:
        'Export a CSP policy in a deployment-ready format (header, meta, nginx, apache, cloudflare, cloudflare-pages, azure-frontdoor, helmet, json)',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        format: z
          .enum([
            'header',
            'meta',
            'nginx',
            'apache',
            'cloudflare',
            'cloudflare-pages',
            'azure-frontdoor',
            'helmet',
            'json',
          ])
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
          .describe(
            "Remove 'unsafe-inline' from directives that have hash sources (default: false)",
          ),
        stripUnsafeEval: z
          .boolean()
          .optional()
          .describe("Remove 'unsafe-eval' from the generated policy (default: false)"),
        useNonces: useNoncesSchema,
        useStrictDynamic: useStrictDynamicSchema,
        collapseHashThreshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Collapse hashes to 'unsafe-inline' when a directive exceeds this many hashes (default: disabled)",
          ),
        staticSiteMode: z
          .boolean()
          .optional()
          .describe('Target is a static site — skips nonce suggestions (default: false)'),
        staticProfile: staticProfileSchema,
      },
    },
    async (args) => {
      try {
        const session = getProjectScopedSession(db, args.sessionId);
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
          useNonces: args.useNonces ?? args.useStrictDynamic ?? false,
          useStrictDynamic: args.useStrictDynamic,
          collapseHashThreshold: args.collapseHashThreshold,
          staticSiteMode: args.staticSiteMode,
          staticProfile: args.staticProfile,
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

  // ── hash_static ──────────────────────────────────────────────────────

  server.registerTool(
    'hash_static',
    {
      description:
        'Generate a CSP for browserless static HTML files under the current project, optionally injecting a CSP meta tag into scanned files',
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe('Project-local HTML files or directories to scan'),
        format: exportFormatSchema.optional().describe('Output format (default: meta)'),
        isReportOnly: z
          .boolean()
          .optional()
          .describe('Use Content-Security-Policy-Report-Only header (default: false)'),
        inject: z
          .boolean()
          .optional()
          .describe('Write a CSP meta tag into each scanned HTML file (default: false)'),
        extraDirectives: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Additional sources keyed by known CSP fetch/navigation directive'),
        mergeJsonPaths: z
          .array(z.string())
          .optional()
          .describe('Project-local JSON policy files exported by this tool or the CLI'),
        policyDirectives: z
          .record(z.string(), z.array(z.string()))
          .optional()
          .describe('Document directives appended verbatim, such as report-uri or sandbox'),
        collapseHashThreshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Collapse hashes to 'unsafe-inline' when an eligible directive exceeds this count",
          ),
        staticProfile: staticProfileSchema,
      },
    },
    async (args) => {
      try {
        const { scanHtmlFiles, buildStaticPolicy, injectCspMeta } =
          await import('./static-html-analyser.js');

        const resolvedPaths = args.paths.map(resolveUnderCurrentWorkingDirectory);
        const extraDirectives = mergeInputDirectives(args.extraDirectives, args.mergeJsonPaths);
        const { result, files } = await scanHtmlFiles(resolvedPaths);
        const directives = buildStaticPolicy(result, {
          extraDirectives,
          staticProfile: args.staticProfile,
          collapseHashThreshold: args.collapseHashThreshold,
        });

        if (args.policyDirectives) {
          appendPolicyDirectives(directives, args.policyDirectives);
        }

        const format: ExportFormat = args.format ?? 'meta';
        const isReportOnly = args.isReportOnly ?? false;
        const shouldInject = args.inject ?? false;

        if (shouldInject && files.length === 0) {
          return toolError(`No HTML files found under: ${args.paths.join(', ')}`);
        }

        const policy = formatPolicy(directives, format, isReportOnly);

        if (shouldInject) {
          const metaPolicy = directivesToString(withoutMetaStrippedDirectives(directives));
          for (const file of files) {
            const html = readFileSync(file, 'utf8');
            writeFileSync(file, injectCspMeta(html, metaPolicy));
          }
        }

        return toolResult({
          format,
          isReportOnly,
          policy,
          directives,
          filesScanned: files.length,
          counts: {
            scriptElemHashes: result.scriptElem.size,
            styleElemHashes: result.styleElem.size,
            styleAttrHashes: result.styleAttr.size,
            scriptAttrHashes: result.scriptAttr.size,
          },
          injected: shouldInject,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('hash_static failed', { error: message });
        return toolError(`Failed to hash static HTML: ${message}`);
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
          .describe(
            "Score the hash-optimized policy (removes 'unsafe-inline' where hashes exist, adds 'unsafe-hashes' where required) (default: false)",
          ),
        stripUnsafeEval: z
          .boolean()
          .optional()
          .describe("Score the policy with 'unsafe-eval' stripped (default: false)"),
        useNonces: useNoncesSchema,
        useStrictDynamic: useStrictDynamicSchema,
        collapseHashThreshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Collapse hashes before scoring when a directive exceeds this many hashes (default: disabled)',
          ),
        staticSiteMode: z
          .boolean()
          .optional()
          .describe('Score with static-site nonce skipping behavior (default: false)'),
        staticProfile: staticProfileSchema,
      },
    },
    async (args) => {
      try {
        const session = getProjectScopedSession(db, args.sessionId);
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
          useNonces: args.useNonces ?? args.useStrictDynamic ?? false,
          useStrictDynamic: args.useStrictDynamic,
          collapseHashThreshold: args.collapseHashThreshold,
          staticSiteMode: args.staticSiteMode,
          staticProfile: args.staticProfile,
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
        allProjects: z
          .boolean()
          .optional()
          .describe('Allow comparing sessions from any project (default: false)'),
      },
    },
    async (args) => {
      try {
        const sessionA = getProjectScopedSession(db, args.sessionIdA, args.allProjects);
        if (!sessionA) {
          return toolError(`Session not found: ${args.sessionIdA}`);
        }

        const sessionB = getProjectScopedSession(db, args.sessionIdB, args.allProjects);
        if (!sessionB) {
          return toolError(`Session not found: ${args.sessionIdB}`);
        }

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
      description:
        'Get details and violation summary for a CSP analysis session. By default, only sessions belonging to the current project are accessible.',
      inputSchema: {
        sessionId: z.uuid().describe('The session ID'),
        allProjects: z
          .boolean()
          .optional()
          .describe('Allow accessing sessions from any project (default: false)'),
      },
    },
    async (args) => {
      try {
        const session = getProjectScopedSession(db, args.sessionId, args.allProjects);
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
            project: session.project,
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

  server.registerTool(
    'list_sessions',
    {
      description:
        'List CSP analysis sessions. By default, only sessions for the current project are returned.',
      inputSchema: {
        allProjects: z
          .boolean()
          .optional()
          .describe('List sessions from all projects (default: false — only current project)'),
      },
    },
    async (args) => {
      try {
        let sessions: ReturnType<typeof listSessions>;

        if (args.allProjects) {
          sessions = listSessions(db);
        } else {
          sessions = listSessionsByProject(db, resolveProjectName());
        }

        return toolResult({
          count: sessions.length,
          sessions: sessions.map((s) => ({
            id: s.id,
            targetUrl: s.targetUrl,
            status: s.status,
            createdAt: s.createdAt,
            project: s.project,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolError(`Failed to list sessions: ${message}`);
      }
    },
  );

  // ── get_permissions_policy ──────────────────────────────────────────

  server.registerTool(
    'get_permissions_policy',
    {
      description:
        'Get Permissions-Policy and Feature-Policy headers captured during a session, optionally filtered by directive',
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
        const session = getProjectScopedSession(db, args.sessionId);
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

  // ── audit_policy ─────────────────────────────────────────────────────

  server.registerTool(
    'audit_policy',
    {
      description:
        'Audit an existing CSP: crawl a website preserving its current CSP, capture violations, and produce a diff plus merged policy. In strict mode, unsafe-inline is stripped and replaced with hashes.',
      inputSchema: {
        targetUrl: z.url().describe('The URL to audit'),
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
        cookies: cookiesSchema,
        strictness: z
          .enum(['strict', 'moderate', 'permissive'])
          .optional()
          .describe(
            'Policy strictness level (default: moderate). Strict mode strips unsafe-inline and generates hashes.',
          ),
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
        await validateTargetUrlWithDns(args.targetUrl);
        const { runAuditSession } = (await import('./session-manager.js')) as SessionManagerModule;
        const { generateAuditResult, formatAuditResult } = await import('./audit.js');

        const strictness = args.strictness ?? 'moderate';

        const result = await runAuditSession(db, {
          targetUrl: args.targetUrl,
          crawlConfig: {
            depth: args.depth,
            maxPages: args.maxPages,
            settlementDelay: args.settlementDelay,
          },
          storageStatePath: args.storageStatePath,
          cookies: args.cookies,
          violationLimit: args.violationLimit,
          project: resolveProjectName(),
        });

        const auditResult = generateAuditResult(db, result.session.id, { strictness });

        return toolResult({
          sessionId: auditResult.sessionId,
          pagesVisited: result.pagesVisited,
          violationsFound: auditResult.violationsFound,
          errors: result.errors,
          enforced: auditResult.enforced
            ? {
                existingDirectives: auditResult.enforced.existingDirectives,
                mergedDirectives: auditResult.enforced.mergedDirectives,
                diff: auditResult.enforced.diff,
                violationCount: auditResult.enforced.violationCount,
              }
            : null,
          reportOnly: auditResult.reportOnly
            ? {
                existingDirectives: auditResult.reportOnly.existingDirectives,
                mergedDirectives: auditResult.reportOnly.mergedDirectives,
                diff: auditResult.reportOnly.diff,
                violationCount: auditResult.reportOnly.violationCount,
              }
            : null,
          formatted: formatAuditResult(auditResult),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('audit_policy failed', { error: message });
        return toolError(`Failed to audit policy: ${message}`);
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
