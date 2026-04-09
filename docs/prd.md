# CSP Analyser — Product Requirements Document

## 1. Overview

CSP Analyser is a local developer tool that automates the creation of Content Security Policy (CSP) headers for web applications. It headlessly browses a target website with a deny-all report-only CSP, captures all violations, and generates a minimal, correct policy ready for production deployment.

The tool is exposed as an MCP (Model Context Protocol) server for use by AI coding agents (Claude Code, Codex, Gemini, Copilot) and as a standalone CLI for direct terminal usage.

## 2. Problem Statement

Building CSP headers manually is error-prone and time-consuming:

- Developers must audit every resource loaded across every page of their application
- Authenticated pages load different resources than public pages
- Third-party scripts, fonts, images, and API calls are easy to miss
- CSP directives have complex fallback semantics (`default-src` applies when specific directives are absent)
- Existing CSP headers on remote sites interfere with testing
- There is no standard way for AI coding agents to build CSP policies

## 3. Target Users

- **Web developers** deploying applications that need CSP headers
- **Security engineers** auditing existing CSP policies for gaps
- **AI coding agents** (Claude Code, Codex, Gemini, Copilot) automating security configuration
- **DevOps engineers** generating CSP configs for nginx, Apache, Cloudflare

## 4. Core Features

### F1: Headless Website Crawling

Automatically navigate a target website using Playwright, discovering and visiting pages up to a configurable depth.

**Acceptance criteria:**
- Crawl a site starting from a given URL
- Follow same-origin links up to a configurable depth (default: 1)
- Respect a maximum page count (default: 10)
- Wait for network idle before capturing violations
- Record each crawled page URL and HTTP status code

### F2: Interactive Manual Browsing Mode

Open a headed (visible) browser where the user navigates the application manually while violations are captured in the background.

**Acceptance criteria:**
- Launch a headed Chromium browser with CSP injection active
- Display a live violation counter in the terminal
- Capture all violations as the user navigates
- Generate the policy when the user closes the browser or presses Ctrl+C

### F3: Authentication Support

Support three authentication patterns to handle sites requiring login.

**Acceptance criteria:**
- Accept a Playwright `storageState` JSON file path for pre-authenticated sessions
- Open a headed browser for manual login, capture `storageState` on completion
- Accept raw cookies for injection into the browser context

### F4: Deny-All Report-Only CSP Injection

Inject a maximally restrictive `Content-Security-Policy-Report-Only` header on every page response to provoke violations for all loaded resources.

**Acceptance criteria:**
- The injected policy blocks all resource types: scripts, styles, images, fonts, connections, media, objects, frames, workers, forms, base URIs, manifests
- The policy includes a `report-uri` pointing to the local report collector
- In local mode, injection happens via Playwright `page.route()` response interception
- In MITM mode, injection happens via the reverse proxy stripping existing CSP headers and adding the deny-all policy

### F5: Triple Violation Capture

Capture CSP violations through three complementary mechanisms to ensure no violations are missed.

**Acceptance criteria:**
- DOM `securitypolicyviolation` event listener injected via `page.addInitScript()` and bridged to Node.js via `page.exposeFunction()`
- Local HTTP server receives `report-uri` POST requests (`application/csp-report`)
- Local HTTP server receives Reporting API v1 POST requests (`application/reports+json`)
- All violations are deduplicated before storage (same session + document URI + blocked URI + directive = one record)

### F6: SQLite Violation Storage

Store all violations, crawled pages, sessions, and generated policies in a local SQLite database.

**Acceptance criteria:**
- Database file created in the project working directory (`.csp-analyser/data.db`)
- Schema supports sessions, pages, violations, and policies tables
- Violations queryable by directive, page URL, origin, with grouping
- Session-based isolation (multiple analysis runs don't interfere)

### F7: MITM Reverse Proxy

Intercept HTTPS responses from remote sites to strip existing CSP headers and inject the deny-all policy.

**Acceptance criteria:**
- Auto-generate a local CA certificate on first use (stored in `.csp-analyser/certs/`)
- Start an HTTP MITM proxy that Playwright routes traffic through
- Strip `Content-Security-Policy` and `Content-Security-Policy-Report-Only` response headers
- Inject the deny-all report-only CSP header
- Auto-detect when MITM mode is needed (remote HTTPS URLs) vs local mode (localhost/HTTP)

### F8: CSP Policy Generation

Analyze collected violations and generate a minimal, correct CSP policy.

**Acceptance criteria:**
- Map blocked URIs to appropriate CSP source expressions (`'self'`, `'unsafe-inline'`, `data:`, exact origins, wildcard domains)
- Support three strictness levels: strict (exact origins), moderate (domain wildcards for CDNs), permissive (broad wildcards)
- Optimize with `default-src` factoring when multiple directives share the same sources
- Optionally include `'sha256-...'` hashes for inline scripts/styles

### F9: Policy Export

Output the generated policy in multiple formats suitable for different deployment targets.

**Acceptance criteria:**
- Raw header string: `Content-Security-Policy: ...`
- HTML meta tag: `<meta http-equiv="Content-Security-Policy" content="...">`
- nginx config: `add_header Content-Security-Policy "..." always;`
- Apache config: `Header always set Content-Security-Policy "..."`
- Cloudflare Workers/Pages format
- Structured JSON for programmatic consumption

### F10: MCP Server Interface

Expose all functionality as MCP tools for AI coding agent consumption.

**Acceptance criteria:**
- Register tools: `start_session`, `authenticate_session`, `crawl_url`, `crawl_site`, `get_violations`, `generate_policy`, `export_policy`
- Each tool has a typed JSON Schema input definition
- Tools return structured responses suitable for agent consumption
- Configurable in Claude Code, Codex, and other MCP-compatible agents

### F11: CLI Interface

Provide a standalone command-line interface with two modes.

**Acceptance criteria:**
- `csp-analyser crawl <url>` — headless auto-crawl mode with flags for depth, max pages, strictness, output format
- `csp-analyser interactive <url>` — headed manual browsing mode with live terminal output
- `csp-analyser generate <session-id>` — regenerate policy from existing session data
- `csp-analyser export <session-id> --format <format>` — export policy in specified format
- Clear help text and error messages

## 5. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Runs entirely locally | No cloud dependencies, no data leaves the machine |
| Portable data | Single SQLite file, can be shared or committed |
| Session isolation | Multiple concurrent analysis sessions don't interfere |
| Idempotent crawling | Re-crawling a URL in a session updates rather than duplicates |
| Fast startup | MCP server starts in under 2 seconds |
| TypeScript strict mode | Full type safety across the codebase |

## 6. Out of Scope (Initial Release)

- Permissions-Policy analysis (future addition)
- Distributed/remote analysis (this is a local tool)
- Browser extensions
- GUI/web dashboard
- Automatic CSP deployment to production
- CSP nonce injection into application source code

## 7. Tech Stack

| Component | Library | Version |
|-----------|---------|---------|
| Browser automation | Playwright | 1.59.1 |
| Database | better-sqlite3 | 12.8.0 |
| HTTPS proxy | http-mitm-proxy | 1.1.0 |
| Agent protocol | @modelcontextprotocol/sdk | 1.29.0 |
| Testing | Vitest | latest |
| Language | TypeScript | strict mode |
| Runtime | Node.js | 24.x |

## 8. Implementation Status

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| 0 | PRD + ADRs | Complete | PRD, 3 ADRs committed |
| 1 | Foundation | Complete | package.json, tsconfig, types.ts, DB schema/repository, utils, index.ts |
| 2 | Violation Capture Pipeline | Complete | report-server, report-parser, csp-injector, violation-listener, crawler |
| 3 | Policy Generation | Complete | rule-builder, policy-generator, policy-optimizer, policy-formatter |
| 4 | MITM Proxy | Not started | cert-manager, mitm-proxy |
| 5 | Session + Entry Points | Not started | session-manager, auth, mcp-server, cli |
| 6 | Testing | In progress | 349 unit tests passing (Phase 1-3 coverage, 99%+ lines) |

### Phase 1 Artifacts
- `src/types.ts` — All shared interfaces, enums, config types
- `src/db/schema.ts` — SQLite schema (sessions, pages, violations, policies) with WAL mode
- `src/db/repository.ts` — Type-safe data access layer, parameterized queries, deduplication via UNIQUE constraints
- `src/utils/csp-constants.ts` — CSP directives, deny-all policy builder, directive fallback map
- `src/utils/url-utils.ts` — Origin extraction, localhost detection, MITM mode auto-detection
- `src/utils/logger.ts` — Structured JSON logger to stderr
- `src/index.ts` — Public API exports

### Phase 1 Review Findings (resolved in Phase 2)
- ~~**HIGH:** File permissions for .csp-analyser directory (0o700) and DB file (0o600)~~ — Fixed: `ensureDataDirectory()` and `setSecureFilePermissions()` in `src/utils/file-utils.ts`
- ~~**MEDIUM:** Path traversal guard needed on createDatabase when wired to user input~~ — Fixed: `validateDbPath()` in `src/utils/file-utils.ts`
- ~~**MEDIUM:** Credential data (cookies) stored in plaintext in SQLite config column~~ — Fixed: cookies stripped before DB persistence in `createSession()`

### Phase 2 Artifacts
- `src/report-parser.ts` — Normalizes three CSP report formats (application/csp-report, application/reports+json, DOM SecurityPolicyViolationEvent) to InsertViolationParams with field length validation
- `src/report-server.ts` — Node HTTP server on 127.0.0.1 for CSP report collection (POST /csp-report, POST /reports, GET /health) with 1MB body limit, content-type validation, 405 method enforcement
- `src/csp-injector.ts` — Local-mode CSP header injection via Playwright page.route(); strips existing CSP headers, injects deny-all report-only CSP + Report-To header; error fallback via route.continue()
- `src/violation-listener.ts` — DOM-based violation capture via page.addInitScript() + page.exposeFunction(); compact ~350 byte init script with sample truncation (256 chars)
- `src/crawler.ts` — BFS page discovery with depth/maxPages limits, same-origin filtering, URL normalization; onPageCreated callback (fires before navigation) and onPageLoaded callback; graceful error handling with sanitized error messages
- `src/utils/file-utils.ts` — Path traversal guard (validateDbPath), secure directory creation (0o700), secure file permissions (0o600)

### Phase 2 Review Findings (tracked)
- **LOW:** `__cspViolationReport` callback trusts page-controlled data — cross-validate documentURI against page.url()
- **LOW:** `extractOrigin`/`shouldUseMitmMode` throw on invalid URLs — callers must pre-validate
- **LOW:** Logger JSON.stringify could throw on circular references
- **LOW:** Init script silently swallows all errors — consider console.warn in catch
- **NOTE:** Report-To group name uses 'csp-analyser' (code) vs 'csp-endpoint' (ADR) — cosmetic deviation
- **NOTE:** pageId is always null for report-uri/reporting-api violations — use document_uri matching

### Phase 3 Artifacts
- `src/rule-builder.ts` — Maps violations to CSP source expressions ('self', exact origins, wildcard domains, special keywords) with three strictness levels; sha256 hash generation for inline script/style samples (skips truncated samples)
- `src/policy-generator.ts` — Aggregates violations into directive map (Record<string, string[]>) with deduplication; validates effectiveDirective against known CSP directives; DB-backed and pure function variants
- `src/policy-optimizer.ts` — default-src factoring (intersects sources across fetch directives), source deduplication, deterministic directive/source ordering
- `src/policy-formatter.ts` — 6 export formats (header, meta, nginx, apache, cloudflare, json) with HTML escaping for meta, quote escaping for nginx/apache, report-only variants

### Phase 3 Review Findings (tracked)
- **MEDIUM:** SQL LIKE metacharacters in violation filter origin not escaped — `%` and `_` produce unexpected results
- **MEDIUM:** No source expression format validation (semicolons, spaces, invalid wildcards) before policy inclusion
- **LOW:** Cloudflare format doesn't escape backslashes in JS string
- **LOW:** `deduplicateSources` in optimizer doesn't dedup 'self' vs explicit matching origin
- **NOTE:** Cloudflare format only outputs Workers handler, not Pages `_headers` file
- **NOTE:** Hash of truncated sample won't match browser's hash of full script — hashes only generated for samples <256 chars

## 9. Success Metrics

- Can generate a working CSP for a multi-page authenticated web application in under 5 minutes
- Generated policy allows all legitimate resources and blocks nothing that was intentionally loaded
- MCP tools are discoverable and usable by Claude Code without additional documentation
- Interactive mode captures violations from manual navigation with zero missed resources
