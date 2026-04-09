# CSP Injection Strategy — Dual Mode

## Status

Accepted

## Context

CSP Analyser must inject a deny-all `Content-Security-Policy-Report-Only` header on every HTTP response to provoke violations for all resources loaded by the target website. This is the mechanism by which the tool discovers what resources the site needs, so it can build an allow-list policy.

Two distinct scenarios exist:

1. **Local development servers** (localhost, 127.0.0.1, HTTP) — the tool has full control over the browsing environment and can intercept responses directly in the browser
2. **Remote production/staging sites** (HTTPS with existing CSP headers) — the site already sends CSP headers that would conflict with or override the deny-all policy; these must be stripped before the browser sees them

The injection strategy must handle both scenarios transparently, ideally without requiring the user to configure which mode to use.

## Principles

- **Simplest path for the common case**: Local development is the most frequent use case; it should require zero extra infrastructure
- **Automatic mode selection**: The tool should detect which mode is needed rather than requiring manual configuration
- **Minimal attack surface**: The MITM proxy should only run when actually needed, not as a permanent fixture

## Requirements, Constraints, and Considerations

- Must inject a deny-all report-only CSP on every response, regardless of what the origin server sends
- Must strip any existing `Content-Security-Policy` and `Content-Security-Policy-Report-Only` headers from remote sites
- Must work with both HTTP and HTTPS targets
- The deny-all CSP must include a `report-uri` directive pointing to the local report collector
- Must not break page rendering (report-only mode does not block resources, only reports violations)
- MITM proxy must handle TLS with auto-generated certificates
- Playwright must trust the MITM proxy's CA certificate

## Options

### Local Mode Only (Playwright page.route)

- Uses Playwright's `page.route('**/*', handler)` to intercept every response and add/replace the CSP header before the browser processes it
- Works perfectly for HTTP targets and localhost HTTPS (where Playwright can be configured to ignore cert errors)
- Fails for remote HTTPS sites that set CSP headers at the TLS/transport level — `page.route()` intercepts at the application level but the browser may have already processed the original CSP header in some edge cases
- Cannot strip headers from HTTP/2 server push or early hints

### MITM Proxy Only (http-mitm-proxy)

- Routes all browser traffic through a local MITM proxy that intercepts every response at the network level
- Strips existing CSP headers and injects the deny-all policy before the response reaches the browser
- Works universally for all targets (local and remote, HTTP and HTTPS)
- Adds infrastructure overhead (proxy process, CA certificate, Playwright proxy configuration) even for simple localhost testing
- Introduces a performance penalty from the extra network hop
- Requires the user to trust a locally generated CA certificate (or configure Playwright to ignore cert errors)

### Dual Mode with Auto-Detection

- **Local mode**: For localhost/127.0.0.1/HTTP targets, use `page.route()` response interception. Zero extra infrastructure.
- **MITM mode**: For remote HTTPS targets, start http-mitm-proxy, configure Playwright to route through it, strip existing CSP headers at the proxy level.
- Auto-detect mode based on the target URL. User can override with `--mode local|mitm`.
- Each mode uses the same deny-all CSP header value and the same report-uri endpoint; only the injection point differs.

### Comparison

| Criterion | Local only | MITM only | Dual mode |
|-----------|-----------|-----------|-----------|
| Localhost HTTP | Works | Overkill | Local mode (simple) |
| Localhost HTTPS | Works | Works | Local mode (simple) |
| Remote HTTP | Works | Works | Local mode (simple) |
| Remote HTTPS (no existing CSP) | Works | Works | Local mode (simple) |
| Remote HTTPS (existing CSP) | May fail | Works | MITM mode (reliable) |
| Setup complexity | None | CA cert + proxy config | Auto-detected |
| Performance | No overhead | Extra hop | Overhead only when needed |
| User configuration | None | Required | Optional override |

## Decision

Use **Dual Mode with Auto-Detection**.

The auto-detection logic:

```
if hostname is localhost/127.0.0.1/[::1] → local mode
if protocol is http: → local mode
if protocol is https: and hostname is remote → MITM mode
user can override with --mode flag or mode parameter in MCP tool
```

This was chosen because:

1. **90% of usage is local development** where `page.route()` is simpler, faster, and requires zero extra infrastructure
2. **MITM mode is only needed for the specific case** of remote HTTPS sites with existing CSP headers — a real but less common scenario
3. **Auto-detection eliminates configuration** — the user provides a URL and the tool does the right thing
4. Both modes produce identical violation data (same CSP header, same report-uri, same SQLite storage), so the downstream pipeline is mode-agnostic

## Consequences

- The codebase has two injection code paths that must be kept in sync (same deny-all CSP header value, same report-uri format)
- Testing requires coverage of both modes
- Users testing remote HTTPS sites will see a brief delay as the MITM proxy starts and generates certificates on first use
- The CA certificate is persisted in `.csp-analyser/certs/` across sessions, so the generation cost is one-time

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `page.route()` misses CSP headers on remote HTTPS in edge cases | Low | Medium | Auto-detection routes remote HTTPS to MITM mode, avoiding the edge case entirely |
| Auto-detection makes the wrong choice | Low | Low | User can override with explicit `--mode` flag; error messages suggest trying the other mode if violations are unexpectedly empty |
| Two code paths diverge over time | Medium | Low | Both modes call the same `buildDenyAllCSP()` function; integration tests cover both paths |
