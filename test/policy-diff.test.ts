import { describe, it, expect } from 'vitest';
import {
  comparePolicies,
  compareViolations,
  formatDiff,
} from '../src/policy-diff.js';
import type { Violation } from '../src/types.js';

// ── Helper to create minimal violation objects ─────────────────────────

function makeViolation(overrides: Partial<Violation> & { effectiveDirective: string; blockedUri: string }): Violation {
  const { effectiveDirective, blockedUri, ...rest } = overrides;
  return {
    id: 'v-1',
    sessionId: 's-1',
    pageId: null,
    documentUri: 'https://example.com',
    blockedUri,
    violatedDirective: effectiveDirective,
    effectiveDirective,
    sourceFile: null,
    lineNumber: null,
    columnNumber: null,
    disposition: 'report',
    sample: null,
    capturedVia: 'dom_event',
    rawReport: '{}',
    createdAt: '2026-01-01T00:00:00Z',
    ...rest,
  };
}

// ── comparePolicies ────────────────────────────────────────────────────

describe('comparePolicies', () => {
  it('detects identical policies as unchanged', () => {
    const policy = { 'default-src': ["'self'"], 'script-src': ["'self'"] };
    const diff = comparePolicies(policy, policy);
    expect(diff.addedDirectives).toEqual([]);
    expect(diff.removedDirectives).toEqual([]);
    expect(diff.changedDirectives).toEqual([]);
    expect(diff.unchangedDirectives).toEqual(['default-src', 'script-src']);
  });

  it('detects added directives', () => {
    const a = { 'default-src': ["'self'"] };
    const b = { 'default-src': ["'self'"], 'script-src': ['https://cdn.example.com'] };
    const diff = comparePolicies(a, b);
    expect(diff.addedDirectives).toEqual(['script-src']);
    expect(diff.removedDirectives).toEqual([]);
    expect(diff.unchangedDirectives).toEqual(['default-src']);
  });

  it('detects removed directives', () => {
    const a = { 'default-src': ["'self'"], 'script-src': ['https://cdn.example.com'] };
    const b = { 'default-src': ["'self'"] };
    const diff = comparePolicies(a, b);
    expect(diff.removedDirectives).toEqual(['script-src']);
    expect(diff.addedDirectives).toEqual([]);
  });

  it('detects changed sources within a directive', () => {
    const a = { 'script-src': ["'self'", 'https://old.example.com'] };
    const b = { 'script-src': ["'self'", 'https://new.example.com'] };
    const diff = comparePolicies(a, b);
    expect(diff.changedDirectives).toHaveLength(1);
    expect(diff.changedDirectives[0].directive).toBe('script-src');
    expect(diff.changedDirectives[0].added).toEqual(['https://new.example.com']);
    expect(diff.changedDirectives[0].removed).toEqual(['https://old.example.com']);
    expect(diff.changedDirectives[0].unchanged).toEqual(["'self'"]);
  });

  it('handles empty policies', () => {
    const diff = comparePolicies({}, {});
    expect(diff.addedDirectives).toEqual([]);
    expect(diff.removedDirectives).toEqual([]);
    expect(diff.changedDirectives).toEqual([]);
    expect(diff.unchangedDirectives).toEqual([]);
  });

  it('handles comparing empty policy to non-empty policy', () => {
    const diff = comparePolicies({}, { 'default-src': ["'self'"] });
    expect(diff.addedDirectives).toEqual(['default-src']);
    expect(diff.removedDirectives).toEqual([]);
  });

  it('sorts results alphabetically', () => {
    const a = { 'style-src': ["'self'"], 'img-src': ['data:'] };
    const b = { 'font-src': ['https://fonts.gstatic.com'], 'connect-src': ['https://api.example.com'] };
    const diff = comparePolicies(a, b);
    expect(diff.addedDirectives).toEqual(['connect-src', 'font-src']);
    expect(diff.removedDirectives).toEqual(['img-src', 'style-src']);
  });
});

// ── compareViolations ──────────────────────────────────────────────────

describe('compareViolations', () => {
  it('detects new violations', () => {
    const a: Violation[] = [];
    const b = [makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://cdn.example.com' })];
    const diff = compareViolations(a, b);
    expect(diff.newViolations).toHaveLength(1);
    expect(diff.newViolations[0].directive).toBe('script-src');
    expect(diff.newViolations[0].blockedUri).toBe('https://cdn.example.com');
    expect(diff.resolvedViolations).toHaveLength(0);
  });

  it('detects resolved violations', () => {
    const a = [makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://cdn.example.com' })];
    const b: Violation[] = [];
    const diff = compareViolations(a, b);
    expect(diff.resolvedViolations).toHaveLength(1);
    expect(diff.newViolations).toHaveLength(0);
  });

  it('detects unchanged violations', () => {
    const v = makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://cdn.example.com' });
    const diff = compareViolations([v], [v]);
    expect(diff.unchangedViolations).toHaveLength(1);
    expect(diff.newViolations).toHaveLength(0);
    expect(diff.resolvedViolations).toHaveLength(0);
  });

  it('counts duplicate violations', () => {
    const v1 = makeViolation({ id: 'v1', effectiveDirective: 'script-src', blockedUri: 'https://cdn.example.com' });
    const v2 = makeViolation({ id: 'v2', effectiveDirective: 'script-src', blockedUri: 'https://cdn.example.com' });
    const diff = compareViolations([], [v1, v2]);
    expect(diff.newViolations).toHaveLength(1);
    expect(diff.newViolations[0].count).toBe(2);
  });

  it('handles mixed changes', () => {
    const a = [
      makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://old.example.com' }),
      makeViolation({ effectiveDirective: 'img-src', blockedUri: 'https://images.example.com' }),
    ];
    const b = [
      makeViolation({ effectiveDirective: 'script-src', blockedUri: 'https://new.example.com' }),
      makeViolation({ effectiveDirective: 'img-src', blockedUri: 'https://images.example.com' }),
    ];
    const diff = compareViolations(a, b);
    expect(diff.newViolations).toHaveLength(1);
    expect(diff.newViolations[0].blockedUri).toBe('https://new.example.com');
    expect(diff.resolvedViolations).toHaveLength(1);
    expect(diff.resolvedViolations[0].blockedUri).toBe('https://old.example.com');
    expect(diff.unchangedViolations).toHaveLength(1);
  });
});

// ── formatDiff ─────────────────────────────────────────────────────────

describe('formatDiff', () => {
  it('formats a comparison with all types of changes', () => {
    const output = formatDiff({
      sessionA: 'session-a',
      sessionB: 'session-b',
      policyDiff: {
        addedDirectives: ['font-src'],
        removedDirectives: ['object-src'],
        changedDirectives: [
          {
            directive: 'script-src',
            added: ['https://new.example.com'],
            removed: ['https://old.example.com'],
            unchanged: ["'self'"],
          },
        ],
        unchangedDirectives: ['default-src'],
      },
      violationDiff: {
        newViolations: [{ directive: 'font-src', blockedUri: 'https://fonts.gstatic.com', count: 3 }],
        resolvedViolations: [{ directive: 'object-src', blockedUri: 'https://flash.example.com', count: 1 }],
        unchangedViolations: [],
      },
    });

    expect(output).toContain('session-a → session-b');
    expect(output).toContain('+ font-src');
    expect(output).toContain('- object-src');
    expect(output).toContain('script-src:');
    expect(output).toContain('+ https://new.example.com');
    expect(output).toContain('- https://old.example.com');
    expect(output).toContain('+ [font-src] https://fonts.gstatic.com (3x)');
    expect(output).toContain('- [object-src] https://flash.example.com (1x)');
  });

  it('formats a comparison with no changes', () => {
    const output = formatDiff({
      sessionA: 'a',
      sessionB: 'b',
      policyDiff: {
        addedDirectives: [],
        removedDirectives: [],
        changedDirectives: [],
        unchangedDirectives: ['default-src'],
      },
      violationDiff: {
        newViolations: [],
        resolvedViolations: [],
        unchangedViolations: [],
      },
    });

    expect(output).toContain('No policy changes.');
    expect(output).toContain('No violation changes.');
  });
});
