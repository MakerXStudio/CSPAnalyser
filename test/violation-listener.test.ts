import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Page } from 'playwright';
import Database from 'better-sqlite3';
import { createDatabase, createSession, getViolations, insertPage } from '../src/db/repository.js';
import { generateInitScript, setupViolationListener } from '../src/violation-listener.js';
import type { SessionConfig } from '../src/types.js';

const TEST_CONFIG: SessionConfig = {
  targetUrl: 'https://example.com',
  mode: 'local',
};

describe('generateInitScript', () => {
  it('returns a non-empty string', () => {
    const script = generateInitScript();
    expect(script).toBeTruthy();
    expect(typeof script).toBe('string');
  });

  it('listens for securitypolicyviolation events', () => {
    const script = generateInitScript();
    expect(script).toContain('securitypolicyviolation');
  });

  it('calls window.__cspViolationReport', () => {
    const script = generateInitScript();
    expect(script).toContain('__cspViolationReport');
  });

  it('is wrapped in try/catch', () => {
    const script = generateInitScript();
    expect(script).toMatch(/^try\{/);
    expect(script).toMatch(/catch\(e\)\{\}$/);
  });

  it('extracts expected violation properties', () => {
    const script = generateInitScript();
    expect(script).toContain('documentURI');
    expect(script).toContain('blockedURI');
    expect(script).toContain('violatedDirective');
    expect(script).toContain('effectiveDirective');
    expect(script).toContain('sourceFile');
    expect(script).toContain('lineNumber');
    expect(script).toContain('columnNumber');
    expect(script).toContain('disposition');
    expect(script).toContain('sample');
  });

  it('is reasonably compact (under 500 bytes)', () => {
    const script = generateInitScript();
    expect(script.length).toBeLessThan(500);
  });

  it('truncates the sample field to 256 characters', () => {
    const script = generateInitScript();
    expect(script).toContain('.slice(0,256)');
    expect(script).toContain('s.length>256');
  });
});

describe('setupViolationListener', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    sessionId = createSession(db, TEST_CONFIG).id;
  });
  afterEach(() => {
    db.close();
  });

  it('calls page.exposeFunction and page.addInitScript', async () => {
    const page = {
      exposeFunction: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    await setupViolationListener(page, db, sessionId, null);

    expect(page.exposeFunction).toHaveBeenCalledTimes(1);
    expect(page.exposeFunction).toHaveBeenCalledWith('__cspViolationReport', expect.any(Function));
    expect(page.addInitScript).toHaveBeenCalledTimes(1);
    expect(page.addInitScript).toHaveBeenCalledWith(expect.any(String));
  });

  it('the exposed callback inserts a violation into the database', async () => {
    let capturedCallback: ((data: unknown) => void) | null = null;

    const page = {
      exposeFunction: vi.fn().mockImplementation((_name: string, cb: (data: unknown) => void) => {
        capturedCallback = cb;
        return Promise.resolve();
      }),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    const pageRecord = insertPage(db, sessionId, 'https://example.com/', 200)!;
    await setupViolationListener(page, db, sessionId, pageRecord.id);

    expect(capturedCallback).not.toBeNull();

    // Simulate a violation event
    capturedCallback!({
      documentURI: 'https://example.com/',
      blockedURI: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      sourceFile: 'https://example.com/app.js',
      lineNumber: 10,
      columnNumber: 5,
      disposition: 'report',
      sample: '',
    });

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
    expect(violations[0].documentUri).toBe('https://example.com/');
    expect(violations[0].blockedUri).toBe('https://cdn.example.com/script.js');
    expect(violations[0].effectiveDirective).toBe('script-src');
    expect(violations[0].capturedVia).toBe('dom_event');
    expect(violations[0].sourceFile).toBe('https://example.com/app.js');
  });

  it('the callback handles invalid data gracefully', async () => {
    let capturedCallback: ((data: unknown) => void) | null = null;

    const page = {
      exposeFunction: vi.fn().mockImplementation((_name: string, cb: (data: unknown) => void) => {
        capturedCallback = cb;
        return Promise.resolve();
      }),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    await setupViolationListener(page, db, sessionId, null);

    // Should not throw
    capturedCallback!(null);
    capturedCallback!({});
    capturedCallback!('not an object');

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(0);
  });

  it('the callback deduplicates violations', async () => {
    let capturedCallback: ((data: unknown) => void) | null = null;

    const page = {
      exposeFunction: vi.fn().mockImplementation((_name: string, cb: (data: unknown) => void) => {
        capturedCallback = cb;
        return Promise.resolve();
      }),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    await setupViolationListener(page, db, sessionId, null);

    const violationData = {
      documentURI: 'https://example.com/',
      blockedURI: 'https://cdn.example.com/script.js',
      violatedDirective: 'script-src',
      effectiveDirective: 'script-src',
      disposition: 'report',
    };

    capturedCallback!(violationData);
    capturedCallback!(violationData);

    const violations = getViolations(db, sessionId);
    expect(violations).toHaveLength(1);
  });

  it('passes the init script string to addInitScript', async () => {
    const page = {
      exposeFunction: vi.fn().mockResolvedValue(undefined),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    await setupViolationListener(page, db, sessionId, null);

    const passedScript = (page.addInitScript as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passedScript).toBe(generateInitScript());
  });
});
