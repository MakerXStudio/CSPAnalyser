import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import Database from 'better-sqlite3';
import {
  createDatabase,
  createSession,
  getInlineHashes,
} from '../src/db/repository.js';
import {
  generateObserverInitScript,
  setupInlineContentObserver,
} from '../src/inline-content-observer.js';

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('base64');
}

describe('generateObserverInitScript', () => {
  it('returns a non-empty string wrapped in try/catch', () => {
    const script = generateObserverInitScript();
    expect(script).toBeTruthy();
    expect(script).toContain('try');
    expect(script).toContain('catch');
  });

  it('installs a MutationObserver', () => {
    const script = generateObserverInitScript();
    expect(script).toContain('MutationObserver');
  });

  it('references the exposed report function', () => {
    const script = generateObserverInitScript();
    expect(script).toContain('__cspInlineContentReport');
  });

  it('observes childList, subtree, and attributes', () => {
    const script = generateObserverInitScript();
    expect(script).toContain('childList:true');
    expect(script).toContain('subtree:true');
    expect(script).toContain('attributes:true');
  });

  it('scans existing DOM on DOMContentLoaded', () => {
    const script = generateObserverInitScript();
    expect(script).toContain('DOMContentLoaded');
  });
});

describe('setupInlineContentObserver', () => {
  let db: Database.Database;
  let sessionId: string;
  let exposedHandler: ((data: unknown) => void) | null;
  let mockPage: Page;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const session = createSession(db, { targetUrl: 'https://example.com' });
    sessionId = session.id;
    exposedHandler = null;

    mockPage = {
      exposeFunction: vi.fn().mockImplementation((_name: string, handler: (data: unknown) => void) => {
        exposedHandler = handler;
        return Promise.resolve();
      }),
      addInitScript: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;
  });

  it('exposes the reporting function and installs the init script', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    expect(mockPage.exposeFunction).toHaveBeenCalledWith(
      '__cspInlineContentReport',
      expect.any(Function),
    );
    expect(mockPage.addInitScript).toHaveBeenCalled();
    expect(exposedHandler).not.toBeNull();
  });

  it('stores a hash when the browser reports inline content', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    exposedHandler!({ content: 'console.log("hi")', directive: 'script-src-elem' });

    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(1);
    expect(hashes[0].directive).toBe('script-src-elem');
    expect(hashes[0].hash).toBe(sha256('console.log("hi")'));
  });

  it('handles style-src-elem, script-src-attr, and style-src-attr directives', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    exposedHandler!({ content: 'body { color: red; }', directive: 'style-src-elem' });
    exposedHandler!({ content: 'alert(1)', directive: 'script-src-attr' });
    exposedHandler!({ content: 'color: blue', directive: 'style-src-attr' });

    const hashes = getInlineHashes(db, sessionId);
    expect(hashes).toHaveLength(3);
    const directives = hashes.map((h) => h.directive).sort();
    expect(directives).toEqual(['script-src-attr', 'style-src-attr', 'style-src-elem']);
  });

  it('deduplicates identical content reported multiple times', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    exposedHandler!({ content: 'same', directive: 'script-src-elem' });
    exposedHandler!({ content: 'same', directive: 'script-src-elem' });
    exposedHandler!({ content: 'same', directive: 'script-src-elem' });

    expect(getInlineHashes(db, sessionId)).toHaveLength(1);
  });

  it('rejects invalid report data (wrong type)', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    exposedHandler!(null);
    exposedHandler!('not an object');
    exposedHandler!({ content: 123, directive: 'script-src-elem' });
    exposedHandler!({ content: 'ok', directive: 42 });

    expect(getInlineHashes(db, sessionId)).toHaveLength(0);
  });

  it('rejects reports with unknown directives', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    exposedHandler!({ content: 'anything', directive: 'img-src' });
    exposedHandler!({ content: 'anything', directive: 'script-src' });

    expect(getInlineHashes(db, sessionId)).toHaveLength(0);
  });

  it('skips content exceeding 1 MB', async () => {
    await setupInlineContentObserver(mockPage, db, sessionId, null);

    exposedHandler!({
      content: 'x'.repeat(1_048_577),
      directive: 'script-src-elem',
    });

    expect(getInlineHashes(db, sessionId)).toHaveLength(0);
  });

  it('stores pageId when provided', async () => {
    db.prepare('INSERT INTO pages (session_id, url) VALUES (?, ?)').run(sessionId, 'https://example.com/');
    const pageRow = db.prepare('SELECT id FROM pages WHERE session_id = ?').get(sessionId) as { id: number };

    await setupInlineContentObserver(mockPage, db, sessionId, String(pageRow.id));

    exposedHandler!({ content: 'test', directive: 'script-src-elem' });

    const hashes = getInlineHashes(db, sessionId);
    expect(hashes[0].pageId).toBe(String(pageRow.id));
  });
});
