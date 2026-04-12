# Violation Capture Mechanism — Triple Capture

## Status

Accepted

## Context

When a browser encounters a `Content-Security-Policy-Report-Only` header that blocks a resource, it fires a CSP violation. The tool must capture every violation to build a complete picture of what resources the site loads.

CSP violations can be observed through three browser mechanisms:

1. **DOM `securitypolicyviolation` event** — fired on the document when a violation occurs, accessible via JavaScript event listeners
2. **`report-uri` directive** — the CSP header includes a URL; the browser POSTs a JSON violation report to it
3. **Reporting API v1 (`report-to` directive)** — the modern replacement for `report-uri`; uses a separate `Report-To` header and the `report-to` CSP directive

Each mechanism has different timing, data richness, and browser support characteristics. Missing even a single violation means the generated CSP policy will block a legitimate resource in production.

## Principles

- **Completeness over efficiency**: It is better to capture the same violation twice (and deduplicate) than to miss one
- **Defence in depth**: No single capture mechanism is reliable in all scenarios
- **Data richness**: Prefer mechanisms that provide the most diagnostic information (source file, line number, column number)

## Requirements, Constraints, and Considerations

- Must capture violations that fire during early page load (before JavaScript init scripts execute)
- Must capture violations from inline scripts, external scripts, images, fonts, stylesheets, fetch/XHR, WebSocket, iframes, and workers
- Must capture the blocked URI, violated directive, effective directive, source file, and line/column number where available
- Must deduplicate violations (same page + blocked URI + effective directive = one record)
- Must work in Chromium (primary target), with Firefox and WebKit as secondary
- The report collector endpoint must be running before page navigation begins
- Violation data must be written to SQLite synchronously to prevent data loss

## Options

### DOM Event Listener Only

- Inject a `securitypolicyviolation` event listener via `page.addInitScript()` before any page navigation
- Bridge the event data to Node.js via `page.exposeFunction('__cspViolationReport', callback)`
- Provides the richest data: `violatedDirective`, `effectiveDirective`, `blockedURI`, `sourceFile`, `lineNumber`, `columnNumber`, `originalPolicy`, `documentURI`, `disposition`, `sample` (snippet of the violating code)
- **Limitation**: The init script runs after the document is created but some violations fire during the HTML parse phase, before any scripts execute. These early violations (e.g., a `<link>` tag in `<head>` loading a stylesheet) may be missed.

### Report-URI Endpoint Only

- Include `report-uri http://localhost:{port}/csp-report` in the CSP header
- Run a local HTTP server to receive `POST` requests with `Content-Type: application/csp-report`
- The browser sends reports asynchronously; the tool processes them as they arrive
- Catches all violations including early-load ones, because the browser queues reports and sends them regardless of script execution timing
- **Limitation**: Report-URI format provides less data than the DOM event (`sample` field may be absent; `sourceFile` is sometimes a URL rather than a readable path). Chrome has deprecated `report-uri` in favour of `report-to` (though it still works as of 2026).

### Triple Capture (DOM Event + Report-URI + Reporting API)

- Use all three mechanisms simultaneously:
  1. **DOM event listener** via `page.addInitScript()` + `page.exposeFunction()` — primary capture, richest data
  2. **`report-uri`** pointing to local HTTP server — catches early-load violations missed by the DOM listener
  3. **`report-to`** with Reporting API v1 headers — modern replacement, catches violations in browsers that have fully deprecated `report-uri`
- All three feed into the same SQLite table with a `captured_via` column (`dom_event`, `report_uri`, `reporting_api`)
- Deduplication via `UNIQUE(session_id, document_uri, blocked_uri, effective_directive)` constraint — `INSERT OR IGNORE` ensures the first capture wins; later duplicates are silently dropped
- When duplicates arrive, the DOM event version is preferred (richer data) by inserting DOM events first (they fire synchronously) and letting report-uri/reporting-api duplicates be ignored

### Comparison

| Criterion | DOM event only | Report-URI only | Triple capture |
|-----------|---------------|-----------------|----------------|
| Early-load violations | May miss | Captures all | Captures all |
| Data richness | Highest (sample, line, column) | Moderate | Highest (DOM event preferred) |
| Browser compatibility | All modern | Deprecated in Chrome (still works) | Full coverage |
| Implementation complexity | Low | Low | Medium |
| Deduplication needed | No | No | Yes (SQLite UNIQUE) |
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

1. **A missing violation means a broken production CSP**. The cost of a false negative (missing a legitimate resource) is a broken site in production. The cost of deduplication (a few extra SQLite writes that are silently dropped) is negligible.
2. **DOM events and report-uri have complementary timing**: DOM events fire synchronously and provide rich data; report-uri catches violations that fire before the init script runs.
3. **The Reporting API is the future**: Chrome is moving toward `report-to`; including it now means the tool works correctly as browsers evolve.
4. **Deduplication is trivial**: A single `UNIQUE` constraint with `INSERT OR IGNORE` handles overlapping captures with zero application code.

## Consequences

- The report collector HTTP server must start before page navigation begins (sequenced in the session manager)
- The CSP header is slightly longer due to including both `report-uri` and `report-to` directives
- Three code paths write to the same table; the `captured_via` column allows debugging which mechanism captured a given violation
- The DOM event listener init script adds ~500 bytes of JavaScript to every page (negligible impact)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Report collector not ready before page navigates | Low | High | Session manager ensures report server is listening before crawler navigates; health check endpoint confirms readiness |
| Browser drops report-uri support entirely | Low (years away) | Medium | Reporting API v1 (`report-to`) is included as the replacement; DOM event listener is the primary mechanism regardless |
| Deduplication UNIQUE constraint causes INSERT failures for legitimate distinct violations | Very low | Low | The constraint uses `(session_id, document_uri, blocked_uri, effective_directive)` — this tuple uniquely identifies a violation. Two violations with different blocked URIs or directives are distinct records |
