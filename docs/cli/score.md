# score

Score a session's generated CSP policy against security best practices.

## Usage

```bash
csp-analyser score <session-id> [options]
```

## Options

| Option | Default | Description |
|---|---|---|
| `--strictness <level>` | `moderate` | Strictness used when generating the policy to score. |

## Scoring system

The score starts at **100 points** and applies deductions for dangerous patterns and bonuses for security best practices. The final score is clamped to the 0--100 range.

### Grades

| Grade | Score range |
|---|---|
| **A** | 90--100 |
| **B** | 75--89 |
| **C** | 55--74 |
| **D** | 35--54 |
| **F** | 0--34 |

## What it checks

### Critical issues (large deductions)

| Check | Points | Trigger |
|---|---|---|
| `'unsafe-eval'` in script directives | **-30** | Allows arbitrary code execution via `eval()` |
| `'unsafe-eval'` in `default-src` (no script-src override) | **-30** | Falls through to script execution |
| Wildcard `*` in `default-src`, `script-src`, or `script-src-elem` | **-25** | Allows loading from any origin |

### Warnings (moderate deductions)

| Check | Points | Trigger |
|---|---|---|
| `'unsafe-inline'` in script directives | **-20** | Allows inline scripts (XSS risk) |
| `'unsafe-inline'` in `default-src` (no script-src override) | **-20** | Falls through to inline scripts |
| `data:` URIs in script directives | **-20** | Can be used for script injection |
| Missing `default-src` | **-15** | No fallback for undeclared directives |
| Wildcard `*` in non-critical directives | **-10** | Overly permissive |

### Info (minor deductions)

| Check | Points | Trigger |
|---|---|---|
| Missing `object-src` | **-5** | Plugins not blocked (unless `default-src 'none'`) |
| Missing `base-uri` | **-5** | Base tag injection possible |
| Missing `form-action` | **-5** | Forms can submit to any origin |

### Positive signals (bonuses)

| Check | Points | Trigger |
|---|---|---|
| Nonces or hashes used | **+10** | Script integrity via `'nonce-...'` or `'sha256-...'` |
| `'strict-dynamic'` present | **+5** | Trust propagation from nonces/hashes |
| Violation reporting configured | **+5** | `report-uri` or `report-to` present |

## Example output

```
CSP Score: 75/100 (Grade: B)

Issues:
  [!] 'unsafe-inline' allows inline script execution (XSS risk) (-20 pts)
  [?] Missing base-uri — consider adding base-uri 'self' to prevent base tag injection (-5 pts)

Strengths:
  [+] Uses nonces or hashes for script integrity (+10 pts)
  [+] Violation reporting is configured (+5 pts)
```

Finding icons:
- `!!` -- critical issue
- `!` -- warning
- `?` -- informational suggestion
- `+` -- positive signal

## Examples

### Score the default policy

```bash
csp-analyser score abc123
```

### Score a strict policy

```bash
csp-analyser score abc123 --strictness strict
```

A stricter policy typically scores higher because it avoids `'unsafe-inline'` and prefers hashes.

### Compare scores across strictness levels

```bash
for level in strict moderate permissive; do
  echo "=== $level ==="
  csp-analyser score abc123 --strictness $level
  echo
done
```
