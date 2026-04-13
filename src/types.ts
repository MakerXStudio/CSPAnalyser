// ── Enums ──────────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'created'
  | 'authenticating'
  | 'crawling'
  | 'analyzing'
  | 'complete'
  | 'failed';

export type SessionMode = 'local';

export type ViolationSource = 'dom_event' | 'report_uri' | 'reporting_api';

export type StrictnessLevel = 'strict' | 'moderate' | 'permissive';

export type ExportFormat =
  | 'header'
  | 'meta'
  | 'nginx'
  | 'apache'
  | 'cloudflare'
  | 'cloudflare-pages'
  | 'azure-frontdoor'
  | 'helmet'
  | 'json';

// ── Config types ───────────────────────────────────────────────────────────

export type WaitStrategy = 'networkidle' | 'load' | 'domcontentloaded';

export interface CrawlConfig {
  depth: number;
  maxPages: number;
  waitStrategy: WaitStrategy;
  /** Milliseconds to wait after page load before closing, allowing late violations to fire (default: 2000) */
  settlementDelay: number;
}

export interface SessionConfig {
  targetUrl: string;
  crawlConfig?: Partial<CrawlConfig>;
  storageStatePath?: string;
  cookies?: CookieParam[];
  /** Maximum violations to accept per session (default: 10,000). Set to 0 for unlimited. */
  violationLimit?: number;
  /** Project identifier (from nearest package.json name field) for scoping sessions */
  project?: string;
}

export interface CookieParam {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

// ── Database entity types ──────────────────────────────────────────────────

export interface Session {
  id: string;
  targetUrl: string;
  status: SessionStatus;
  mode: SessionMode;
  config: SessionConfig;
  project: string | null;
  reportServerPort: number | null;
  proxyPort: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page {
  id: string;
  sessionId: string;
  url: string;
  statusCode: number | null;
  crawledAt: string;
}

export interface Violation {
  id: string;
  sessionId: string;
  pageId: string | null;
  documentUri: string;
  blockedUri: string;
  violatedDirective: string;
  effectiveDirective: string;
  sourceFile: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  disposition: 'enforce' | 'report';
  sample: string | null;
  capturedVia: ViolationSource;
  rawReport: string;
  createdAt: string;
}

export interface Policy {
  id: string;
  sessionId: string;
  policyHeader: string;
  directives: Record<string, string[]>;
  format: ExportFormat;
  isReportOnly: boolean;
  createdAt: string;
}

// ── Database row types (raw SQLite representation) ─────────────────────────

export interface SessionRow {
  id: string;
  target_url: string;
  status: SessionStatus;
  mode: SessionMode;
  config: string; // JSON-serialized SessionConfig
  project: string | null;
  report_server_port: number | null;
  proxy_port: number | null;
  created_at: string;
  updated_at: string;
}

export interface PageRow {
  id: number;
  session_id: string;
  url: string;
  status_code: number | null;
  crawled_at: string;
}

export interface ViolationRow {
  id: number;
  session_id: string;
  page_id: number | null;
  document_uri: string;
  blocked_uri: string;
  violated_directive: string;
  effective_directive: string;
  source_file: string | null;
  line_number: number | null;
  column_number: number | null;
  disposition: 'enforce' | 'report';
  sample: string | null;
  captured_via: ViolationSource;
  raw_report: string;
  created_at: string;
}

export interface PolicyRow {
  id: number;
  session_id: string;
  policy_header: string;
  directives: string; // JSON-serialized Record<string, string[]>
  format: ExportFormat;
  is_report_only: number; // SQLite boolean (0 or 1)
  created_at: string;
}

// ── Permissions-Policy types ─────────────────────────────────────────────────

export interface PermissionsPolicy {
  id: string;
  sessionId: string;
  pageId: string | null;
  directive: string;
  allowlist: string[];
  headerType: 'permissions-policy' | 'feature-policy';
  sourceUrl: string;
  createdAt: string;
}

export interface PermissionsPolicyRow {
  id: number;
  session_id: string;
  page_id: number | null;
  directive: string;
  allowlist: string; // JSON-serialized string[]
  header_type: 'permissions-policy' | 'feature-policy';
  source_url: string;
  created_at: string;
}

// ── Inline hash types ──────────────────────────────────────────────────────

export interface InlineHash {
  id: string;
  sessionId: string;
  pageId: string | null;
  directive: string;
  hash: string;
  contentLength: number;
  createdAt: string;
}

export interface InlineHashRow {
  id: number;
  session_id: string;
  page_id: number | null;
  directive: string;
  hash: string;
  content_length: number;
  created_at: string;
}

// ── CSP directive type ─────────────────────────────────────────────────────

export type CspDirective =
  | 'default-src'
  | 'script-src'
  | 'style-src'
  | 'img-src'
  | 'font-src'
  | 'connect-src'
  | 'media-src'
  | 'object-src'
  | 'frame-src'
  | 'worker-src'
  | 'child-src'
  | 'form-action'
  | 'base-uri'
  | 'manifest-src'
  | 'script-src-elem'
  | 'script-src-attr'
  | 'style-src-elem'
  | 'style-src-attr';
