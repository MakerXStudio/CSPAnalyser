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
  SessionRepository,
  PageRepository,
  ViolationRepository,
  PolicyRepository,
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
} from './db/repository.js';

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
  shouldUseMitmMode,
  generateWildcardDomain,
  normalizeBlockedUri,
} from './utils/url-utils.js';

export { createLogger } from './utils/logger.js';
export type { LogLevel, Logger } from './utils/logger.js';

export {
  validateDbPath,
  ensureDataDirectory,
  setSecureFilePermissions,
} from './utils/file-utils.js';

// ── Report Parser ────────────────────────────────────────────────────────
export {
  parseCspReport,
  parseReportingApiReport,
  parseDomViolation,
} from './report-parser.js';

// ── Report Server ────────────────────────────────────────────────────────
export { startReportServer } from './report-server.js';

// ── CSP Injector ─────────────────────────────────────────────────────────
export { setupCspInjection, transformResponseHeaders } from './csp-injector.js';
export type {
  PlaywrightPage,
  PlaywrightRoute,
  PlaywrightResponse,
} from './csp-injector.js';

// ── Violation Listener ───────────────────────────────────────────────────
export { setupViolationListener, generateInitScript } from './violation-listener.js';

// ── Crawler ──────────────────────────────────────────────────────────────
export { crawl } from './crawler.js';
export type { CrawlResult, CrawlCallbacks } from './crawler.js';
