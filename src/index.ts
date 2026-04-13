// ── Types ─────────────────────────────────────────────────────────────────
export type {
  SessionStatus,
  SessionMode,
  ViolationSource,
  StrictnessLevel,
  ExportFormat,
  WaitStrategy,
  CrawlConfig,
  SessionConfig,
  CookieParam,
  Session,
  Page,
  Violation,
  Policy,
  CspDirective,
} from './types.js';

// ── Database ──────────────────────────────────────────────────────────────
export { initializeDatabase } from './db/schema.js';
export {
  createDatabase,
  createSession,
  updateSession,
  getSession,
  listSessions,
  insertPage,
  updatePageStatusCode,
  getPages,
  insertViolation,
  getViolations,
  getViolationSummary,
  insertPolicy,
  getPolicy,
} from './db/repository.js';
export type {
  InsertViolationParams,
  ViolationFilters,
  ViolationSummaryEntry,
  InsertPolicyParams,
  InsertInlineHashParams,
} from './db/repository.js';

export type { InlineHash } from './types.js';

// ── Utilities ─────────────────────────────────────────────────────────────
export {
  CSP_DIRECTIVES,
  FETCH_DIRECTIVES,
  DIRECTIVE_FALLBACK_MAP,
  buildDenyAllCSP,
  buildReportToHeader,
} from './utils/csp-constants.js';

export {
  extractOrigin,
  isLocalhost,
  isSameOrigin,
  generateWildcardDomain,
  normalizeBlockedUri,
} from './utils/url-utils.js';

export { createLogger } from './utils/logger.js';
export type { LogLevel, Logger } from './utils/logger.js';

export {
  getDataDir,
  resolveRealPath,
  validateDbPath,
  ensureDataDirectory,
  setSecureFilePermissions,
} from './utils/file-utils.js';

// ── Report Parser ────────────────────────────────────────────────────────
export { parseCspReport, parseReportingApiReport, parseDomViolation } from './report-parser.js';

// ── Report Server ────────────────────────────────────────────────────────
export { startReportServer } from './report-server.js';

// ── CSP Injector ─────────────────────────────────────────────────────────
export { setupCspInjection, transformResponseHeaders } from './csp-injector.js';
export type { PlaywrightPage, PlaywrightRoute, PlaywrightResponse } from './csp-injector.js';

// ── Violation Listener ───────────────────────────────────────────────────
export { setupViolationListener, generateInitScript } from './violation-listener.js';

// ── Inline Content Extraction ───────────────────────────────────────────
export { extractInlineHashes } from './inline-content-extractor.js';

// ── Crawler ──────────────────────────────────────────────────────────────
export { crawl } from './crawler.js';
export type { CrawlResult, CrawlCallbacks } from './crawler.js';

// ── Policy Generation (Phase 3) ─────────────────────────────────────────
export { violationToSourceExpression, violationToHashSource } from './rule-builder.js';

export { generatePolicy, generatePolicyFromViolations } from './policy-generator.js';
export type { PolicyGeneratorOptions } from './policy-generator.js';

export { optimizePolicy, shouldUseDefaultSrc } from './policy-optimizer.js';
export type { OptimizePolicyOptions } from './policy-optimizer.js';

export { formatPolicy, directivesToString } from './policy-formatter.js';

// ── Auth (Phase 5) ────────────────────────────────────────────────────
export {
  createAuthenticatedContext,
  performManualLogin,
  extractHostname,
  mapCookies,
} from './auth.js';
export type { AuthOptions } from './auth.js';

// ── Session Manager (Phase 5) ─────────────────────────────────────────
export { runSession, runInteractiveSession } from './session-manager.js';
export type {
  SessionResult,
  InteractiveSessionResult,
  RunSessionOptions,
  InteractiveSessionOptions,
} from './session-manager.js';

// ── MCP Server (Phase 5) ──────────────────────────────────────────────
export { createMcpServer } from './mcp-server.js';
