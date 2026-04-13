# Technology Stack Selection

## Status

Accepted. Amended April 2026 (commit `ee4fbdb`) — the `http-mitm-proxy` dependency was removed when MITM mode was retired in favour of Playwright-only CSP injection. See [Single-Mode CSP Injection](single-mode-csp-injection.md). The rest of the stack selection still stands.

## Context

CSP Analyser is a local developer tool that headlessly browses websites, captures Content Security Policy violations, and generates production-ready CSP headers. It runs entirely on the developer's machine and must be invokable both as a CLI tool and as an MCP server for AI coding agents (Claude Code, Codex, Gemini, Copilot).

The tool requires:

- A headless browser with low-level access to CSP violation events and response interception
- A database for storing violations, sessions, and generated policies with fast, reliable writes under rapid event bursts
- A reliable mechanism to strip and replace CSP response headers on both local and remote HTTPS sites (originally framed as an HTTPS intercepting proxy; now satisfied by Playwright `page.route()`)
- A standard protocol for exposing tools to AI coding agents
- A language with strong typing for the violation-to-policy transformation pipeline

## Principles

- **Local-first**: No cloud dependencies; all data stays on the developer's machine
- **Zero-config where possible**: Minimise setup steps for both CLI and MCP usage
- **Reliability over throughput**: CSP violations fire rapidly during page load; losing data is worse than being slightly slower
- **Standard protocols**: Use established agent integration protocols rather than custom APIs

## Requirements, Constraints, and Considerations

- Must run on Node.js (standard developer machine runtime)
- Must provide Chrome DevTools Protocol (CDP) access for capturing `SecurityPolicyViolation` events at the DOM level
- Must support `storageState()` or equivalent for authentication handoff between agent and tool
- Must intercept HTTP/HTTPS responses to inject CSP headers (both locally and via proxy)
- Must handle rapid concurrent violation event writes without data loss
- Must be installable as a single `npm install` with no external service dependencies
- Must expose tools via a protocol supported by multiple AI coding agents

## Options

### Playwright + better-sqlite3 + MCP SDK

- Playwright provides `page.route()` with `route.fetch()` + `route.fulfill()` for full response interception (no proxy required), `page.exposeFunction()` for bridging DOM events to Node.js, and `context.storageState()` for clean auth handoff
- better-sqlite3 uses synchronous writes, meaning violation events are persisted immediately without async queue management; under rapid fire (dozens of violations in milliseconds during page load), no events are lost to unresolved promises
- `@modelcontextprotocol/sdk` implements the Model Context Protocol, the standard agent tool protocol supported by Claude Code, Codex, Gemini, and Copilot
- TypeScript with strict mode provides full type safety across the violation-to-directive transformation pipeline

**Note:** The original decision included `http-mitm-proxy` for a secondary injection path. That dependency was removed in April 2026 once we confirmed Playwright's response interception worked reliably against remote HTTPS sites that send existing CSP headers. See [Single-Mode CSP Injection](single-mode-csp-injection.md).

### Puppeteer + LevelDB + custom proxy + REST API

- Puppeteer provides CDP access but only supports Chromium (no Firefox or WebKit testing)
- LevelDB is a key-value store; querying violations by directive, by page, or by origin requires manual indexing and denormalisation
- A custom HTTPS proxy requires implementing TLS interception, certificate generation, and connection management from scratch
- A REST API requires each AI coding agent to implement a custom HTTP client; there is no standard discovery mechanism

### Comparison

| Criterion | Playwright stack | Puppeteer stack |
|-----------|-----------------|-----------------|
| CDP access | Full, all browsers | Full, Chromium only |
| Auth handoff | Built-in `storageState()` | Manual cookie management |
| Response interception | `page.route()` built-in | Requires CDP `Fetch.enable` |
| DB write reliability | Synchronous (no lost events) | Async (requires queue) |
| Violation querying | SQL (GROUP BY, JOIN, aggregation) | Manual K-V indexing |
| HTTPS interception | Built-in via Playwright `page.route()` | Custom implementation |
| Agent integration | Standard MCP protocol, multi-agent | Custom per-agent REST clients |
| Cross-browser | Chromium, Firefox, WebKit | Chromium only |
| Install complexity | `npm install` (prebuild binaries) | `npm install` + manual LevelDB setup |

## Decision

Use **Playwright + better-sqlite3 + @modelcontextprotocol/sdk + TypeScript**.

(Originally included `http-mitm-proxy`; removed April 2026 — see Status note above.)

This stack was chosen because:

1. **Playwright's `storageState()`** provides the cleanest auth handoff pattern — an agent authenticates in a headed browser, exports state to JSON, and the tool loads it headlessly. No alternative offers this as a single API call.
2. **Synchronous SQLite writes** eliminate the class of bugs where rapid violation events are lost to async write queues. During a typical page load, 20-50 violations fire within 100ms; better-sqlite3 handles this without batching or queue management.
3. **MCP is the emerging standard** for AI agent tool integration. A single MCP server implementation makes the tool usable by Claude Code, Codex, Gemini, and Copilot without per-agent adapters.
4. **Single-path CSP injection** is enabled end-to-end by Playwright's `page.route()` with `route.fetch()` + `route.fulfill()`, which strips the origin's CSP headers and rewrites them with our deny-all policy before the browser parses the response. This works uniformly for local and remote HTTPS targets and removed the need for a separate MITM proxy dependency.

## Consequences

- Native compilation is required for better-sqlite3, but prebuild binaries cover Linux, macOS, and Windows on x64 and ARM64
- Playwright downloads browser binaries (~400MB for Chromium); first install is slower but subsequent runs are instant
- The MCP SDK is relatively new; breaking changes in the protocol could require updates
- TypeScript strict mode increases initial development time but prevents type-related bugs in the violation-to-directive mapping logic

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| better-sqlite3 native compilation fails on exotic platforms | Low | High | Prebuild binaries cover all major platforms; fallback to `sql.js` (WASM-based) if needed |
| Playwright `page.route()` misses a header rewrite on an unusual response path (HTTP/2 server push, early hints) | Low | Medium | Covered by automated interactive/crawler tests against remote CSP-hardened sites; if a regression surfaces we can reintroduce a targeted proxy rather than restore the full dual-mode architecture |
| MCP protocol breaking changes | Low | Medium | Pin SDK version; MCP is backed by Anthropic with broad industry adoption |
