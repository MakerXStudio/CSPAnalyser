import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  getInlineHashes,
} from '../src/db/repository.js';
import { extractInlineHashes } from '../src/inline-content-extractor.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('base64');
}

function makeMockPage(evaluateResult: unknown): Page {
  return {
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
  } as unknown as Page;
}

describe('extractInlineHashes', () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const session = createSession(db, { targetUrl: 'https://example.com' });
    sessionId = session.id;
  });

  it('extracts inline script hashes', async () => {
    const page = makeMockPage([
      { content: 'console.log("hello")', directive: 'script-src-elem' },
    ]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(1);
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(1);
    expect(hashes[0].directive).toBe('script-src-elem');
    expect(hashes[0].hash).toBe(sha256('console.log("hello")'));
    expect(hashes[0].contentLength).toBe(20);
  });

  it('extracts inline style hashes', async () => {
    const page = makeMockPage([
      { content: 'body { color: red; }', directive: 'style-src-elem' },
    ]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(1);
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes[0].directive).toBe('style-src-elem');
  });

  it('extracts inline event handler hashes', async () => {
    const page = makeMockPage([
      { content: 'alert(1)', directive: 'script-src-attr' },
    ]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(1);
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes[0].directive).toBe('script-src-attr');
    expect(hashes[0].hash).toBe(sha256('alert(1)'));
  });

  it('extracts inline style attribute hashes', async () => {
    const page = makeMockPage([
      { content: 'color: blue', directive: 'style-src-attr' },
    ]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(1);
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes[0].directive).toBe('style-src-attr');
  });

  it('handles multiple inline items', async () => {
    const page = makeMockPage([
      { content: 'console.log("a")', directive: 'script-src-elem' },
      { content: 'console.log("b")', directive: 'script-src-elem' },
      { content: 'body { margin: 0; }', directive: 'style-src-elem' },
    ]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(3);
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(3);
  });

  it('deduplicates identical content within a session', async () => {
    const page = makeMockPage([
      { content: 'console.log("hello")', directive: 'script-src-elem' },
    ]);

    await extractInlineHashes(page, db, sessionId, null);
    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(0); // second call returns 0 new inserts
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(1);
  });

  it('returns 0 when page has no inline content', async () => {
    const page = makeMockPage([]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(0);
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(0);
  });

  it('handles page.evaluate errors gracefully', async () => {
    const page = {
      evaluate: vi.fn().mockRejectedValue(new Error('Page crashed')),
    } as unknown as Page;

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(0);
  });

  it('skips content exceeding 1 MB', async () => {
    const largeContent = 'x'.repeat(1_048_577); // 1 byte over limit
    const page = makeMockPage([
      { content: largeContent, directive: 'script-src-elem' },
      { content: 'console.log("ok")', directive: 'script-src-elem' },
    ]);

    const count = await extractInlineHashes(page, db, sessionId, null);

    expect(count).toBe(1); // only the small one
    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(1);
    expect(hashes[0].hash).toBe(sha256('console.log("ok")'));
  });

  it('stores pageId when provided', async () => {
    // Insert a page record first
    db.prepare('INSERT INTO pages (session_id, url) VALUES (?, ?)').run(sessionId, 'https://example.com/page');
    const pageRow = db.prepare('SELECT id FROM pages WHERE session_id = ?').get(sessionId) as { id: number };

    const page = makeMockPage([
      { content: 'test()', directive: 'script-src-elem' },
    ]);

    await extractInlineHashes(page, db, sessionId, String(pageRow.id));

    const hashes = getInlineHashes(db, sessionId);
    expect(hashes[0].pageId).toBe(String(pageRow.id));
  });
});
