import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type Database from 'better-sqlite3';
import { insertInlineHash } from './db/repository.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

/** Maximum inline content size to hash (1 MB). Larger items are skipped. */
const MAX_CONTENT_LENGTH = 1_048_576;

interface InlineContentItem {
  content: string;
  directive: string;
}

/**
 * Browser-context function that extracts all inline script/style content from the DOM.
 *
 * Returns an array of { content, directive } objects covering:
 * - <script> tags without a src attribute → script-src-elem
 * - <style> tags → style-src-elem
 * - Inline event handler attributes (on*) → script-src-attr
 * - Inline style="" attributes → style-src-attr
 */
function extractInlineContentFromDom(): InlineContentItem[] {
  const items: InlineContentItem[] = [];

  // Inline <script> tags (no src attribute)
  for (const el of document.querySelectorAll('script:not([src])')) {
    const content = el.textContent;
    if (content && content.trim()) {
      items.push({ content, directive: 'script-src-elem' });
    }
  }

  // Inline <style> tags
  for (const el of document.querySelectorAll('style')) {
    const content = el.textContent;
    if (content && content.trim()) {
      items.push({ content, directive: 'style-src-elem' });
    }
  }

  // Inline event handlers and style attributes on all elements
  const allElements = document.querySelectorAll('*');
  for (const el of allElements) {
    // Check for inline style attribute
    const styleAttr = el.getAttribute('style');
    if (styleAttr && styleAttr.trim()) {
      items.push({ content: styleAttr, directive: 'style-src-attr' });
    }

    // Check for inline event handler attributes (on*)
    for (const attr of el.attributes) {
      if (attr.name.startsWith('on') && attr.value.trim()) {
        items.push({ content: attr.value, directive: 'script-src-attr' });
      }
    }
  }

  return items;
}

/**
 * Extracts inline script/style content from a loaded page, computes SHA-256 hashes,
 * and stores them in the inline_hashes database table.
 */
export async function extractInlineHashes(
  page: Page,
  db: Database.Database,
  sessionId: string,
  pageId: string | null,
): Promise<number> {
  let items: InlineContentItem[];
  try {
    items = await page.evaluate(extractInlineContentFromDom);
  } catch (err) {
    logger.warn('Failed to extract inline content from page', {
      sessionId,
      pageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let count = 0;
  for (const item of items) {
    if (item.content.length > MAX_CONTENT_LENGTH) {
      logger.warn('Skipping inline content exceeding 1 MB', {
        directive: item.directive,
        length: item.content.length,
      });
      continue;
    }

    const hash = createHash('sha256').update(item.content).digest('base64');
    const result = insertInlineHash(db, {
      sessionId,
      pageId,
      directive: item.directive,
      hash,
      contentLength: item.content.length,
    });
    if (result) {
      count++;
    }
  }

  if (count > 0) {
    logger.debug('Extracted inline content hashes', { sessionId, pageId, count });
  }

  return count;
}
