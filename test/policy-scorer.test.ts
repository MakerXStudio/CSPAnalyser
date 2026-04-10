import { describe, it, expect } from 'vitest';
import { scoreCspPolicy, formatScore } from '../src/policy-scorer.js';
import type { CspScore } from '../src/policy-scorer.js';

// ── Helper ─────────────────────────────────────────────────────────────

function findFinding(score: CspScore, directiveOrMsg: string): boolean {
  return score.findings.some(
    (f) => f.directive === directiveOrMsg || f.message.includes(directiveOrMsg),
  );
}

// ── Grading ────────────────────────────────────────────────────────────

describe('scoreCspPolicy — grades', () => {
  it('gives grade A for a strong policy', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'nonce-abc123'", "'strict-dynamic'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'report-uri': ['/csp-report'],
    });
    expect(score.grade).toBe('A');
    expect(score.overall).toBeGreaterThanOrEqual(90);
  });

  it('gives grade F for a wildcard + unsafe policy', () => {
    const score = scoreCspPolicy({
      'script-src': ['*', "'unsafe-inline'", "'unsafe-eval'", 'data:'],
    });
    expect(score.grade).toBe('F');
    expect(score.overall).toBeLessThan(35);
  });
});

// ── Critical findings ──────────────────────────────────────────────────

describe('scoreCspPolicy — critical deductions', () => {
  it('penalizes unsafe-eval in script-src', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-eval'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(findFinding(score, 'unsafe-eval')).toBe(true);
    expect(score.overall).toBeLessThanOrEqual(70);
  });

  it('penalizes unsafe-eval in default-src when no script-src override', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'", "'unsafe-eval'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'default-src' && f.message.includes('unsafe-eval'))).toBe(true);
  });

  it('does not double-penalize unsafe-eval in default-src when script-src is present', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'", "'unsafe-eval'"],
      'script-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    // Should NOT have finding for default-src unsafe-eval since script-src overrides
    expect(score.findings.some((f) => f.directive === 'default-src' && f.message.includes('unsafe-eval'))).toBe(false);
  });

  it('penalizes wildcard * in script-src', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ['*'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'script-src' && f.message.includes("Wildcard '*'"))).toBe(true);
  });

  it('penalizes wildcard * in default-src', () => {
    const score = scoreCspPolicy({
      'default-src': ['*'],
    });
    expect(score.findings.some((f) => f.directive === 'default-src' && f.points === -25)).toBe(true);
  });
});

// ── Warning findings ───────────────────────────────────────────────────

describe('scoreCspPolicy — warning deductions', () => {
  it('penalizes unsafe-inline in script-src', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(findFinding(score, 'unsafe-inline')).toBe(true);
  });

  it('penalizes data: URIs in script-src', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'self'", 'data:'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.message.includes('data:'))).toBe(true);
  });

  it('penalizes missing default-src', () => {
    const score = scoreCspPolicy({
      'script-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'default-src' && f.message.includes('Missing'))).toBe(true);
  });

  it('penalizes wildcard in non-critical directives', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'img-src': ['*'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'img-src' && f.points === -10)).toBe(true);
  });
});

// ── Info findings ──────────────────────────────────────────────────────

describe('scoreCspPolicy — info deductions', () => {
  it('penalizes missing object-src', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'object-src')).toBe(true);
  });

  it('does not penalize missing object-src when default-src is none', () => {
    const score = scoreCspPolicy({
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'object-src')).toBe(false);
  });

  it('penalizes missing base-uri', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'object-src': ["'none'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'base-uri')).toBe(true);
  });

  it('penalizes missing form-action', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'form-action')).toBe(true);
  });
});

// ── Positive signals ───────────────────────────────────────────────────

describe('scoreCspPolicy — positive signals', () => {
  it('rewards nonce usage', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'nonce-abc123'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.points > 0 && f.message.includes('nonce'))).toBe(true);
  });

  it('rewards hash usage', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'sha256-abc123='"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.points > 0 && f.message.includes('nonce'))).toBe(true);
  });

  it('rewards strict-dynamic', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'nonce-abc'", "'strict-dynamic'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.message.includes('strict-dynamic'))).toBe(true);
  });

  it('rewards report-uri', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'report-uri': ['/csp-report'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.message.includes('reporting'))).toBe(true);
  });

  it('rewards report-to', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'report-to': ['default'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.message.includes('reporting'))).toBe(true);
  });
});

// ── Score clamping ─────────────────────────────────────────────────────

describe('scoreCspPolicy — clamping', () => {
  it('clamps score to 0 for extremely bad policies', () => {
    const score = scoreCspPolicy({
      'script-src': ['*', "'unsafe-inline'", "'unsafe-eval'", 'data:'],
      'style-src': ['*', "'unsafe-inline'"],
      'default-src': ['*', "'unsafe-inline'", "'unsafe-eval'"],
    });
    expect(score.overall).toBeGreaterThanOrEqual(0);
  });

  it('clamps score to 100 maximum', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'nonce-abc'", "'strict-dynamic'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'report-uri': ['/csp'],
    });
    expect(score.overall).toBeLessThanOrEqual(100);
  });
});

// ── Empty policy ───────────────────────────────────────────────────────

describe('scoreCspPolicy — edge cases', () => {
  it('handles empty policy', () => {
    const score = scoreCspPolicy({});
    expect(score.overall).toBeLessThan(100);
    expect(score.grade).toBeDefined();
    expect(findFinding(score, 'Missing default-src')).toBe(true);
  });

  it('penalizes unsafe-inline in script-src-elem', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src-elem': ["'unsafe-inline'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    expect(score.findings.some((f) => f.directive === 'script-src-elem' && f.message.includes('unsafe-inline'))).toBe(true);
  });
});

// ── formatScore ────────────────────────────────────────────────────────

describe('formatScore', () => {
  it('formats a score with findings', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    });
    const output = formatScore(score);
    expect(output).toContain('CSP Score:');
    expect(output).toContain('Grade:');
    expect(output).toContain('Issues:');
    expect(output).toContain('pts)');
  });

  it('formats a perfect score', () => {
    const score = scoreCspPolicy({
      'default-src': ["'self'"],
      'script-src': ["'nonce-abc'", "'strict-dynamic'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'report-uri': ['/csp'],
    });
    const output = formatScore(score);
    expect(output).toContain('Strengths:');
    expect(output).toContain('[+]');
  });
});
