// ── Types ──────────────────────────────────────────────────────────────

export type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

export type FindingSeverity = 'critical' | 'warning' | 'info' | 'positive';

export interface Finding {
  directive: string;
  message: string;
  severity: FindingSeverity;
  points: number;
}

export interface CspScore {
  overall: number;
  grade: Grade;
  findings: Finding[];
}

// ── Scoring rules ──────────────────────────────────────────────────────

function scoreToGrade(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 55) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function directiveContains(
  directives: Record<string, string[]>,
  directive: string,
  value: string,
): boolean {
  return directive in directives && directives[directive].includes(value);
}

/**
 * Scores a CSP policy against best practices.
 *
 * Starts at 100 and applies deductions for dangerous patterns
 * and bonuses for security best practices. Clamped to 0–100.
 */
export function scoreCspPolicy(directives: Record<string, string[]>): CspScore {
  const findings: Finding[] = [];

  // All directives to check for unsafe values (including default-src fallback targets)
  const allDirectiveNames = Object.keys(directives);
  const scriptDirectives = ['script-src', 'script-src-elem', 'script-src-attr'];

  // ── Critical deductions ────────────────────────────────────────────

  // unsafe-eval in script directives
  for (const d of scriptDirectives) {
    if (directiveContains(directives, d, "'unsafe-eval'")) {
      findings.push({
        directive: d,
        message: `'unsafe-eval' allows arbitrary code execution via eval()`,
        severity: 'critical',
        points: -30,
      });
    }
  }
  // unsafe-eval in default-src (only if no explicit script-src overrides)
  if (
    directiveContains(directives, 'default-src', "'unsafe-eval'") &&
    !scriptDirectives.some((d) => d in directives)
  ) {
    findings.push({
      directive: 'default-src',
      message: `'unsafe-eval' in default-src allows arbitrary code execution`,
      severity: 'critical',
      points: -30,
    });
  }

  // Wildcard * as sole source in critical directives
  for (const d of ['default-src', 'script-src', 'script-src-elem']) {
    if (directiveContains(directives, d, '*')) {
      findings.push({
        directive: d,
        message: `Wildcard '*' allows loading from any origin`,
        severity: 'critical',
        points: -25,
      });
    }
  }

  // ── Warning deductions ─────────────────────────────────────────────

  // unsafe-inline in script directives
  for (const d of scriptDirectives) {
    if (directiveContains(directives, d, "'unsafe-inline'")) {
      findings.push({
        directive: d,
        message: `'unsafe-inline' allows inline script execution (XSS risk)`,
        severity: 'warning',
        points: -20,
      });
    }
  }
  // unsafe-inline in default-src (only if no explicit script-src)
  if (
    directiveContains(directives, 'default-src', "'unsafe-inline'") &&
    !scriptDirectives.some((d) => d in directives)
  ) {
    findings.push({
      directive: 'default-src',
      message: `'unsafe-inline' in default-src allows inline scripts (XSS risk)`,
      severity: 'warning',
      points: -20,
    });
  }

  // data: URIs in script-src
  for (const d of scriptDirectives) {
    if (directiveContains(directives, d, 'data:')) {
      findings.push({
        directive: d,
        message: `'data:' URIs in ${d} can be used for script injection`,
        severity: 'warning',
        points: -20,
      });
    }
  }

  // Missing default-src
  if (!('default-src' in directives)) {
    findings.push({
      directive: 'default-src',
      message: 'Missing default-src — no fallback for undeclared directives',
      severity: 'warning',
      points: -15,
    });
  }

  // Wildcard domains in non-critical directives
  for (const d of allDirectiveNames) {
    if (['default-src', 'script-src', 'script-src-elem'].includes(d)) continue;
    if (directiveContains(directives, d, '*')) {
      findings.push({
        directive: d,
        message: `Wildcard '*' in ${d} is overly permissive`,
        severity: 'warning',
        points: -10,
      });
    }
  }

  // 'unsafe-hashes' in script-src-attr or style-src-attr. This keyword is
  // required for hashes to apply to inline event handlers and style="..."
  // attributes, but it broadens the attack surface: any attribute with the
  // same hashed content is allowed anywhere in the DOM. Prefer refactoring
  // inline handlers to addEventListener and inline styles to CSS classes.
  for (const d of ['script-src-attr', 'style-src-attr']) {
    if (directiveContains(directives, d, "'unsafe-hashes'")) {
      findings.push({
        directive: d,
        message: `'unsafe-hashes' in ${d} broadens the attack surface — consider refactoring inline ${
          d === 'script-src-attr' ? 'event handlers to addEventListener' : 'styles to CSS classes'
        }`,
        severity: 'info',
        points: -5,
      });
    }
  }

  // ── Info deductions (missing hardening directives) ─────────────────

  if (!('object-src' in directives) && !directiveContains(directives, 'default-src', "'none'")) {
    findings.push({
      directive: 'object-src',
      message: "Missing object-src — consider adding object-src 'none' to block plugins",
      severity: 'info',
      points: -5,
    });
  }

  if (!('base-uri' in directives)) {
    findings.push({
      directive: 'base-uri',
      message: "Missing base-uri — consider adding base-uri 'self' to prevent base tag injection",
      severity: 'info',
      points: -5,
    });
  }

  if (!('form-action' in directives)) {
    findings.push({
      directive: 'form-action',
      message: 'Missing form-action — forms can submit to any origin',
      severity: 'info',
      points: -5,
    });
  }

  // ── Positive signals ───────────────────────────────────────────────

  // Nonces or hashes used
  const hasNoncesOrHashes = allDirectiveNames.some((d) => {
    const sources = directives[d];
    return sources.some(
      (s) =>
        s.startsWith("'nonce-") ||
        s.startsWith("'sha256-") ||
        s.startsWith("'sha384-") ||
        s.startsWith("'sha512-"),
    );
  });
  if (hasNoncesOrHashes) {
    findings.push({
      directive: 'script-src',
      message: 'Uses nonces or hashes for script integrity',
      severity: 'positive',
      points: 10,
    });
  }

  // strict-dynamic
  const hasStrictDynamic = [...scriptDirectives, 'default-src'].some((d) =>
    directiveContains(directives, d, "'strict-dynamic'"),
  );
  if (hasStrictDynamic) {
    findings.push({
      directive: 'script-src',
      message: "'strict-dynamic' enables trust propagation from nonces/hashes",
      severity: 'positive',
      points: 5,
    });
  }

  // report-uri or report-to present
  if ('report-uri' in directives || 'report-to' in directives) {
    findings.push({
      directive: 'report-uri' in directives ? 'report-uri' : 'report-to',
      message: 'Violation reporting is configured',
      severity: 'positive',
      points: 5,
    });
  }

  // ── Calculate score ────────────────────────────────────────────────

  const totalPoints = findings.reduce((sum, f) => sum + f.points, 0);
  const overall = Math.max(0, Math.min(100, 100 + totalPoints));

  return {
    overall,
    grade: scoreToGrade(overall),
    findings: findings.sort((a, b) => a.points - b.points),
  };
}

// ── Formatting ─────────────────────────────────────────────────────────

export function formatScore(score: CspScore): string {
  const lines: string[] = [];

  lines.push(`CSP Score: ${score.overall}/100 (Grade: ${score.grade})`);
  lines.push('');

  const negativeFindings = score.findings.filter((f) => f.points < 0);
  const positiveFindings = score.findings.filter((f) => f.points > 0);

  if (negativeFindings.length > 0) {
    lines.push('Issues:');
    for (const f of negativeFindings) {
      const icon = f.severity === 'critical' ? '!!' : f.severity === 'warning' ? '!' : '?';
      lines.push(`  [${icon}] ${f.message} (${f.points} pts)`);
    }
  }

  if (positiveFindings.length > 0) {
    if (negativeFindings.length > 0) lines.push('');
    lines.push('Strengths:');
    for (const f of positiveFindings) {
      lines.push(`  [+] ${f.message} (+${f.points} pts)`);
    }
  }

  if (negativeFindings.length === 0 && positiveFindings.length === 0) {
    lines.push('  No specific findings.');
  }

  return lines.join('\n');
}
