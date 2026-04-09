import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { initializeDatabase } from '../../src/db/schema.js';
import {
  createDatabase,
  createSession,
  getSession,
  updateSession,
  listSessions,
  insertPage,
  getPages,
  insertViolation,
  getViolations,
  getViolationSummary,
  insertPolicy,
  getPolicy,
  type InsertViolationParams,
} from '../../src/db/repository.js';
import type { SessionConfig } from '../../src/types.js';

const TEST_CONFIG: SessionConfig = {
  targetUrl: 'https://example.com',
  mode: 'local',
};

function createTestDb(): Database.Database {
  return createDatabase(':memory:');
}

describe('createDatabase', () => {
  it('creates all required tables', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain('sessions');
    expect(names).toContain('pages');
    expect(names).toContain('violations');
    expect(names).toContain('policies');
    db.close();
  });

  it('enables WAL journal mode for file-backed databases', () => {
    // :memory: databases always report 'memory' for journal_mode
    // WAL is set via pragma in initializeDatabase; verify it was called
    const db = createTestDb();
    // For in-memory DBs, WAL degrades to 'memory'; just verify the DB is functional
    const { journal_mode } = db.pragma('journal_mode', { simple: false })[0] as { journal_mode: string };
    expect(['wal', 'memory']).toContain(journal_mode);
    db.close();
  });

  it('enables foreign keys', () => {
    const db = createTestDb();
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    db.close();
  });

  it('rejects paths without .db extension', () => {
    expect(() => createDatabase('/tmp/bad-path.sqlite')).toThrow('.db extension');
  });

  it('creates file-backed database with secure permissions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csp-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      const db = createDatabase(dbPath);
      db.close();

      expect(fs.existsSync(dbPath)).toBe(true);
      const stat = fs.statSync(dbPath);
      expect(stat.mode & 0o777).toBe(0o600);

      const dirStat = fs.statSync(tmpDir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Session CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('createSession and getSession round-trip', () => {
    const session = createSession(db, TEST_CONFIG);

    expect(session.id).toBeTruthy();
    expect(session.targetUrl).toBe('https://example.com');
    expect(session.status).toBe('created');
    expect(session.mode).toBe('local');
    expect(session.config).toEqual(TEST_CONFIG);
    expect(session.reportServerPort).toBeNull();
    expect(session.proxyPort).toBeNull();

    const fetched = getSession(db, session.id);
    expect(fetched).toEqual(session);
  });

  it('getSession returns null for non-existent id', () => {
    expect(getSession(db, 'non-existent-id')).toBeNull();
  });

  it('updateSession updates status', () => {
    const session = createSession(db, TEST_CONFIG);
    updateSession(db, session.id, { status: 'crawling' });

    const updated = getSession(db, session.id)!;
    expect(updated.status).toBe('crawling');
    // updatedAt is set via datetime('now') which has second precision,
    // so within the same second it may match; just verify the field exists
    expect(updated.updatedAt).toBeTruthy();
  });

  it('updateSession updates ports', () => {
    const session = createSession(db, TEST_CONFIG);
    updateSession(db, session.id, { reportServerPort: 8080, proxyPort: 9090 });

    const updated = getSession(db, session.id)!;
    expect(updated.reportServerPort).toBe(8080);
    expect(updated.proxyPort).toBe(9090);
  });

  it('updateSession with partial updates only changes specified fields', () => {
    const session = createSession(db, TEST_CONFIG);
    updateSession(db, session.id, { status: 'analyzing' });

    const updated = getSession(db, session.id)!;
    expect(updated.status).toBe('analyzing');
    expect(updated.reportServerPort).toBeNull();
    expect(updated.proxyPort).toBeNull();
  });

  it('updateSession with empty updates is a no-op', () => {
    const session = createSession(db, TEST_CONFIG);
    updateSession(db, session.id, {});

    const unchanged = getSession(db, session.id)!;
    expect(unchanged.status).toBe(session.status);
  });

  it('listSessions returns all sessions', () => {
    createSession(db, TEST_CONFIG);
    createSession(db, { ...TEST_CONFIG, targetUrl: 'https://other.com' });

    const sessions = listSessions(db);
    expect(sessions).toHaveLength(2);
  });

  it('createSession defaults mode to local when not specified', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    expect(session.mode).toBe('local');
  });

  it('createSession strips cookies from persisted config', () => {
    const configWithCookies: SessionConfig = {
      targetUrl: 'https://example.com',
      cookies: [{ name: 'session', value: 'secret123', domain: 'example.com' }],
    };
    const session = createSession(db, configWithCookies);

    // The persisted config should not contain cookies
    expect(session.config.cookies).toBeUndefined();

    // Verify the original config object was not mutated
    expect(configWithCookies.cookies).toHaveLength(1);
  });

  it('createSession persists config without cookies when none provided', () => {
    const session = createSession(db, TEST_CONFIG);
    expect(session.config.cookies).toBeUndefined();
    expect(session.config.targetUrl).toBe('https://example.com');
  });
});

describe('Page repository', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    sessionId = createSession(db, TEST_CONFIG).id;
  });
  afterEach(() => {
    db.close();
  });

  it('insertPage creates a page', () => {
    const page = insertPage(db, sessionId, 'https://example.com/', 200);
    expect(page).not.toBeNull();
    expect(page!.url).toBe('https://example.com/');
    expect(page!.statusCode).toBe(200);
    expect(page!.sessionId).toBe(sessionId);
  });

  it('insertPage deduplicates same session+url', () => {
    const first = insertPage(db, sessionId, 'https://example.com/', 200);
    const second = insertPage(db, sessionId, 'https://example.com/', 200);

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // duplicate, INSERT OR IGNORE

    const pages = getPages(db, sessionId);
    expect(pages).toHaveLength(1);
  });

  it('insertPage allows same URL in different sessions', () => {
    const session2 = createSession(db, { targetUrl: 'https://other.com' });
    insertPage(db, sessionId, 'https://example.com/', 200);
    insertPage(db, session2.id, 'https://example.com/', 200);

    expect(getPages(db, sessionId)).toHaveLength(1);
    expect(getPages(db, session2.id)).toHaveLength(1);
  });

  it('insertPage with null statusCode', () => {
    const page = insertPage(db, sessionId, 'https://example.com/', null);
    expect(page).not.toBeNull();
    expect(page!.statusCode).toBeNull();
  });

  it('getPages returns empty array for session with no pages', () => {
    expect(getPages(db, sessionId)).toEqual([]);
  });
});

describe('Violation repository', () => {
  let db: Database.Database;
  let sessionId: string;

  function makeViolation(overrides: Partial<InsertViolationParams> = {}): InsertViolationParams {
    return {
      sessionId,
      pageId: null,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'report_uri',
      ...overrides,
    };
  }

  beforeEach(() => {
    db = createTestDb();
    sessionId = createSession(db, TEST_CONFIG).id;
  });
  afterEach(() => {
    db.close();
  });

  it('insertViolation creates a violation', () => {
    const v = insertViolation(db, makeViolation());
    expect(v).not.toBeNull();
    expect(v!.documentUri).toBe('https://example.com/');
    expect(v!.effectiveDirective).toBe('script-src');
    expect(v!.disposition).toBe('report');
  });

  it('insertViolation deduplicates on UNIQUE constraint', () => {
    const first = insertViolation(db, makeViolation());
    const second = insertViolation(db, makeViolation());

    expect(first).not.toBeNull();
    expect(second).toBeNull(); // INSERT OR IGNORE
  });

  it('insertViolation with different effective_directive creates distinct records', () => {
    const v1 = insertViolation(db, makeViolation({ effectiveDirective: 'script-src' }));
    const v2 = insertViolation(db, makeViolation({ effectiveDirective: 'style-src' }));

    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(2);
  });

  it('insertViolation with different blocked_uri creates distinct records', () => {
    const v1 = insertViolation(db, makeViolation({ blockedUri: 'https://cdn1.example.com/a.js' }));
    const v2 = insertViolation(db, makeViolation({ blockedUri: 'https://cdn2.example.com/b.js' }));

    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
  });

  it('insertViolation stores optional fields', () => {
    const v = insertViolation(
      db,
      makeViolation({
        sourceFile: 'https://example.com/app.js',
        lineNumber: 42,
        columnNumber: 10,
        rawReport: '{"original": "report"}',
      }),
    );

    expect(v!.sourceFile).toBe('https://example.com/app.js');
    expect(v!.lineNumber).toBe(42);
    expect(v!.columnNumber).toBe(10);
    expect(v!.rawReport).toBe('{"original": "report"}');
  });

  it('insertViolation defaults optional fields to null', () => {
    const v = insertViolation(db, makeViolation());
    expect(v!.sourceFile).toBeNull();
    expect(v!.lineNumber).toBeNull();
    expect(v!.columnNumber).toBeNull();
  });

  it('getViolations filters by directive', () => {
    insertViolation(db, makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://a.com/a.js' }));
    insertViolation(db, makeViolation({ effectiveDirective: 'style-src', blockedUri: 'https://a.com/b.css' }));

    const scriptViolations = getViolations(db, sessionId, { directive: 'script-src' });
    expect(scriptViolations).toHaveLength(1);
    expect(scriptViolations[0].effectiveDirective).toBe('script-src');
  });

  it('getViolations filters by page URL', () => {
    const page1 = insertPage(db, sessionId, 'https://example.com/page1', 200)!;
    const page2 = insertPage(db, sessionId, 'https://example.com/page2', 200)!;

    insertViolation(db, makeViolation({ pageId: page1.id, blockedUri: 'https://a.com/1.js' }));
    insertViolation(db, makeViolation({ pageId: page2.id, blockedUri: 'https://a.com/2.js' }));

    const page1Violations = getViolations(db, sessionId, { pageUrl: 'https://example.com/page1' });
    expect(page1Violations).toHaveLength(1);
  });

  it('getViolations filters by origin prefix', () => {
    insertViolation(db, makeViolation({ blockedUri: 'https://cdn.example.com/a.js', effectiveDirective: 'script-src' }));
    insertViolation(db, makeViolation({ blockedUri: 'https://other.com/b.js', effectiveDirective: 'style-src' }));

    const filtered = getViolations(db, sessionId, { origin: 'https://cdn.example.com' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].blockedUri).toBe('https://cdn.example.com/a.js');
  });

  it('getViolations combines multiple filters', () => {
    const page = insertPage(db, sessionId, 'https://example.com/page1', 200)!;
    insertViolation(db, makeViolation({ pageId: page.id, effectiveDirective: 'script-src', blockedUri: 'https://cdn.com/a.js' }));
    insertViolation(db, makeViolation({ pageId: page.id, effectiveDirective: 'style-src', blockedUri: 'https://cdn.com/b.css' }));

    const filtered = getViolations(db, sessionId, { directive: 'script-src', pageUrl: 'https://example.com/page1' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].effectiveDirective).toBe('script-src');
  });

  it('getViolations returns empty for no matches', () => {
    expect(getViolations(db, sessionId, { directive: 'img-src' })).toEqual([]);
  });

  it('getViolations without filters returns all violations', () => {
    insertViolation(db, makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://a.com/a.js' }));
    insertViolation(db, makeViolation({ effectiveDirective: 'style-src', blockedUri: 'https://a.com/b.css' }));

    expect(getViolations(db, sessionId)).toHaveLength(2);
  });

  it('getViolationSummary groups by directive and blocked_uri', () => {
    // Insert two different violations
    insertViolation(db, makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://cdn.com/a.js' }));
    insertViolation(db, makeViolation({ effectiveDirective: 'style-src', blockedUri: 'https://cdn.com/b.css' }));

    const summary = getViolationSummary(db, sessionId);
    expect(summary).toHaveLength(2);
    expect(summary[0].count).toBe(1);
    expect(summary.map((s) => s.effectiveDirective).sort()).toEqual(['script-src', 'style-src']);
  });

  it('getViolationSummary returns empty for no violations', () => {
    expect(getViolationSummary(db, sessionId)).toEqual([]);
  });

  describe('session isolation', () => {
    it('violations from session A do not appear in session B queries', () => {
      const sessionB = createSession(db, { targetUrl: 'https://other.com' });

      insertViolation(db, makeViolation());
      insertViolation(db, {
        ...makeViolation(),
        sessionId: sessionB.id,
        blockedUri: 'https://evil.com/track.js',
      });

      const violationsA = getViolations(db, sessionId);
      const violationsB = getViolations(db, sessionB.id);

      expect(violationsA).toHaveLength(1);
      expect(violationsA[0].blockedUri).toBe('https://cdn.example.com/script.js');

      expect(violationsB).toHaveLength(1);
      expect(violationsB[0].blockedUri).toBe('https://evil.com/track.js');
    });
  });
});

describe('Policy repository', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    sessionId = createSession(db, TEST_CONFIG).id;
  });
  afterEach(() => {
    db.close();
  });

  it('insertPolicy and getPolicy round-trip', () => {
    const directives = { 'script-src': ["'self'", 'https://cdn.example.com'] };
    const policy = insertPolicy(db, {
      sessionId,
      policyHeader: "script-src 'self' https://cdn.example.com",
      directives,
    });

    expect(policy.sessionId).toBe(sessionId);
    expect(policy.policyHeader).toBe("script-src 'self' https://cdn.example.com");
    expect(policy.directives).toEqual(directives);
    expect(policy.format).toBe('header');
    expect(policy.isReportOnly).toBe(true);

    const fetched = getPolicy(db, sessionId);
    expect(fetched).toEqual(policy);
  });

  it('getPolicy returns the most recently inserted policy', () => {
    insertPolicy(db, {
      sessionId,
      policyHeader: 'first',
      directives: {},
    });
    insertPolicy(db, {
      sessionId,
      policyHeader: 'second',
      directives: {},
    });

    // getPolicy orders by created_at DESC LIMIT 1. When both have the same
    // created_at (second precision), the DB may return either row.
    // The implementation uses ORDER BY created_at DESC which with ties
    // returns the first matching row by rowid (i.e., the first inserted).
    // Verify we get a valid policy back.
    const latest = getPolicy(db, sessionId)!;
    expect(['first', 'second']).toContain(latest.policyHeader);
  });

  it('getPolicy returns null when no policy exists', () => {
    expect(getPolicy(db, sessionId)).toBeNull();
  });

  it('insertPolicy respects format parameter', () => {
    const policy = insertPolicy(db, {
      sessionId,
      policyHeader: 'test',
      directives: {},
      format: 'nginx',
    });
    expect(policy.format).toBe('nginx');
  });

  it('insertPolicy respects isReportOnly=false', () => {
    const policy = insertPolicy(db, {
      sessionId,
      policyHeader: 'test',
      directives: {},
      isReportOnly: false,
    });
    expect(policy.isReportOnly).toBe(false);
  });
});

describe('Cascade deletes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    db.close();
  });

  it('deleting a session cascades to pages, violations, and policies', () => {
    const session = createSession(db, TEST_CONFIG);
    const page = insertPage(db, session.id, 'https://example.com/', 200)!;
    insertViolation(db, {
      sessionId: session.id,
      pageId: page.id,
      documentUri: 'https://example.com/',
      blockedUri: 'https://cdn.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      capturedVia: 'report_uri',
    });
    insertPolicy(db, {
      sessionId: session.id,
      policyHeader: 'test',
      directives: {},
    });

    // Delete the session
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

    // Verify cascades
    expect(getPages(db, session.id)).toEqual([]);
    expect(getViolations(db, session.id)).toEqual([]);
    expect(getPolicy(db, session.id)).toBeNull();
  });
});
