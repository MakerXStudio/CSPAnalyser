import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type Database from 'better-sqlite3';
import { insertInlineHash } from './db/repository.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

/** Maximum inline content size to hash (1 MB). Larger items are skipped. */
const MAX_CONTENT_LENGTH = 1_048_576;

interface InlineContentReport {
  content: string;
  directive: string;
}

/**
 * Returns the JavaScript init script that installs a MutationObserver at page
 * init time. The observer captures inline script/style/attribute content as
 * it is added to the DOM (statically during HTML parsing or dynamically by
 * runtime code) and forwards it to the Node.js callback via
 * `window.__cspInlineContentReport`.
 *
 * This complements the post-load DOM scan in inline-content-extractor.ts:
 * the observer captures content that may be injected after the scan runs,
 * such as CSS-in-JS libraries and lazy-loaded widgets.
 */
export function generateObserverInitScript(): string {
  // Script kept compact but readable; wrapped in IIFE and try/catch so a failure
  // here never breaks the page or the crawl. Deduplication happens server-side
  // via the UNIQUE constraint on inline_hashes, so over-reporting is safe.
  // Note: empty string values for style="" and on*="" attributes MUST be
  // reported — the browser evaluates CSP against present-but-empty inline
  // attributes (the empty string has hash 47DEQpj8...). Only <script> and
  // <style> block content is filtered for whitespace-only, because empty
  // blocks don't execute/apply and thus don't trigger CSP.
  return `(function(){try{
var reportBlock=function(c,d){if(!c||!String(c).trim())return;try{window.__cspInlineContentReport({content:String(c),directive:d})}catch(e){}};
var reportAttr=function(c,d){if(c==null)return;try{window.__cspInlineContentReport({content:String(c),directive:d})}catch(e){}};
var processEl=function(el){if(!el||el.nodeType!==1)return;
var tag=el.tagName;
if(tag==='SCRIPT'&&!el.hasAttribute('src'))reportBlock(el.textContent,'script-src-elem');
if(tag==='STYLE')reportBlock(el.textContent,'style-src-elem');
var s=el.getAttribute&&el.getAttribute('style');if(s!==null)reportAttr(s,'style-src-attr');
if(el.attributes){for(var i=0;i<el.attributes.length;i++){var a=el.attributes[i];if(a.name.indexOf('on')===0)reportAttr(a.value,'script-src-attr')}}};
var processTree=function(node){if(!node||node.nodeType!==1)return;processEl(node);if(node.querySelectorAll){var all=node.querySelectorAll('*');for(var i=0;i<all.length;i++)processEl(all[i])}};
var obs=new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];if(m.type==='childList'){for(var j=0;j<m.addedNodes.length;j++)processTree(m.addedNodes[j])}else if(m.type==='attributes'){processEl(m.target)}}});
obs.observe(document,{childList:true,subtree:true,attributes:true});
var scan=function(){if(document.documentElement)processTree(document.documentElement)};
if(document.readyState!=='loading')scan();else document.addEventListener('DOMContentLoaded',scan);
}catch(e){}})();`;
}

/**
 * Sets up the inline content observer on a Playwright page.
 *
 * Exposes a `__cspInlineContentReport` function on the page, then injects
 * the MutationObserver init script. The exposed function receives content
 * from the browser, computes SHA-256 hashes, and stores them in the
 * inline_hashes database table.
 *
 * @param pageId - Either a static page ID or a resolver function that returns
 *   the current page ID (used in interactive mode where the page ID changes on navigation).
 */
export async function setupInlineContentObserver(
  page: Page,
  db: Database.Database,
  sessionId: string,
  pageId: string | null | (() => string | null),
): Promise<void> {
  await page.exposeFunction('__cspInlineContentReport', (data: unknown) => {
    const report = parseReport(data);
    if (!report) return;
    if (report.content.length > MAX_CONTENT_LENGTH) {
      logger.warn('Skipping observed inline content exceeding 1 MB', {
        directive: report.directive,
        length: report.content.length,
      });
      return;
    }

    const resolvedPageId = typeof pageId === 'function' ? pageId() : pageId;
    const hash = createHash('sha256').update(report.content).digest('base64');
    insertInlineHash(db, {
      sessionId,
      pageId: resolvedPageId,
      directive: report.directive,
      hash,
      contentLength: report.content.length,
      content: report.content,
    });
  });

  await page.addInitScript(generateObserverInitScript());
}

/**
 * Validates data received from the browser-exposed function. Defensive:
 * the data crosses a trust boundary (browser → Node), so we don't trust it.
 */
function parseReport(data: unknown): InlineContentReport | null {
  if (typeof data !== 'object' || data === null) return null;
  const obj = data as { content?: unknown; directive?: unknown };

  if (typeof obj.content !== 'string') return null;
  if (typeof obj.directive !== 'string') return null;

  const validDirectives = new Set([
    'script-src-elem',
    'script-src-attr',
    'style-src-elem',
    'style-src-attr',
  ]);
  if (!validDirectives.has(obj.directive)) return null;

  return { content: obj.content, directive: obj.directive };
}
