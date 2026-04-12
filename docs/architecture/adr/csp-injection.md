---
title: "ADR: CSP Injection Strategy"
description: Dual-mode CSP injection with auto-detection
---

# ADR: CSP Injection Strategy: Dual Mode

## Status

Accepted

## Context

CSP Analyser must inject a deny-all `Content-Security-Policy-Report-Only` header on every HTTP response to provoke violations for all resources loaded by the target website. This is the mechanism by which the tool discovers what resources the site needs, so it can build an allow-list policy.

Two distinct scenarios exist:

1. **Local development servers** (localhost, 127.0.0.1, HTTP): the tool has full control over the browsing environment and can intercept responses directly in the browser
2. **Remote production/staging sites** (HTTPS with existing CSP headers): the site already sends CSP headers that would conflict with or override the deny-all policy; these must be stripped before the browser sees them

The injection strategy must handle both scenarios transparently, ideally without requiring the user to configure which mode to use.

## Principles

- **Simplest path for the common case**: Local development is the most frequent use case; it should require zero extra infrastructure
- **Automatic mode selection**: The tool should detect which mode is needed rather than requiring manual configuration
- **Minimal attack surface**: The MITM proxy should only run when actually needed, not as a permanent fixture

## Options

### Local Mode Only (Playwright page.route)

Uses Playwright's `page.route('**/*', handler)` to intercept every response and add/replace the CSP header before the browser processes it. Works perfectly for HTTP targets and localhost HTTPS. May fail for remote HTTPS sites that set CSP headers at the TLS/transport level.

### MITM Proxy Only (http-mitm-proxy)

Routes all browser traffic through a local MITM proxy that intercepts every response at the network level. Works universally but adds infrastructure overhead even for simple localhost testing.

### Dual Mode with Auto-Detection

- **Local mode**: For localhost/127.0.0.1/HTTP targets, use `page.route()` response interception
- **MITM mode**: For remote HTTPS targets, start http-mitm-proxy, configure Playwright to route through it
- Auto-detect mode based on the target URL; user can override with `--mode local|mitm`

### Comparison

| Criterion | Local only | MITM only | Dual mode |
|-----------|-----------|-----------|-----------|
| Localhost HTTP | Works | Overkill | Local mode (simple) |
| Remote HTTPS (existing CSP) | May fail | Works | MITM mode (reliable) |
| Setup complexity | None | CA cert + proxy config | Auto-detected |
| Performance | No overhead | Extra hop | Overhead only when needed |

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
2. **MITM mode is only needed for the specific case** of remote HTTPS sites with existing CSP headers
3. **Auto-detection eliminates configuration**. The user provides a URL and the tool does the right thing.
4. Both modes produce identical violation data (same CSP header, same report-uri, same SQLite storage), so the downstream pipeline is mode-agnostic

## Consequences

- The codebase has two injection code paths that must be kept in sync (same deny-all CSP header value, same report-uri format)
- Testing requires coverage of both modes
- Users testing remote HTTPS sites will see a brief delay as the MITM proxy starts and generates certificates on first use
- The CA certificate is persisted in `.csp-analyser/certs/` across sessions, so the generation cost is one-time

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `page.route()` misses CSP headers on remote HTTPS in edge cases | Low | Medium | Auto-detection routes remote HTTPS to MITM mode |
| Auto-detection makes the wrong choice | Low | Low | User can override with explicit `--mode` flag |
| Two code paths diverge over time | Medium | Low | Both modes call the same `buildDenyAllCSP()` function; integration tests cover both paths |
