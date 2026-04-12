---
title: Architecture
description: System architecture and module responsibilities
---

# Architecture

CSP Analyser is a single TypeScript + Node.js application (ESM, target ES2022) that orchestrates a pipeline from website crawling to policy generation.

## Pipeline overview

```
                        ┌─────────────────────┐
                        │    CLI / MCP Server  │
                        │  (cli.ts / mcp-      │
                        │   server.ts)         │
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │   Session Manager    │
                        │ (session-manager.ts) │
                        └──────────┬──────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
   ┌──────────▼──────┐  ┌────────▼─────────┐  ┌───────▼────────┐
   │   Auth           │  │  CSP Injector     │  │  Crawler        │
   │  (auth.ts)       │  │ (csp-injector.ts) │  │ (crawler.ts)    │
   └──────────────────┘  └────────┬─────────┘  └───────┬────────┘
                                  │                     │
                    ┌─────────────┴─────────────┐       │
                    │                           │       │
         ┌──────────▼──────┐  ┌────────────────▼┐      │
         │  Local Mode      │  │  MITM Mode      │      │
         │ (page.route)     │  │ (mitm-proxy.ts) │      │
         └─────────────────┘  └─────────────────┘      │
                                                        │
              ┌─────────────────────────────────────────┘
              │
   ┌──────────▼──────────────────────────────────┐
   │           Violation Capture                  │
   │                                              │
   │  ┌──────────────┐ ┌─────────────┐ ┌────────┐│
   │  │ DOM Listener  │ │ Report-URI  │ │Report- ││
   │  │ (violation-   │ │ (report-    │ │To API  ││
   │  │  listener.ts) │ │  server.ts) │ │        ││
   │  └──────┬───────┘ └──────┬──────┘ └───┬────┘│
   └─────────┼────────────────┼─────────────┼─────┘
             │                │             │
             └────────────────┼─────────────┘
                              │
                   ┌──────────▼──────────┐
                   │   Report Parser     │
                   │  (report-parser.ts) │
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │     SQLite DB       │
                   │  (db/repository.ts) │
                   └──────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
   ┌──────────▼───┐ ┌────────▼──────┐ ┌──────▼─────────┐
   │ Rule Builder  │ │  Policy       │ │  Policy Scorer │
   │(rule-builder) │ │  Generator    │ │ (policy-       │
   │              │ │(policy-gen.ts)│ │  scorer.ts)    │
   └──────────┬───┘ └────────┬──────┘ └────────────────┘
              │               │
              │    ┌──────────▼──────────┐
              │    │  Policy Optimizer   │
              │    │(policy-optimizer.ts)│
              │    └──────────┬──────────┘
              │               │
              │    ┌──────────▼──────────┐
              │    │  Policy Formatter   │
              │    │(policy-formatter.ts)│
              │    └─────────────────────┘
```

## Session lifecycle

A session progresses through these states:

```
created → authenticating → crawling → analyzing → complete
                                                     │
                                                     └→ failed (on error)
```

1. **created**: Session record inserted into SQLite with configuration
2. **authenticating**: Browser context created with storage state, cookies, or manual login
3. **crawling**: Pages discovered and visited; CSP violations captured in real time
4. **analyzing**: Crawl complete; violation data is available for policy generation
5. **complete**: Session finished successfully
6. **failed**: An error occurred during any stage

## Module responsibilities

### Interfaces

| Module | File | Responsibility |
|--------|------|---------------|
| CLI | `cli.ts` | Parses command-line arguments, dispatches to session manager or policy pipeline, formats terminal output |
| MCP Server | `mcp-server.ts` | Exposes 10 tools via the Model Context Protocol over stdio transport |

### Orchestration

| Module | File | Responsibility |
|--------|------|---------------|
| Session Manager | `session-manager.ts` | Orchestrates the full pipeline: creates session, authenticates, launches browser, injects CSP, crawls, captures violations |

### Browser layer

| Module | File | Responsibility |
|--------|------|---------------|
| Auth | `auth.ts` | Creates authenticated browser contexts via storage state, cookie injection, or manual login |
| CSP Injector | `csp-injector.ts` | Intercepts HTTP responses via Playwright's route API to strip existing CSP headers and inject deny-all report-only CSP |
| Crawler | `crawler.ts` | Same-origin link discovery up to configurable depth and max pages |
| MITM Proxy | `mitm-proxy.ts` | HTTPS intercepting proxy for remote sites; strips and replaces CSP headers at the network level |
| Cert Manager | `cert-manager.ts` | Generates and manages CA certificates for the MITM proxy |

### Violation capture

| Module | File | Responsibility |
|--------|------|---------------|
| Violation Listener | `violation-listener.ts` | Injects DOM `securitypolicyviolation` event listeners via `page.addInitScript()` |
| Report Server | `report-server.ts` | HTTP endpoint that receives `report-uri` and Reporting API violation reports |
| Report Parser | `report-parser.ts` | Normalises violation reports from different sources into a consistent format |

### Policy pipeline

| Module | File | Responsibility |
|--------|------|---------------|
| Rule Builder | `rule-builder.ts` | Maps individual violations to CSP source expressions based on strictness level |
| Policy Generator | `policy-generator.ts` | Aggregates source expressions across all violations into a directive map |
| Policy Optimizer | `policy-optimizer.ts` | Collapses directives into `default-src` where possible to minimize policy size |
| Policy Formatter | `policy-formatter.ts` | Formats directive map into deployment-ready output (7 formats) |
| Policy Scorer | `policy-scorer.ts` | Scores policy against best practices (0-100 scale) |
| Policy Diff | `policy-diff.ts` | Compares two sessions and produces a structured diff |

### Data layer

| Module | File | Responsibility |
|--------|------|---------------|
| Schema | `db/schema.ts` | SQLite table definitions and migrations |
| Repository | `db/repository.ts` | CRUD operations; converts between `snake_case` rows and `camelCase` domain types |

### Utilities

| Module | File | Responsibility |
|--------|------|---------------|
| CSP Constants | `utils/csp-constants.ts` | Directive definitions, fallback map, deny-all header builder |
| URL Utils | `utils/url-utils.ts` | Origin extraction, wildcard domain generation, URL validation |
| Logger | `utils/logger.ts` | Structured logger with configurable levels |
| File Utils | `utils/file-utils.ts` | Path validation, secure file permissions |
| Terminal | `utils/terminal.ts` | Coloured output, progress formatting, summary tables |

## Data flow

1. The **Session Manager** creates a session and starts the **Report Server**
2. **Auth** creates a browser context (unauthenticated, storage state, cookies, or manual login)
3. **CSP Injector** or **MITM Proxy** intercepts every response and injects the deny-all CSP header
4. The **Crawler** discovers and visits pages; the **Violation Listener** captures DOM events while the **Report Server** captures HTTP reports
5. All violations are normalised by the **Report Parser** and written to SQLite via the **Repository**
6. On demand, the **Rule Builder** maps violations to source expressions, the **Policy Generator** aggregates them, and the **Policy Optimizer** collapses redundant directives
7. The **Policy Formatter** produces deployment-ready output in the requested format
