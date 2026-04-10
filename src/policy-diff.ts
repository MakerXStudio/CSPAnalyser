import type Database from 'better-sqlite3';
import type { Violation } from './types.js';
import { getSession, getViolations } from './db/repository.js';
import { generatePolicy } from './policy-generator.js';
import { optimizePolicy } from './policy-optimizer.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface DirectiveDiff {
  directive: string;
  added: string[];
  removed: string[];
  unchanged: string[];
}

export interface PolicyDiff {
  addedDirectives: string[];
  removedDirectives: string[];
  changedDirectives: DirectiveDiff[];
  unchangedDirectives: string[];
}

export interface ViolationSummary {
  directive: string;
  blockedUri: string;
  count: number;
}

export interface ViolationDiff {
  newViolations: ViolationSummary[];
  resolvedViolations: ViolationSummary[];
  unchangedViolations: ViolationSummary[];
}

export interface SessionComparison {
  sessionA: string;
  sessionB: string;
  policyDiff: PolicyDiff;
  violationDiff: ViolationDiff;
}

// ── Policy comparison ──────────────────────────────────────────────────

export function comparePolicies(
  policyA: Record<string, string[]>,
  policyB: Record<string, string[]>,
): PolicyDiff {
  const directivesA = new Set(Object.keys(policyA));
  const directivesB = new Set(Object.keys(policyB));

  const addedDirectives: string[] = [];
  const removedDirectives: string[] = [];
  const changedDirectives: DirectiveDiff[] = [];
  const unchangedDirectives: string[] = [];

  // Directives only in B (added)
  for (const d of directivesB) {
    if (!directivesA.has(d)) {
      addedDirectives.push(d);
    }
  }

  // Directives only in A (removed)
  for (const d of directivesA) {
    if (!directivesB.has(d)) {
      removedDirectives.push(d);
    }
  }

  // Directives in both — compare sources
  for (const d of directivesA) {
    if (!directivesB.has(d)) continue;

    const sourcesA = new Set(policyA[d]);
    const sourcesB = new Set(policyB[d]);

    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    for (const s of sourcesB) {
      if (!sourcesA.has(s)) added.push(s);
      else unchanged.push(s);
    }
    for (const s of sourcesA) {
      if (!sourcesB.has(s)) removed.push(s);
    }

    if (added.length === 0 && removed.length === 0) {
      unchangedDirectives.push(d);
    } else {
      changedDirectives.push({
        directive: d,
        added: added.sort(),
        removed: removed.sort(),
        unchanged: unchanged.sort(),
      });
    }
  }

  return {
    addedDirectives: addedDirectives.sort(),
    removedDirectives: removedDirectives.sort(),
    changedDirectives: changedDirectives.sort((a, b) => a.directive.localeCompare(b.directive)),
    unchangedDirectives: unchangedDirectives.sort(),
  };
}

// ── Violation comparison ───────────────────────────────────────────────

function summarizeViolations(violations: Violation[]): Map<string, ViolationSummary> {
  const map = new Map<string, ViolationSummary>();
  for (const v of violations) {
    const key = `${v.effectiveDirective}|${v.blockedUri}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, {
        directive: v.effectiveDirective,
        blockedUri: v.blockedUri,
        count: 1,
      });
    }
  }
  return map;
}

export function compareViolations(
  violationsA: Violation[],
  violationsB: Violation[],
): ViolationDiff {
  const summaryA = summarizeViolations(violationsA);
  const summaryB = summarizeViolations(violationsB);

  const newViolations: ViolationSummary[] = [];
  const resolvedViolations: ViolationSummary[] = [];
  const unchangedViolations: ViolationSummary[] = [];

  for (const [key, summary] of summaryB) {
    if (!summaryA.has(key)) {
      newViolations.push(summary);
    } else {
      unchangedViolations.push(summary);
    }
  }

  for (const [key, summary] of summaryA) {
    if (!summaryB.has(key)) {
      resolvedViolations.push(summary);
    }
  }

  const sortFn = (a: ViolationSummary, b: ViolationSummary): number =>
    a.directive.localeCompare(b.directive) || a.blockedUri.localeCompare(b.blockedUri);

  return {
    newViolations: newViolations.sort(sortFn),
    resolvedViolations: resolvedViolations.sort(sortFn),
    unchangedViolations: unchangedViolations.sort(sortFn),
  };
}

// ── Formatting ─────────────────────────────────────────────────────────

export function formatDiff(comparison: SessionComparison): string {
  const lines: string[] = [];
  const { policyDiff, violationDiff } = comparison;

  lines.push(`Session comparison: ${comparison.sessionA} → ${comparison.sessionB}`);
  lines.push('');

  // Policy diff
  lines.push('=== Policy Changes ===');

  if (policyDiff.addedDirectives.length > 0) {
    lines.push('');
    lines.push('New directives:');
    for (const d of policyDiff.addedDirectives) {
      lines.push(`  + ${d}`);
    }
  }

  if (policyDiff.removedDirectives.length > 0) {
    lines.push('');
    lines.push('Removed directives:');
    for (const d of policyDiff.removedDirectives) {
      lines.push(`  - ${d}`);
    }
  }

  if (policyDiff.changedDirectives.length > 0) {
    lines.push('');
    lines.push('Changed directives:');
    for (const change of policyDiff.changedDirectives) {
      lines.push(`  ${change.directive}:`);
      for (const s of change.added) {
        lines.push(`    + ${s}`);
      }
      for (const s of change.removed) {
        lines.push(`    - ${s}`);
      }
    }
  }

  if (
    policyDiff.addedDirectives.length === 0 &&
    policyDiff.removedDirectives.length === 0 &&
    policyDiff.changedDirectives.length === 0
  ) {
    lines.push('  No policy changes.');
  }

  lines.push('');
  lines.push('=== Violation Changes ===');

  if (violationDiff.newViolations.length > 0) {
    lines.push('');
    lines.push('New violations:');
    for (const v of violationDiff.newViolations) {
      lines.push(`  + [${v.directive}] ${v.blockedUri} (${v.count}x)`);
    }
  }

  if (violationDiff.resolvedViolations.length > 0) {
    lines.push('');
    lines.push('Resolved violations:');
    for (const v of violationDiff.resolvedViolations) {
      lines.push(`  - [${v.directive}] ${v.blockedUri} (${v.count}x)`);
    }
  }

  if (violationDiff.newViolations.length === 0 && violationDiff.resolvedViolations.length === 0) {
    lines.push('  No violation changes.');
  }

  return lines.join('\n');
}

// ── Database-backed comparison ─────────────────────────────────────────

export function compareSessions(
  db: Database.Database,
  sessionIdA: string,
  sessionIdB: string,
  strictness: 'strict' | 'moderate' | 'permissive' = 'moderate',
): SessionComparison {
  const sessionA = getSession(db, sessionIdA);
  if (!sessionA) {
    throw new Error(`Session not found: ${sessionIdA}`);
  }
  const sessionB = getSession(db, sessionIdB);
  if (!sessionB) {
    throw new Error(`Session not found: ${sessionIdB}`);
  }

  const policyOptsA = { strictness, includeHashes: false };
  const directivesA = generatePolicy(db, sessionIdA, policyOptsA);
  const optimizedA = optimizePolicy(directivesA, sessionA.targetUrl);

  const policyOptsB = { strictness, includeHashes: false };
  const directivesB = generatePolicy(db, sessionIdB, policyOptsB);
  const optimizedB = optimizePolicy(directivesB, sessionB.targetUrl);

  const violationsA = getViolations(db, sessionIdA);
  const violationsB = getViolations(db, sessionIdB);

  return {
    sessionA: sessionIdA,
    sessionB: sessionIdB,
    policyDiff: comparePolicies(optimizedA, optimizedB),
    violationDiff: compareViolations(violationsA, violationsB),
  };
}
