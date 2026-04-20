import type Database from 'better-sqlite3';
import type { Violation, StrictnessLevel, InlineHash } from './types.js';
import { getViolations, getSession, getInlineHashes } from './db/repository.js';
import { violationToSourceExpression, violationToHashSource } from './rule-builder.js';
import { CSP_DIRECTIVES, DIRECTIVE_FALLBACK_MAP } from './utils/csp-constants.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger();

const VALID_DIRECTIVES = new Set<string>(CSP_DIRECTIVES);

export interface PolicyGeneratorOptions {
  strictness: StrictnessLevel;
  includeHashes: boolean;
}

/**
 * Generates a CSP directive map from an array of violations.
 *
 * Groups violations by effectiveDirective, maps each to a source expression,
 * and optionally includes hash-based sources for script/style violations with samples.
 */
export function generatePolicyFromViolations(
  violations: Violation[],
  targetOrigin: string,
  options: PolicyGeneratorOptions,
): Record<string, string[]> {
  const directiveMap = new Map<string, Set<string>>();

  for (const violation of violations) {
    const directive = violation.effectiveDirective;

    if (!VALID_DIRECTIVES.has(directive)) {
      logger.warn('Skipping violation with unknown directive', {
        directive,
        violationId: violation.id,
      });
      continue;
    }

    const source = violationToSourceExpression(violation, targetOrigin, options.strictness);

    if (source !== null) {
      const existing = directiveMap.get(directive);
      if (existing) {
        existing.add(source);
      } else {
        directiveMap.set(directive, new Set([source]));
      }
    }

    if (options.includeHashes) {
      const hash = violationToHashSource(violation);
      if (hash !== null) {
        const existing = directiveMap.get(directive);
        if (existing) {
          existing.add(hash);
        } else {
          directiveMap.set(directive, new Set([hash]));
        }
      }
    }
  }

  const result: Record<string, string[]> = {};
  for (const [directive, sources] of directiveMap) {
    result[directive] = [...sources].sort();
  }

  return result;
}

/**
 * Merges inline content hashes from the inline_hashes table into a directive map.
 * Resolves sub-directives to parent directives when they already exist in the map,
 * using the CSP directive fallback chain.
 */
export function mergeInlineHashes(
  directives: Record<string, string[]>,
  inlineHashes: InlineHash[],
): void {
  for (const ih of inlineHashes) {
    const hashSource = `'sha256-${ih.hash}'`;

    // Resolve the target directive: use the parent directive if it already
    // exists in the map (e.g. script-src-elem → script-src), otherwise
    // use the sub-directive as-is.
    let targetDirective = ih.directive;
    const directiveKey = ih.directive as keyof typeof DIRECTIVE_FALLBACK_MAP;
    if (directiveKey in DIRECTIVE_FALLBACK_MAP) {
      const parentDirective = DIRECTIVE_FALLBACK_MAP[directiveKey];
      if (parentDirective && parentDirective in directives) {
        targetDirective = parentDirective;
      }
    }

    if (targetDirective in directives) {
      if (!directives[targetDirective].includes(hashSource)) {
        directives[targetDirective].push(hashSource);
        directives[targetDirective].sort();
      }
    } else {
      directives[targetDirective] = [hashSource];
    }
  }
}

/**
 * Generates a CSP directive map from violations stored in the database for a given session.
 */
export function generatePolicy(
  db: Database.Database,
  sessionId: string,
  options: PolicyGeneratorOptions,
): Record<string, string[]> {
  const session = getSession(db, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const violations = getViolations(db, sessionId);
  logger.info('Generating policy from violations', {
    sessionId,
    violationCount: violations.length,
    strictness: options.strictness,
  });

  const directives = generatePolicyFromViolations(violations, session.targetUrl, options);

  // Merge inline content hashes from the inline_hashes table.
  // These are full-content hashes computed from the DOM (not truncated samples).
  if (options.includeHashes) {
    const inlineHashes = getInlineHashes(db, sessionId);
    mergeInlineHashes(directives, inlineHashes);
  }

  return directives;
}
