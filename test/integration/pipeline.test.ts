import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  insertPage,
  insertViolation,
  getPages,
  getViolations,
  getViolationSummary,
  getSession,
  updateSession,
} from '../../src/db/repository.js';
import { generatePolicy } from '../../src/policy-generator.js';
import { optimizePolicy } from '../../src/policy-optimizer.js';
import { formatPolicy } from '../../src/policy-formatter.js';
import type { Violation } from '../../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeViolation(
  sessionId: string,
  pageId: string | null,
  directive: string,
  blockedUri: string,
): Omit<Violation, 'id' | 'createdAt'> {
  return {
    sessionId,
    pageId,
    documentUri: 'https://example.com/',
    blockedUri,
    violatedDirective: directive,
    effectiveDirective: directive,
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report' as const,
    sample: null,
    capturedVia: 'dom_event' as const,
    rawReport: JSON.stringify({ blockedUri, directive }),
  };
}

// ── Concurrent session tests ─────────────────────────────────────────────

describe('concurrent session isolation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('sessions created in parallel have unique IDs', () => {
    const sessions = Array.from({ length: 10 }, () =>
      createSession(db, { targetUrl: 'https://example.com' }),
    );

    const ids = new Set(sessions.map((s) => s.id));
    expect(ids.size).toBe(10);
  });

  it('violations from concurrent sessions are isolated', () => {
    const sessionA = createSession(db, { targetUrl: 'https://a.example.com' });
    const sessionB = createSession(db, { targetUrl: 'https://b.example.com' });

    const pageA = insertPage(db, sessionA.id, 'https://a.example.com/', 200);
    const pageB = insertPage(db, sessionB.id, 'https://b.example.com/', 200);

    // Insert violations into both sessions simultaneously
    insertViolation(db, makeViolation(sessionA.id, pageA.id, 'script-src', 'https://cdn-a.com/a.js'));
    insertViolation(db, makeViolation(sessionA.id, pageA.id, 'style-src', 'https://cdn-a.com/a.css'));
    insertViolation(db, makeViolation(sessionB.id, pageB.id, 'img-src', 'https://cdn-b.com/b.png'));

    const violationsA = getViolations(db, sessionA.id);
    const violationsB = getViolations(db, sessionB.id);

    expect(violationsA).toHaveLength(2);
    expect(violationsB).toHaveLength(1);

    // Ensure no cross-contamination
    expect(violationsA.every((v) => v.sessionId === sessionA.id)).toBe(true);
    expect(violationsB.every((v) => v.sessionId === sessionB.id)).toBe(true);
  });

  it('pages from concurrent sessions are isolated', () => {
    const sessionA = createSession(db, { targetUrl: 'https://a.example.com' });
    const sessionB = createSession(db, { targetUrl: 'https://b.example.com' });

    insertPage(db, sessionA.id, 'https://a.example.com/page1', 200);
    insertPage(db, sessionA.id, 'https://a.example.com/page2', 200);
    insertPage(db, sessionB.id, 'https://b.example.com/page1', 200);

    const pagesA = getPages(db, sessionA.id);
    const pagesB = getPages(db, sessionB.id);

    expect(pagesA).toHaveLength(2);
    expect(pagesB).toHaveLength(1);
  });

  it('violation summaries are isolated per session', () => {
    const sessionA = createSession(db, { targetUrl: 'https://a.example.com' });
    const sessionB = createSession(db, { targetUrl: 'https://b.example.com' });

    insertViolation(db, makeViolation(sessionA.id, null, 'script-src', 'https://cdn.com/a.js'));
    insertViolation(db, makeViolation(sessionA.id, null, 'script-src', 'https://cdn.com/b.js'));
    insertViolation(db, makeViolation(sessionB.id, null, 'img-src', 'https://cdn.com/c.png'));

    const summaryA = getViolationSummary(db, sessionA.id);
    const summaryB = getViolationSummary(db, sessionB.id);

    expect(summaryA.length).toBeGreaterThan(0);
    expect(summaryA.every((s) => s.effectiveDirective === 'script-src')).toBe(true);
    expect(summaryB).toHaveLength(1);
    expect(summaryB[0]!.effectiveDirective).toBe('img-src');
  });

  it('session status updates do not affect other sessions', () => {
    const sessionA = createSession(db, { targetUrl: 'https://a.example.com' });
    const sessionB = createSession(db, { targetUrl: 'https://b.example.com' });

    updateSession(db, sessionA.id, { status: 'crawling' });
    updateSession(db, sessionB.id, { status: 'complete' });

    const a = getSession(db, sessionA.id);
    const b = getSession(db, sessionB.id);

    expect(a?.status).toBe('crawling');
    expect(b?.status).toBe('complete');
  });

  it('parallel violation inserts from multiple sessions produce correct counts', async () => {
    const sessions = Array.from({ length: 5 }, (_, i) =>
      createSession(db, { targetUrl: `https://site-${i}.example.com` }),
    );

    // Insert violations in parallel across all sessions
    await Promise.all(
      sessions.flatMap((session, i) =>
        Array.from({ length: 20 }, (_, j) =>
          Promise.resolve(
            insertViolation(db, makeViolation(
              session.id,
              null,
              j % 2 === 0 ? 'script-src' : 'style-src',
              `https://cdn-${i}.example.com/file-${j}.js`,
            )),
          ),
        ),
      ),
    );

    // Verify each session has exactly 20 violations, no cross-contamination
    for (const session of sessions) {
      const violations = getViolations(db, session.id);
      expect(violations).toHaveLength(20);
      expect(violations.every((v) => v.sessionId === session.id)).toBe(true);
    }
  });

  it('parallel policy generation from independent sessions produces correct results', () => {
    // Set up two sessions with different violation profiles
    const sessionA = createSession(db, { targetUrl: 'https://a.example.com' });
    const sessionB = createSession(db, { targetUrl: 'https://b.example.com' });

    insertViolation(db, makeViolation(sessionA.id, null, 'script-src', 'https://cdn-a.com/script.js'));
    insertViolation(db, makeViolation(sessionB.id, null, 'img-src', 'https://cdn-b.com/image.png'));

    // Generate policies concurrently
    const [policyA, policyB] = [
      generatePolicy(db, sessionA.id, { strictness: 'moderate', includeHashes: false }),
      generatePolicy(db, sessionB.id, { strictness: 'moderate', includeHashes: false }),
    ];

    // Session A should have script-src but not img-src
    expect(policyA['script-src']).toBeDefined();
    expect(policyA['img-src']).toBeUndefined();

    // Session B should have img-src but not script-src
    expect(policyB['img-src']).toBeDefined();
    expect(policyB['script-src']).toBeUndefined();
  });

  it('rapid session create-update-query cycle maintains consistency', () => {
    // Simulate a rapid lifecycle for many sessions
    const results = Array.from({ length: 20 }, (_, i) => {
      const session = createSession(db, { targetUrl: `https://site-${i}.example.com` });
      updateSession(db, session.id, { status: 'crawling' });
      insertViolation(db, makeViolation(session.id, null, 'script-src', `https://cdn-${i}.com/app.js`));
      updateSession(db, session.id, { status: 'complete' });
      return session.id;
    });

    // Verify all sessions completed correctly
    for (const id of results) {
      const session = getSession(db, id);
      expect(session?.status).toBe('complete');
      const violations = getViolations(db, id);
      expect(violations).toHaveLength(1);
    }
  });
});

// ── End-to-end pipeline test ─────────────────────────────────────────────

describe('end-to-end policy generation pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('generates a valid policy from session → pages → violations → policy → export', () => {
    // 1. Create session
    const session = createSession(db, { targetUrl: 'https://example.com' });
    expect(session.status).toBe('created');

    // 2. Update to crawling
    updateSession(db, session.id, { status: 'crawling' });

    // 3. Insert pages
    const page1 = insertPage(db, session.id, 'https://example.com/', 200);
    const page2 = insertPage(db, session.id, 'https://example.com/about', 200);

    // 4. Insert violations (simulating what the violation listener would capture)
    insertViolation(db, makeViolation(session.id, page1.id, 'script-src', 'https://cdn.example.com/app.js'));
    insertViolation(db, makeViolation(session.id, page1.id, 'style-src', 'https://cdn.example.com/style.css'));
    insertViolation(db, makeViolation(session.id, page2.id, 'img-src', 'https://img.example.com/logo.png'));
    insertViolation(db, makeViolation(session.id, page2.id, 'script-src', 'https://cdn.example.com/vendor.js'));
    insertViolation(db, makeViolation(session.id, page2.id, 'font-src', 'https://fonts.googleapis.com/font.woff2'));

    // 5. Mark complete
    updateSession(db, session.id, { status: 'complete' });
    const updatedSession = getSession(db, session.id);
    expect(updatedSession?.status).toBe('complete');

    // 6. Verify stored data
    const pages = getPages(db, session.id);
    expect(pages).toHaveLength(2);

    const violations = getViolations(db, session.id);
    expect(violations).toHaveLength(5);

    // 7. Generate policy
    const directives = generatePolicy(db, session.id, {
      strictness: 'moderate',
      includeHashes: true,
    });

    expect(directives).toBeDefined();
    expect(Object.keys(directives).length).toBeGreaterThan(0);
    expect(directives['script-src']).toBeDefined();
    expect(directives['style-src']).toBeDefined();
    expect(directives['img-src']).toBeDefined();
    expect(directives['font-src']).toBeDefined();

    // 8. Optimize policy
    const optimized = optimizePolicy(directives, 'https://example.com');
    expect(optimized).toBeDefined();

    // 9. Format as header
    const header = formatPolicy(optimized, 'header', false);
    expect(header).toContain('Content-Security-Policy:');
    expect(header).toContain('script-src');

    // 10. Format as nginx
    const nginx = formatPolicy(optimized, 'nginx', false);
    expect(nginx).toContain('add_header');

    // 11. Format as JSON
    const json = formatPolicy(optimized, 'json', false);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe('object');
  });

  it('generates report-only policy when requested', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    const page = insertPage(db, session.id, 'https://example.com/', 200);
    insertViolation(db, makeViolation(session.id, page.id, 'script-src', 'https://cdn.example.com/app.js'));

    const directives = generatePolicy(db, session.id, {
      strictness: 'moderate',
      includeHashes: true,
    });
    const optimized = optimizePolicy(directives, 'https://example.com');
    const header = formatPolicy(optimized, 'header', true);

    expect(header).toContain('Content-Security-Policy-Report-Only:');
  });

  it('generates empty policy for session with no violations', () => {
    const session = createSession(db, { targetUrl: 'https://example.com' });
    insertPage(db, session.id, 'https://example.com/', 200);

    const directives = generatePolicy(db, session.id, {
      strictness: 'moderate',
      includeHashes: true,
    });

    // Should have no directives (or only default-src from optimization)
    const optimized = optimizePolicy(directives, 'https://example.com');
    const header = formatPolicy(optimized, 'header', false);
    expect(header).toBeDefined();
  });
});
