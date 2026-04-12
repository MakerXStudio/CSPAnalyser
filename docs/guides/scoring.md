---
title: Policy Scoring
description: Understand how your CSP policy is scored against best practices
---

# Policy Scoring

CSP Analyser scores your generated policy on a 0--100 scale against established CSP best practices. The score starts at 100 and is adjusted by deductions (for dangerous patterns) and bonuses (for security best practices).

## Grade boundaries

| Grade | Score range | Meaning |
|:-----:|:----------:|---------|
| **A** | 90--100 | Excellent -- follows best practices with no critical issues |
| **B** | 75--89 | Good -- minor improvements possible |
| **C** | 55--74 | Fair -- some significant security gaps |
| **D** | 35--54 | Poor -- multiple security issues need attention |
| **F** | 0--34 | Failing -- critical security problems |

## Scoring rubric

### Critical deductions

| Finding | Points | Condition |
|---------|:------:|-----------|
| `'unsafe-eval'` in script directives | **-30** | `script-src`, `script-src-elem`, or `script-src-attr` contains `'unsafe-eval'` |
| `'unsafe-eval'` in `default-src` | **-30** | `default-src` contains `'unsafe-eval'` and no explicit `script-src` overrides it |
| Wildcard `*` in critical directives | **-25** | `default-src`, `script-src`, or `script-src-elem` contains `*` |

### Warning deductions

| Finding | Points | Condition |
|---------|:------:|-----------|
| `'unsafe-inline'` in script directives | **-20** | `script-src`, `script-src-elem`, or `script-src-attr` contains `'unsafe-inline'` |
| `'unsafe-inline'` in `default-src` | **-20** | `default-src` contains `'unsafe-inline'` and no explicit `script-src` overrides it |
| `data:` in script directives | **-20** | `script-src`, `script-src-elem`, or `script-src-attr` contains `data:` |
| Missing `default-src` | **-15** | Policy does not declare `default-src` |
| Wildcard `*` in other directives | **-10** | Any non-critical directive contains `*` |

### Info deductions

| Finding | Points | Condition |
|---------|:------:|-----------|
| Missing `object-src` | **-5** | No `object-src` declared and `default-src` is not `'none'` |
| Missing `base-uri` | **-5** | No `base-uri` declared |
| Missing `form-action` | **-5** | No `form-action` declared |

### Positive bonuses

| Finding | Points | Condition |
|---------|:------:|-----------|
| Nonces or hashes | **+10** | Any directive uses `'nonce-...'`, `'sha256-...'`, `'sha384-...'`, or `'sha512-...'` |
| `'strict-dynamic'` | **+5** | `script-src`, `script-src-elem`, `script-src-attr`, or `default-src` contains `'strict-dynamic'` |
| Violation reporting | **+5** | `report-uri` or `report-to` directive is present |

## Example output

```
CSP Score: 80/100 (Grade: B)

Issues:
  [!] 'unsafe-inline' allows inline script execution (XSS risk) (-20 pts)

Strengths:
  [+] Violation reporting is configured (+5 pts)
```

Findings are sorted by severity (most impactful first). The icons indicate severity:

- `!!` -- critical
- `!` -- warning
- `?` -- info
- `+` -- positive

## Common findings and how to fix them

### `'unsafe-eval'` allows arbitrary code execution

**Impact:** Critical (-30 points)

Your site or a dependency uses `eval()`, `new Function()`, or similar dynamic code execution. This is one of the most dangerous CSP bypasses.

**How to fix:**
1. Identify the source using the violation details (`sourceFile`, `lineNumber`)
2. Refactor the code to avoid `eval()` -- most uses can be replaced with JSON parsing, template literals, or static function references
3. If a third-party library requires it and cannot be replaced, isolate it in a sandboxed iframe with its own restrictive policy

### `'unsafe-inline'` allows inline script execution

**Impact:** Warning (-20 points)

Inline `<script>` tags or inline event handlers (`onclick`, `onload`) are in use. This is the primary XSS attack vector that CSP is designed to prevent.

**How to fix:**
1. Move inline scripts to external `.js` files
2. Use nonces or hashes instead of `'unsafe-inline'` -- CSP Analyser can generate SHA-256 hashes for short inline scripts when samples are available
3. Remove inline event handlers and use `addEventListener()` instead

### Missing `object-src`

**Impact:** Info (-5 points)

Without `object-src`, the `default-src` fallback applies to `<object>`, `<embed>`, and `<applet>` elements. If `default-src` is not `'none'`, plugins could be loaded.

**How to fix:** Most modern sites do not use plugins. Add `object-src 'none'` to your policy. CSP Analyser generates this automatically at the `strict` level.

### Missing `base-uri`

**Impact:** Info (-5 points)

Without `base-uri`, an attacker who can inject HTML could add a `<base>` tag to redirect all relative URLs.

**How to fix:** Add `base-uri 'self'` to your policy.

## Usage

::: code-group

```bash [CLI]
csp-analyser score <session-id>
csp-analyser score <session-id> --strictness strict
```

```json [MCP]
{
  "tool": "score_policy",
  "sessionId": "...",
  "strictness": "strict"
}
```

:::

::: tip
Re-score with `--strictness strict` to see how much your score improves with tighter source expressions. Wildcards in non-critical directives cost -10 points each.
:::
