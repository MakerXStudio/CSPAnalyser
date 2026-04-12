---
title: "ADR: Violation Capture Mechanism"
description: Triple capture via DOM events, report-uri, and Reporting API
---

# ADR: Violation Capture Mechanism -- Triple Capture

## Status

Accepted

## Context

When a browser encounters a `Content-Security-Policy-Report-Only` header that blocks a resource, it fires a CSP violation. The tool must capture every violation to build a complete picture of what resources the site loads.

CSP violations can be observed through three browser mechanisms:

1. **DOM `securitypolicyviolation` event** -- fired on the document when a violation occurs, accessible via JavaScript event listeners
2. **`report-uri` directive** -- the CSP header includes a URL; the browser POSTs a JSON violation report to it
3. **Reporting API v1 (`report-to` directive)** -- the modern replacement for `report-uri`; uses a separate `Report-To` header

Each mechanism has different timing, data richness, and browser support characteristics. Missing even a single violation means the generated CSP policy will block a legitimate resource in production.

## Principles

- **Completeness over efficiency**: It is better to capture the same violation twice (and deduplicate) than to miss one
- **Defence in depth**: No single capture mechanism is reliable in all scenarios
- **Data richness**: Prefer mechanisms that provide the most diagnostic information

## Options

### DOM Event Listener Only

Inject a `securitypolicyviolation` event listener via `page.addInitScript()`. Provides the richest data (sample, line, column) but may miss early-load violations that fire during HTML parsing before scripts execute.

### Report-URI Endpoint Only

Include `report-uri` in the CSP header and run a local HTTP server. Catches all violations including early-load ones, but provides less diagnostic data. Chrome has deprecated `report-uri` in favour of `report-to`.

### Triple Capture (DOM Event + Report-URI + Reporting API)

Use all three mechanisms simultaneously. All three feed into the same SQLite table with a `captured_via` column. Deduplication via `UNIQUE(session_id, document_uri, blocked_uri, effective_directive)` constraint with `INSERT OR IGNORE`.

### Comparison

| Criterion | DOM event only | Report-URI only | Triple capture |
|-----------|---------------|-----------------|----------------|
| Early-load violations | May miss | Captures all | Captures all |
| Data richness | Highest | Moderate | Highest (DOM preferred) |
| Browser compatibility | All modern | Deprecated in Chrome | Full coverage |
| Reliability | Single point of failure | Single point of failure | Triple redundancy |

## Decision

Use **Triple Capture** (DOM event + report-uri + Reporting API).

The deny-all CSP header includes both reporting directives:

```
Content-Security-Policy-Report-Only:
  default-src 'none';
  script-src 'none';
  style-src 'none';
  img-src 'none';
  font-src 'none';
  connect-src 'none';
  media-src 'none';
  object-src 'none';
  frame-src 'none';
  worker-src 'none';
  child-src 'none';
  form-action 'none';
  base-uri 'none';
  manifest-src 'none';
  report-uri http://localhost:{port}/csp-report;
  report-to csp-endpoint
```

With a companion `Report-To` response header:

```
Report-To: {"group":"csp-endpoint","max_age":86400,"endpoints":[{"url":"http://localhost:{port}/reports"}]}
```

This was chosen because:

1. **A missing violation means a broken production CSP.** The cost of a false negative is a broken site in production. The cost of deduplication is negligible.
2. **DOM events and report-uri have complementary timing.** DOM events fire synchronously with rich data; report-uri catches violations that fire before the init script runs.
3. **The Reporting API is the future.** Chrome is moving toward `report-to`; including it now means the tool works correctly as browsers evolve.
4. **Deduplication is trivial.** A single `UNIQUE` constraint with `INSERT OR IGNORE` handles overlapping captures with zero application code.

## Consequences

- The report collector HTTP server must start before page navigation begins
- The CSP header is slightly longer due to including both `report-uri` and `report-to` directives
- Three code paths write to the same table; the `captured_via` column allows debugging which mechanism captured a given violation
- The DOM event listener init script adds ~500 bytes of JavaScript to every page

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Report collector not ready before page navigates | Low | High | Session manager ensures report server is listening before crawler navigates; health check confirms readiness |
| Browser drops report-uri support entirely | Low (years away) | Medium | Reporting API v1 is included as replacement; DOM listener is primary regardless |
| UNIQUE constraint drops legitimate distinct violations | Very low | Low | Constraint uses `(session_id, document_uri, blocked_uri, effective_directive)` which uniquely identifies a violation |
