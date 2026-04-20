import type { Page } from 'playwright';
import type Database from 'better-sqlite3';
import { parseDomViolation } from './report-parser.js';
import { insertViolation } from './db/repository.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

/**
 * Returns the JavaScript init script that captures SecurityPolicyViolationEvents
 * and forwards them to the Node.js callback via window.__cspViolationReport.
 */
export function generateInitScript(): string {
  return `try{document.addEventListener('securitypolicyviolation',function(e){var s=e.sample||null;if(s&&s.length>256)s=s.slice(0,256);window.__cspViolationReport({documentURI:e.documentURI,blockedURI:e.blockedURI,violatedDirective:e.violatedDirective,effectiveDirective:e.effectiveDirective,sourceFile:e.sourceFile||null,lineNumber:e.lineNumber||null,columnNumber:e.columnNumber||null,disposition:e.disposition||'report',sample:s})})}catch(e){}`;
}

/**
 * Sets up the CSP violation listener on a Playwright page.
 *
 * Exposes a `__cspViolationReport` function on the page's window object,
 * and injects an init script that captures SecurityPolicyViolationEvents
 * and forwards them to the exposed function.
 *
 * @param pageId - Either a static page ID or a resolver function that returns
 *   the current page ID (used in interactive mode where the page ID changes on navigation).
 */
export async function setupViolationListener(
  page: Page,
  db: Database.Database,
  sessionId: string,
  pageId: string | null | (() => string | null),
): Promise<void> {
  await page.exposeFunction('__cspViolationReport', (data: unknown) => {
    const resolvedPageId = typeof pageId === 'function' ? pageId() : pageId;
    const violation = parseDomViolation(data, sessionId, resolvedPageId);
    if (!violation) {
      logger.warn('Failed to parse DOM violation', { sessionId, pageId: resolvedPageId });
      return;
    }

    const result = insertViolation(db, violation);
    if (result) {
      logger.debug('Captured DOM violation', {
        directive: result.effectiveDirective,
        blockedUri: result.blockedUri,
      });
    }
  });

  await page.addInitScript(generateInitScript());
}
