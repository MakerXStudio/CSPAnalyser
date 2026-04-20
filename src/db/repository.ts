import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { initializeDatabase } from './schema.js';
import { createLogger } from '../utils/logger.js';
import {
  validateDbPath,
  ensureDataDirectory,
  setSecureFilePermissions,
} from '../utils/file-utils.js';
import type {
  Session,
  SessionConfig,
  SessionRow,
  Page,
  PageRow,
  Violation,
  ViolationRow,
  ViolationSource,
  Policy,
  PolicyRow,
  ExportFormat,
  PermissionsPolicy,
  PermissionsPolicyRow,
  InlineHash,
  InlineHashRow,
  ExistingCspHeader,
  ExistingCspHeaderRow,
  ExistingCspHeaderType,
} from '../types.js';

const logger = createLogger();

// ── Row → Entity mappers ─────────────────────────────────────────────────

/**
 * Safely parses a JSON string from a database column.
 * Returns the fallback value if parsing fails (e.g. corrupted DB data),
 * preventing an unhandled exception from crashing the process.
 */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T, context: string): T {
  try {
    return JSON.parse(raw ?? JSON.stringify(fallback)) as T;
  } catch {
    logger.warn('Failed to parse JSON from database column', { context, raw: raw?.slice(0, 100) });
    return fallback;
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    targetUrl: row.target_url,
    status: row.status,
    mode: row.mode,
    config: safeJsonParse<SessionConfig>(row.config, {} as SessionConfig, 'sessions.config'),
    project: row.project,
    reportServerPort: row.report_server_port,
    proxyPort: row.proxy_port,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPage(row: PageRow): Page {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    url: row.url,
    statusCode: row.status_code,
    crawledAt: row.crawled_at,
  };
}

function toViolation(row: ViolationRow): Violation {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    pageId: row.page_id != null ? String(row.page_id) : null,
    documentUri: row.document_uri,
    blockedUri: row.blocked_uri,
    violatedDirective: row.violated_directive,
    effectiveDirective: row.effective_directive,
    sourceFile: row.source_file,
    lineNumber: row.line_number,
    columnNumber: row.column_number,
    disposition: row.disposition,
    sample: row.sample,
    capturedVia: row.captured_via,
    rawReport: row.raw_report,
    createdAt: row.created_at,
  };
}

function toPolicy(row: PolicyRow): Policy {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    policyHeader: row.policy_header,
    directives: safeJsonParse<Record<string, string[]>>(row.directives, {}, 'policies.directives'),
    format: row.format,
    isReportOnly: row.is_report_only === 1,
    createdAt: row.created_at,
  };
}

// ── SQL helpers ──────────────────────────────────────────────────────────

/**
 * Escapes SQL LIKE metacharacters (%, _, \) so they are matched literally.
 * Used with the ESCAPE '\' clause.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ── Database factory ──────────────────────────────────────────────────────

export function createDatabase(dbPath: string): Database.Database {
  const validatedPath = validateDbPath(dbPath);

  if (validatedPath !== ':memory:') {
    ensureDataDirectory(path.dirname(validatedPath));
  }

  const db = new Database(validatedPath);
  initializeDatabase(db);

  if (validatedPath !== ':memory:') {
    setSecureFilePermissions(validatedPath);
  }

  return db;
}

// ── Session repository ────────────────────────────────────────────────────

export function createSession(db: Database.Database, config: SessionConfig): Session {
  const id = randomUUID();

  // Strip cookies from the persisted config — they should only be used ephemerally
  const persistConfig = { ...config };
  if (persistConfig.cookies) {
    logger.warn(
      'Cookies provided for session authentication; they will not be persisted to the database for security',
    );
    delete persistConfig.cookies;
  }

  const stmt = db.prepare(`
    INSERT INTO sessions (id, target_url, status, mode, config, project)
    VALUES (?, ?, 'created', ?, ?, ?)
  `);
  stmt.run(id, config.targetUrl, 'local', JSON.stringify(persistConfig), config.project ?? null);
  const session = getSession(db, id);
  if (!session) {
    throw new Error(`Failed to retrieve session after insert: ${id}`);
  }
  return session;
}

export function updateSession(
  db: Database.Database,
  id: string,
  updates: Partial<Pick<Session, 'status' | 'reportServerPort'>>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.status !== undefined) {
    sets.push('status = ?');
    params.push(updates.status);
  }
  if (updates.reportServerPort !== undefined) {
    sets.push('report_server_port = ?');
    params.push(updates.reportServerPort);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getSession(db: Database.Database, id: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function listSessions(db: Database.Database): Session[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all() as SessionRow[];
  return rows.map(toSession);
}

/**
 * Lists sessions scoped to a specific project.
 * Returns sessions that match the given project name, plus sessions with no
 * project set (created from a global CLI context) — those are always visible
 * regardless of the caller's project context.
 */
export function listSessionsByProject(db: Database.Database, project: string): Session[] {
  const rows = db
    .prepare('SELECT * FROM sessions WHERE project = ? OR project IS NULL ORDER BY created_at DESC')
    .all(project) as SessionRow[];
  return rows.map(toSession);
}

/**
 * Returns the most recent completed session, optionally scoped to a project.
 * When project is provided, only sessions for that project (or sessions with
 * no project set) are considered. Does NOT fall back across projects — this
 * prevents silently exporting or scoring the wrong session.
 */
export function getLatestSession(db: Database.Database, project?: string | null): Session | null {
  if (project) {
    const row = db
      .prepare(
        `SELECT * FROM sessions WHERE (project = ? OR project IS NULL) AND status = 'complete'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(project) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  // No project context — return the most recent completed session
  const row = db
    .prepare(
      `SELECT * FROM sessions WHERE status = 'complete'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as SessionRow | undefined;
  return row ? toSession(row) : null;
}

// ── Page repository ───────────────────────────────────────────────────────

export function insertPage(
  db: Database.Database,
  sessionId: string,
  url: string,
  statusCode: number | null,
): Page | null {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO pages (session_id, url, status_code)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(sessionId, url, statusCode);
  if (result.changes === 0) return null;

  const row = db.prepare('SELECT * FROM pages WHERE id = ?').get(result.lastInsertRowid) as PageRow;
  return toPage(row);
}

/**
 * Returns an existing page record for the given session+URL, or inserts a new one.
 * Unlike insertPage, this never returns null — it always provides a page ID.
 */
export function getOrInsertPage(
  db: Database.Database,
  sessionId: string,
  url: string,
  statusCode: number | null,
): Page {
  const inserted = insertPage(db, sessionId, url, statusCode);
  if (inserted) return inserted;

  // Already exists — look it up
  const row = db
    .prepare('SELECT * FROM pages WHERE session_id = ? AND url = ?')
    .get(sessionId, url) as PageRow;
  return toPage(row);
}

export function updatePageStatusCode(
  db: Database.Database,
  pageId: string,
  statusCode: number | null,
): void {
  db.prepare('UPDATE pages SET status_code = ? WHERE id = ?').run(statusCode, Number(pageId));
}

export function getPages(db: Database.Database, sessionId: string): Page[] {
  const rows = db
    .prepare('SELECT * FROM pages WHERE session_id = ? ORDER BY crawled_at')
    .all(sessionId) as PageRow[];
  return rows.map(toPage);
}

// ── Violation repository ──────────────────────────────────────────────────

export interface InsertViolationParams {
  sessionId: string;
  pageId: string | null;
  documentUri: string;
  blockedUri: string;
  violatedDirective: string;
  effectiveDirective: string;
  sourceFile?: string | null;
  lineNumber?: number | null;
  columnNumber?: number | null;
  disposition?: 'enforce' | 'report';
  sample?: string | null;
  capturedVia: ViolationSource;
  rawReport?: string | null;
}

export function insertViolation(db: Database.Database, v: InsertViolationParams): Violation | null {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO violations
      (session_id, page_id, document_uri, blocked_uri, violated_directive,
       effective_directive, source_file, line_number, column_number,
       disposition, sample, captured_via, raw_report)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    v.sessionId,
    v.pageId != null ? Number(v.pageId) : null,
    v.documentUri,
    v.blockedUri,
    v.violatedDirective,
    v.effectiveDirective,
    v.sourceFile ?? null,
    v.lineNumber ?? null,
    v.columnNumber ?? null,
    v.disposition ?? 'report',
    v.sample ?? null,
    v.capturedVia,
    v.rawReport ?? null,
  );
  if (result.changes === 0) return null;

  const row = db
    .prepare('SELECT * FROM violations WHERE id = ?')
    .get(result.lastInsertRowid) as ViolationRow;
  return toViolation(row);
}

export interface ViolationFilters {
  directive?: string;
  pageUrl?: string;
  origin?: string;
  disposition?: 'enforce' | 'report';
}

export function getViolations(
  db: Database.Database,
  sessionId: string,
  filters?: ViolationFilters,
): Violation[] {
  const conditions = ['v.session_id = ?'];
  const params: unknown[] = [sessionId];

  if (filters?.directive) {
    conditions.push('v.effective_directive = ?');
    params.push(filters.directive);
  }
  if (filters?.pageUrl) {
    conditions.push('p.url = ?');
    params.push(filters.pageUrl);
  }
  if (filters?.origin) {
    conditions.push("v.blocked_uri LIKE ? ESCAPE '\\'");
    const escapedOrigin = escapeLikePattern(filters.origin);
    params.push(`${escapedOrigin}%`);
  }
  if (filters?.disposition) {
    conditions.push('v.disposition = ?');
    params.push(filters.disposition);
  }

  const needsJoin = filters?.pageUrl != null;
  const from = needsJoin ? 'violations v LEFT JOIN pages p ON v.page_id = p.id' : 'violations v';

  const rows = db
    .prepare(`SELECT v.* FROM ${from} WHERE ${conditions.join(' AND ')} ORDER BY v.created_at`)
    .all(...params) as ViolationRow[];

  return rows.map(toViolation);
}

export interface ViolationSummaryEntry {
  effectiveDirective: string;
  blockedUri: string;
  count: number;
}

export function getViolationSummary(
  db: Database.Database,
  sessionId: string,
): ViolationSummaryEntry[] {
  const rows = db
    .prepare(
      `SELECT effective_directive, blocked_uri, COUNT(*) as count
       FROM violations
       WHERE session_id = ?
       GROUP BY effective_directive, blocked_uri
       ORDER BY count DESC`,
    )
    .all(sessionId) as Array<{ effective_directive: string; blocked_uri: string; count: number }>;

  return rows.map((r) => ({
    effectiveDirective: r.effective_directive,
    blockedUri: r.blocked_uri,
    count: r.count,
  }));
}

// ── Policy repository ─────────────────────────────────────────────────────

export interface InsertPolicyParams {
  sessionId: string;
  policyHeader: string;
  directives: Record<string, string[]>;
  format?: ExportFormat;
  isReportOnly?: boolean;
}

export function insertPolicy(db: Database.Database, p: InsertPolicyParams): Policy {
  const stmt = db.prepare(`
    INSERT INTO policies (session_id, policy_header, directives, format, is_report_only)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    p.sessionId,
    p.policyHeader,
    JSON.stringify(p.directives),
    p.format ?? 'header',
    p.isReportOnly !== false ? 1 : 0,
  );

  const row = db
    .prepare('SELECT * FROM policies WHERE id = ?')
    .get(result.lastInsertRowid) as PolicyRow;
  return toPolicy(row);
}

export function getPolicy(db: Database.Database, sessionId: string): Policy | null {
  const row = db
    .prepare('SELECT * FROM policies WHERE session_id = ? ORDER BY id DESC LIMIT 1')
    .get(sessionId) as PolicyRow | undefined;
  return row ? toPolicy(row) : null;
}

// ── Permissions-Policy repository ────────────────────────────────────────

function toPermissionsPolicy(row: PermissionsPolicyRow): PermissionsPolicy {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    pageId: row.page_id != null ? String(row.page_id) : null,
    directive: row.directive,
    allowlist: safeJsonParse<string[]>(row.allowlist, [], 'permissions_policies.allowlist'),
    headerType: row.header_type,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
  };
}

export interface InsertPermissionsPolicyParams {
  sessionId: string;
  pageId: string | null;
  directive: string;
  allowlist: string[];
  headerType: 'permissions-policy' | 'feature-policy';
  sourceUrl: string;
}

export function insertPermissionsPolicy(
  db: Database.Database,
  p: InsertPermissionsPolicyParams,
): PermissionsPolicy | null {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO permissions_policies
      (session_id, page_id, directive, allowlist, header_type, source_url)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    p.sessionId,
    p.pageId != null ? Number(p.pageId) : null,
    p.directive,
    JSON.stringify(p.allowlist),
    p.headerType,
    p.sourceUrl,
  );
  if (result.changes === 0) return null;

  const row = db
    .prepare('SELECT * FROM permissions_policies WHERE id = ?')
    .get(result.lastInsertRowid) as PermissionsPolicyRow;
  return toPermissionsPolicy(row);
}

export function getPermissionsPolicies(
  db: Database.Database,
  sessionId: string,
): PermissionsPolicy[] {
  const rows = db
    .prepare(
      'SELECT * FROM permissions_policies WHERE session_id = ? ORDER BY directive, created_at',
    )
    .all(sessionId) as PermissionsPolicyRow[];
  return rows.map(toPermissionsPolicy);
}

export function getPermissionsPolicyByDirective(
  db: Database.Database,
  sessionId: string,
  directive: string,
): PermissionsPolicy[] {
  const rows = db
    .prepare(
      'SELECT * FROM permissions_policies WHERE session_id = ? AND directive = ? ORDER BY created_at',
    )
    .all(sessionId, directive) as PermissionsPolicyRow[];
  return rows.map(toPermissionsPolicy);
}

// ── Inline hash repository ──────────────────────────────────────────────────

function toInlineHash(row: InlineHashRow): InlineHash {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    pageId: row.page_id != null ? String(row.page_id) : null,
    directive: row.directive,
    hash: row.hash,
    contentLength: row.content_length,
    createdAt: row.created_at,
  };
}

export interface InsertInlineHashParams {
  sessionId: string;
  pageId: string | null;
  directive: string;
  hash: string;
  contentLength: number;
}

export function insertInlineHash(
  db: Database.Database,
  p: InsertInlineHashParams,
): InlineHash | null {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO inline_hashes
      (session_id, page_id, directive, hash, content_length)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    p.sessionId,
    p.pageId != null ? Number(p.pageId) : null,
    p.directive,
    p.hash,
    p.contentLength,
  );
  if (result.changes === 0) return null;

  const row = db
    .prepare('SELECT * FROM inline_hashes WHERE id = ?')
    .get(result.lastInsertRowid) as InlineHashRow;
  return toInlineHash(row);
}

export function getInlineHashes(db: Database.Database, sessionId: string): InlineHash[] {
  const rows = db
    .prepare('SELECT * FROM inline_hashes WHERE session_id = ? ORDER BY directive, hash')
    .all(sessionId) as InlineHashRow[];
  return rows.map(toInlineHash);
}

// ── Existing CSP header repository ──────────────────────────────────────

function toExistingCspHeader(row: ExistingCspHeaderRow): ExistingCspHeader {
  return {
    id: String(row.id),
    sessionId: row.session_id,
    pageId: row.page_id != null ? String(row.page_id) : null,
    headerType: row.header_type,
    headerValue: row.header_value,
    sourceUrl: row.source_url,
    createdAt: row.created_at,
  };
}

export interface InsertExistingCspHeaderParams {
  sessionId: string;
  pageId: string | null;
  headerType: ExistingCspHeaderType;
  headerValue: string;
  sourceUrl: string;
}

export function insertExistingCspHeader(
  db: Database.Database,
  p: InsertExistingCspHeaderParams,
): ExistingCspHeader | null {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO existing_csp_headers
      (session_id, page_id, header_type, header_value, source_url)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    p.sessionId,
    p.pageId != null ? Number(p.pageId) : null,
    p.headerType,
    p.headerValue,
    p.sourceUrl,
  );
  if (result.changes === 0) return null;

  const row = db
    .prepare('SELECT * FROM existing_csp_headers WHERE id = ?')
    .get(result.lastInsertRowid) as ExistingCspHeaderRow;
  return toExistingCspHeader(row);
}

export function getExistingCspHeaders(
  db: Database.Database,
  sessionId: string,
  headerType?: ExistingCspHeaderType,
): ExistingCspHeader[] {
  if (headerType) {
    const rows = db
      .prepare(
        'SELECT * FROM existing_csp_headers WHERE session_id = ? AND header_type = ? ORDER BY created_at',
      )
      .all(sessionId, headerType) as ExistingCspHeaderRow[];
    return rows.map(toExistingCspHeader);
  }

  const rows = db
    .prepare('SELECT * FROM existing_csp_headers WHERE session_id = ? ORDER BY created_at')
    .all(sessionId) as ExistingCspHeaderRow[];
  return rows.map(toExistingCspHeader);
}
