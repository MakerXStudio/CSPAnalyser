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
- Cloudflare Workers handler format
- Cloudflare Pages `_headers` file format
- Structured JSON for programmatic consumption

### F10: MCP Server Interface

Expose all functionality as MCP tools for AI coding agent consumption.

**Acceptance criteria:**
- Register tools: `start_session`, `crawl_url`, `get_violations`, `generate_policy`, `export_policy`, `get_session`, `list_sessions`, `compare_sessions`, `score_policy`, `get_permissions_policy`
- `start_session` consolidates authentication (via `storageStatePath` param) and multi-page crawling into a single tool
- `crawl_url` is a convenience wrapper for single-page analysis (depth=0, maxPages=1)
- `compare_sessions` compares two session policies showing added/removed/changed directives and violation diffs
- `score_policy` evaluates a session's CSP against best practices with a letter grade (A–F) and findings
- `get_permissions_policy` retrieves Permissions-Policy analysis for a session
- Each tool has a typed JSON Schema input definition (using Zod schemas)
- Tools return structured JSON responses suitable for agent consumption
- Configurable in Claude Code, Codex, and other MCP-compatible agents

### F11: CLI Interface

Provide a standalone command-line interface with two modes.

**Acceptance criteria:**
- `csp-analyser crawl <url>` — headless auto-crawl mode with flags for depth, max pages, strictness, output format
- `csp-analyser interactive <url>` — headed manual browsing mode with live terminal output
- `csp-analyser generate <session-id>` — regenerate policy from existing session data
- `csp-analyser export <session-id> --format <format>` — export policy in specified format
- `csp-analyser diff <id-a> <id-b>` — compare two session policies showing added/removed/changed directives
- `csp-analyser score <session-id>` — evaluate CSP quality with a letter grade (A–F) and findings
- `csp-analyser permissions <session-id>` — display Permissions-Policy analysis
- Colored terminal output with ANSI codes (respects NO_COLOR env var and --no-color flag)
- Progress indicators during crawling: page count, URL, elapsed time
- Summary table after completion: pages crawled, violations found, unique directives, top 5 violated directives
- Clear help text and error messages

### F12: Permissions-Policy Analysis

Parse and analyze Permissions-Policy and legacy Feature-Policy response headers captured during crawling.

**Acceptance criteria:**
- Parse both modern `Permissions-Policy` and legacy `Feature-Policy` header formats
- Store parsed policies per page in a `permissions_policies` database table
- Identify known W3C Permissions-Policy directives and flag unknown ones
- Expose via MCP tool (`get_permissions_policy`) and CLI command (`permissions`)
- Report which features are allowed/denied and for which origins

### F13: Session Comparison/Diff

Compare two analysis sessions to show how a site's CSP posture has changed over time.

**Acceptance criteria:**
- Compare generated policies: added/removed/changed directives with per-directive source diffs
- Compare violations: new, resolved, and unchanged violations between sessions
- Expose via MCP tool (`compare_sessions`) and CLI command (`diff <id-a> <id-b>`)
- Human-readable formatted diff output for CLI

### F14: CSP Scoring and Evaluation

Score a generated CSP policy against security best practices with a letter grade.

**Acceptance criteria:**
- Score starts at 100 points, deducted for security weaknesses (e.g., `'unsafe-inline'`, `'unsafe-eval'`, missing `object-src`, wildcard sources)
- Grade mapping: A (90+), B (75+), C (55+), D (35+), F (<35)
- Findings categorized by severity: critical, warning, info, positive
- Expose via MCP tool (`score_policy`) and CLI command (`score <session-id>`)

### F15: Enhanced CLI Output

Provide rich terminal output with colors, progress indicators, and summary tables.

**Acceptance criteria:**
- ANSI color-coded output: green (success), yellow (warnings), red (errors), cyan (info)
- Respect `NO_COLOR` env var (https://no-color.org/) and `--no-color` CLI flag
- Progress indicators during crawling: `Crawling [3/10] <url>`
- Summary table after completion: pages crawled, violations found, unique directives, elapsed time, top 5 violated directives
- `src/utils/terminal.ts` utility module with zero external dependencies

## 5. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Runs entirely locally | No cloud dependencies, no data leaves the machine |
| Portable data | Single SQLite file, can be shared or committed |
| Session isolation | Multiple concurrent analysis sessions don't interfere |
| Idempotent crawling | Re-crawling a URL in a session updates rather than duplicates |
| Fast startup | MCP server starts in under 2 seconds |
| TypeScript strict mode | Full type safety across the codebase |
| Code quality | ESLint + Prettier enforced across all source files |

## 6. Out of Scope (Initial Release)

- ~~Permissions-Policy analysis~~ — Implemented in Phase 9a (see F12)
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
| Linting | ESLint | latest |
| Formatting | Prettier | latest |
| Language | TypeScript | strict mode |
| Runtime | Node.js | 24.x |

## 8. Implementation Status

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| 0 | PRD + ADRs | Complete | PRD, 3 ADRs committed |
| 1 | Foundation | Complete | package.json, tsconfig, types.ts, DB schema/repository, utils, index.ts |
| 2 | Violation Capture Pipeline | Complete | report-server, report-parser, csp-injector, violation-listener, crawler |
| 3 | Policy Generation | Complete | rule-builder, policy-generator, policy-optimizer, policy-formatter |
| 4 | MITM Proxy | Complete | cert-manager, mitm-proxy |
| 5 | Session + Entry Points | Complete | session-manager, auth, mcp-server, cli |
| 6 | Testing | Complete | 473 unit tests passing (95%+ statement/line coverage) |
| 7 | Hardening & Review | Complete | Security audit, architecture review, bug fixes, test improvements. 627 tests (97% line coverage) |
| 8 | DX & Robustness | Complete | ESLint/Prettier, Cloudflare Pages export, symlink path validation, rate limiting, TOCTOU fix, npm publish readiness, defensive JSON.parse |
| 9 | Advanced Features | Complete | Permissions-Policy analysis, session diff, CSP scoring, enhanced CLI output. 781 tests across 28 test files |

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

### Phase 3 Review Findings (resolved in Phase 7)
- ~~**MEDIUM:** SQL LIKE metacharacters in violation filter origin not escaped~~ — Fixed: `escapeLikePattern()` in `repository.ts`
- ~~**MEDIUM:** No source expression format validation before policy inclusion~~ — Fixed: `isValidSourceExpression()` in `rule-builder.ts`
- ~~**LOW:** Cloudflare format doesn't escape backslashes in JS string~~ — Fixed in `policy-formatter.ts`
- ~~**LOW:** `deduplicateSources` in optimizer doesn't dedup 'self' vs explicit matching origin~~ — Fixed in `policy-optimizer.ts`
- ~~**NOTE:** Cloudflare format only outputs Workers handler, not Pages `_headers` file~~ — Fixed in Phase 8b: added `cloudflare-pages` export format
- **NOTE:** Hash of truncated sample won't match browser's hash of full script — hashes only generated for samples <256 chars

### Phase 4 Artifacts
- `src/cert-manager.ts` — Manages CA certificate directory for MITM proxy; creates certs dir with 0o700, secures CA key files with 0o600 after generation
- `src/mitm-proxy.ts` — Wraps http-mitm-proxy; strips existing CSP headers and injects deny-all CSP on HTTPS responses; binds to 127.0.0.1 only; uses same buildDenyAllCSP() as local mode

### Phase 5 Artifacts
- `src/session-manager.ts` — Central orchestrator: creates session → launches browser → report server → MITM proxy (if needed) → auth → crawl → cleanup; auto-detects local vs MITM mode; guaranteed cleanup in finally block
- `src/auth.ts` — Three auth patterns: storageState file (validated for path traversal), cookie injection (mapped to Playwright format), manual login (headed browser with storageState export); lightweight Playwright interfaces for testing
- `src/mcp-server.ts` — MCP server with 7 tools: start_session, crawl_url, get_violations, generate_policy, export_policy, get_session, list_sessions; Zod-validated inputs; StdioServerTransport
- `src/cli.ts` — CLI with 4 commands: crawl, interactive, generate, export; Node util.parseArgs; policy to stdout, progress to stderr; import.meta.url execution guard

### Phase 4+5 Review Findings (resolved in Phase 7)
- ~~**LOW:** Cookie name/value not sanitized against RFC 6265~~ — Fixed: `validateCookieParam()` in `auth.ts`
- ~~**LOW:** `performManualLogin` doesn't verify headed mode~~ — Fixed: headed mode check in `auth.ts`
- ~~**LOW:** MCP error responses may expose internal paths~~ — Fixed: `sanitizeErrorMessage()` in `mcp-server.ts`
- ~~**LOW:** Sessions that error stay in 'crawling'/'analyzing' status~~ — Fixed: `'failed'` added to `SessionStatus`

### Phase 7 — Hardening & Review

Phase 7 is a comprehensive hardening pass encompassing a CISO-level security audit, architecture review, bug fixes, and test coverage improvements.

#### Phase 7a: Security Audit Findings

Full CISO-level audit covering secrets archaeology, input validation, session handling, dependency supply chain, OWASP Top 10, STRIDE threat model, network exposure, and CSP-specific attack vectors.

**HIGH severity:**
- **H1:** Target URL accepts any scheme (file://, javascript://, internal IPs) — SSRF and local file read risk. CLI performs no validation; MCP server only checks `z.string().url()`. **Fix:** Add URL scheme validation to reject non-HTTP(S) URLs (task #9)
- **H2:** Sessions that encounter errors remain in 'crawling'/'analyzing' status — no 'failed' status type exists. **Fix:** Tracked in task #3

**MEDIUM severity:**
- **M1:** StorageState file path validated but symlink traversal not fully covered
- **M2:** Hash source expressions generated from truncated samples won't match browser hashes — validation gap
- **M3:** SQL LIKE metacharacters (`%`, `_`) in violation filter origin not escaped — unexpected query results. **Fix:** In progress (task #2)
- **M4:** Report server on localhost has no authentication — any local process can inject fake violation reports and poison the generated policy. **Fix:** Add per-session auth token to report-uri (task #10)
- **M5:** CA key file creation has a TOCTOU race between file creation and permission setting

**LOW severity:**
- **L1:** SQL SET concatenation patterns in repository
- **L2:** No rate limiting on report server endpoints
- **L3:** rawReport field stores untrusted page-controlled data
- **L4:** Cloudflare export format doesn't escape backslashes in JS string
- **L5:** Path traversal check could be stronger (symlink resolution)
- **L6:** CLI performs no URL validation before passing to session manager

**INFO (positive findings):**
- No hardcoded secrets found in source or git history
- Dependencies are healthy and well-maintained
- SQL injection properly mitigated via parameterized queries throughout
- All network servers bind to 127.0.0.1 only
- CSP-specific attack vectors (malicious target sites manipulating reports) documented
- STRIDE threat model completed for all components
- OWASP Top 10 mapped to codebase

#### Phase 7b: Architecture Review Findings

Full architecture review covering pipeline correctness, error handling, type safety, concurrency, module boundaries, API surface, and database schema.

**P0 — Correctness bugs:**
- **P0-1:** Permissive strictness is paradoxically MORE restrictive than moderate for multi-label hostnames. In `rule-builder.ts`, moderate generates `*.example.com` for `cdn.example.com`, but permissive generates `*.cdn.example.com` (narrower). **Fix:** task #11
- **P0-2:** DOM violations always have `pageId: null` — no page association possible. `setupViolationListener()` is called with `null` pageId before the page record exists, and the closure is never updated. Makes per-page analysis impossible. **Fix:** task #12
- **P0-3:** Interactive CLI command doesn't actually allow interactive browsing. It sets `headless: false` but still uses the crawler for navigation (depth:0, maxPages:1). User cannot browse freely. **Fix:** task #13

**P1 — Reliability issues:**
- **P1-1:** TypeScript compilation error — PlaywrightPage/PlaywrightRoute/PlaywrightResponse lightweight interfaces incompatible with actual Playwright types at `session-manager.ts:153`. **Fix:** Completed (task #1)
- **P1-2:** Race condition — violations lost when pages close too quickly. Late-arriving violations from lazy-loaded resources or deferred scripts may fire after navigation completes but before the exposed function processes them. **Fix:** task #14
- **P1-3:** MITM proxy listen errors cause promise hang (neither resolves nor rejects). MCP server leaks DB connection if `server.connect()` throws. **Fix:** task #15

**Positive findings:**
- Pipeline data flow verified correct across all handoff points
- Session manager has guaranteed cleanup in `finally` block (browsers, servers, proxies)
- SQLite WAL mode sufficient for local single-user concurrency
- Multiple concurrent sessions supported via session-based isolation
- Responsibilities cleanly separated across modules with no circular dependencies
- MCP server exposes 7 tools with Zod-validated schemas
- CLI provides 4 commands with consistent argument patterns

**Housekeeping:**
- `src/analyser/`, `src/browser/`, `src/collector/`, `src/proxy/`, `src/session/` contain only `.gitkeep` files — remnants of initial planned directory structure superseded by flat module layout. Candidates for removal.

#### Phase 7c: Bug Fixes & Improvements (Complete)

| Task | Priority | Description | Status |
|------|----------|-------------|--------|
| #1 | P1 | Fix TypeScript compilation error — PlaywrightPage interface incompatible with real Playwright types | Complete |
| #2 | MEDIUM | Fix SQL LIKE injection and source expression validation | Complete |
| #3 | LOW | Fix LOW findings — RFC 6265 cookies, headed mode check, error paths, Cloudflare escaping, dedup | Complete |
| #4 | — | Increase MCP server test coverage from 69% to 92%+ | Complete |
| #5 | — | Add edge case tests — malformed URLs, concurrent access, large violation counts, unicode (+64 tests) | Complete |
| #9 | HIGH | Add URL scheme validation to reject non-HTTP(S) target URLs (H1) | Complete |
| #10 | MEDIUM | Add per-session auth token to report server URLs (M4) | Complete |
| #11 | P0 | Fix permissive strictness being more restrictive than moderate for multi-label hostnames | Complete |
| #12 | P0 | Fix DOM violations always having pageId: null — no page association | Complete |
| #13 | P0 | Fix interactive CLI command to actually allow interactive browsing | Complete |
| #14 | P1 | Fix race condition — violations lost when pages close too quickly (500ms settlement delay) | Complete |
| #15 | P1 | Fix MITM proxy promise hang on error + MCP DB connection leak | Complete |
| #16 | P2 | Remove empty placeholder directories and unused repository interfaces | Complete |

#### Phase 7 Resolved Items

All P0, P1, HIGH, and MEDIUM findings from the security audit and architecture review have been fixed (tasks #1–#16). Key fixes:
- 3 P0 correctness bugs: strictness ordering, pageId association, interactive mode
- 2 P1 reliability fixes: violation settlement delay, proxy error handling + DB leak
- 2 HIGH security fixes: URL scheme validation (SSRF), TypeScript compilation
- 3 MEDIUM security fixes: SQL LIKE escaping, source expression validation, report server auth tokens
- 6 LOW security fixes: cookie validation, headed mode check, error sanitization, failed status, Cloudflare escaping, self dedup
- Code quality: empty directories removed, unused interfaces removed, +154 tests

#### Recommendations from Phase 7 (all resolved in Phase 8)

1. ~~**Linter & formatter**~~ — Resolved: ESLint + Prettier configured (Phase 8a)
2. ~~**Cloudflare Pages `_headers` format**~~ — Resolved: `cloudflare-pages` export format added (Phase 8b)
3. ~~**Symlink-aware path validation**~~ — Resolved: realpath-based validation (Phase 8c)
4. ~~**Report server rate limiting**~~ — Resolved: per-session violation limit (10,000 default, configurable) with 429 responses (Phase 8d)
5. ~~**StorageState symlink traversal**~~ — Resolved: covered by symlink-aware path validation (Phase 8c)
6. ~~**CA key TOCTOU race**~~ — Resolved: umask-based atomic secure file creation (Phase 8e)

### Phase 8 — DX & Robustness

Phase 8 addresses all recommendations from Phase 7, adds code quality tooling, and prepares the package for publication.

#### Phase 8a: ESLint + Prettier Configuration
- ESLint with TypeScript-aware rules enforcing strict type safety
- Prettier for consistent code formatting
- `npm run lint` and `npm run format` scripts added
- All existing source code passes lint and format checks

#### Phase 8b: Cloudflare Pages `_headers` Export Format
- `src/policy-formatter.ts` extended with `cloudflare-pages` format
- Outputs `_headers` file syntax: path rule with `Content-Security-Policy` header
- `ExportFormat` union type updated in `src/types.ts`

#### Phase 8c: Symlink-Aware Path Validation
- Path traversal guards strengthened with `fs.realpathSync` resolution
- Prevents symlink-based escapes from data directories
- Applied to storage state paths and database paths

#### Phase 8d: Report Server Rate Limiting
- Per-session violation counter with configurable limit (default: 10,000)
- Returns 429 Too Many Requests when limit is reached
- Warning logged once when limit is first hit
- `ReportServerOptions` interface with `violationLimit` option
- `violationLimit: 0` disables the limit

#### Phase 8e: CA Key TOCTOU Fix
- File permissions race between CA key creation and `chmod` resolved
- Uses umask-based approach for atomic secure file creation

#### Phase 8f: npm Publish Readiness
- `package.json` updated with required metadata: description, keywords, repository, license, author, homepage, bugs
- `files` field configured to include only distribution artifacts
- `bin` field configured for CLI entry point

#### Phase 8g: Defensive JSON.parse in Repository Layer
- All `JSON.parse` calls in repository row mappers wrapped with error handling
- Prevents crashes from corrupted JSON in database rows

### Phase 9 — Advanced Features

Phase 9 adds analytical features that enhance the tool's value beyond basic CSP generation.

#### Phase 9a: Permissions-Policy Analysis
- `src/permissions-policy.ts` — Parses modern `Permissions-Policy` and legacy `Feature-Policy` headers
- Comprehensive set of known W3C Permissions-Policy directives
- `permissions_policies` database table for per-page storage
- MCP tool: `get_permissions_policy`
- CLI command: `csp-analyser permissions <session-id>`

#### Phase 9b: Session Comparison/Diff
- `src/policy-diff.ts` — Compares two sessions' generated policies and violations
- Policy diff: added/removed/changed directives with per-source granularity
- Violation diff: new, resolved, and unchanged violations
- MCP tool: `compare_sessions`
- CLI command: `csp-analyser diff <id-a> <id-b>`

#### Phase 9c: CSP Scoring and Evaluation
- `src/policy-scorer.ts` — Scores CSP policies against security best practices
- 100-point scale with grade mapping: A (90+), B (75+), C (55+), D (35+), F (<35)
- Findings categorized: critical, warning, info, positive
- Checks for `'unsafe-inline'`, `'unsafe-eval'`, missing `object-src`, wildcard sources, and more
- MCP tool: `score_policy`
- CLI command: `csp-analyser score <session-id>`

#### Phase 9d: Enhanced CLI Output
- `src/utils/terminal.ts` — ANSI color utilities with zero external dependencies
- Color functions: `green()`, `yellow()`, `red()`, `cyan()`, `bold()`, `dim()`
- Respects `NO_COLOR` env var (https://no-color.org/) and `--no-color` CLI flag
- Progress indicators during crawling: `Crawling [3/10] <url>`
- Summary table after completion: pages crawled, violations found, unique directives, elapsed time, top 5 violated directives

#### Phase 8+9 Security Audit Results
- CISO-level review of all Phase 8+9 changes completed
- No new HIGH or MEDIUM findings introduced
- All Phase 7 recommendations fully addressed

#### Phase 8+9 Architecture Review Results
- Full architecture review of Phase 8+9 implementation completed
- Pipeline correctness verified across all new features
- Module boundaries and type safety maintained
- No circular dependencies introduced

## 9. Success Metrics

- Can generate a working CSP for a multi-page authenticated web application in under 5 minutes
- Generated policy allows all legitimate resources and blocks nothing that was intentionally loaded
- MCP tools are discoverable and usable by Claude Code without additional documentation
- Interactive mode captures violations from manual navigation with zero missed resources
