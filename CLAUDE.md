# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

CSP Analyser is a local developer tool that automates Content Security Policy (CSP) header generation. It headlessly browses a target website with a deny-all report-only CSP, captures all violations, and generates a minimal, correct policy ready for production deployment. Exposed as both an MCP server (for AI coding agents) and a standalone CLI.

## Build & Development Commands

```bash
npm run build          # TypeScript compilation (tsc)
npm run typecheck      # Type checking without emitting (tsc --noEmit)
npm run test           # Run all tests (vitest run)
npm run test:watch     # Watch mode (vitest)
npm run test:coverage  # Tests with coverage (vitest run --coverage)
npm run test -- test/report-parser.test.ts  # Run a single test file
npm run lint           # Run ESLint (must have 0 errors)
npm run lint:fix       # Auto-fix ESLint issues
npm run format         # Format with Prettier
npm run format:check   # Check formatting without writing
npm run start          # Start MCP server (node dist/mcp-server.js)
npm run cli            # Run CLI (node dist/cli.js)
```

## Development Workflow

After completing each phase of work:

1. **Type Checking**: Run `npm run typecheck` — must pass with no errors
2. **Tests**: Run `npm run test` — must pass with no errors
3. **Git Commit**: Create a descriptive commit for the phase
4. **Security Review**: Review changes for security implications in a sub agent — what could go wrong? What data could be exposed? Is there duplicate or dead code?
5. **User Testing**: Ask the user to test before proceeding to the next phase

## Architecture

**Single TypeScript + Node.js project** (ESM, `"type": "module"`, target ES2022, NodeNext module resolution).

### Pipeline flow

1. **Session Manager** (`session-manager.ts`) — orchestrates the full pipeline: auth → browser launch → CSP injection → crawling → violation capture → policy generation
2. **Auth** (`auth.ts`) — handles authentication via storage state files, manual login, or raw cookies using Playwright
3. **CSP Injection** (`csp-injector.ts`) — intercepts responses via Playwright route API to strip existing CSP headers and inject deny-all report-only CSP
4. **Violation Capture** — dual capture: DOM event listeners (`violation-listener.ts`) + HTTP report endpoint (`report-server.ts`), parsed by `report-parser.ts`
5. **Inline Hash Extraction** (`inline-content-extractor.ts`) — after each page loads, extracts full inline content (`<script>`, `<style>`, event handlers, `style` attributes) via `page.evaluate()` and computes SHA-256 hashes stored in `inline_hashes` table
5. **Crawler** (`crawler.ts`) — same-origin link discovery up to configurable depth/max pages
6. **Policy Generation** — `rule-builder.ts` (violation → source expressions) → `policy-generator.ts` (aggregate + merge inline hashes) → `policy-optimizer.ts` (collapse to `default-src`) → `policy-formatter.ts` (export as header/meta/nginx/apache/cloudflare/json)
7. **MITM Proxy** (`mitm-proxy.ts`, `cert-manager.ts`) — alternative mode for non-Playwright HTTP interception

### Data layer

- **SQLite** via `better-sqlite3` — schema in `src/db/schema.ts`, repository in `src/db/repository.ts`
- Five entities: `Session`, `Page`, `Violation`, `Policy`, `InlineHash` — row types use `snake_case`, domain types use `camelCase`
- All types defined in `src/types.ts`

### Interfaces

- **MCP Server** (`mcp-server.ts`) — exposes tools via `@modelcontextprotocol/sdk` over stdio transport
- **CLI** (`cli.ts`) — commands: `crawl`, `interactive`, `generate`, `export`

### Utilities (`src/utils/`)

- `csp-constants.ts` — CSP directive definitions, fallback map, deny-all header builder
- `url-utils.ts` — origin extraction, wildcard domain generation, URI normalization
- `logger.ts` — structured logger with configurable levels
- `file-utils.ts` — path validation, secure file permissions

## Conventions

- Don't use `any` or `as` — make all code as type safe as possible
- ESM imports must include `.js` extension (e.g., `import { foo } from './bar.js'`)
- Database row types (`*Row`) are snake_case; domain types are camelCase — conversion happens in the repository layer

## Documentation

- `internal-docs/prd.md` — Product requirements document (internal, not published)
- `internal-docs/adr/` — Architecture decision records (internal, not published)
- `docs/` — VitePress documentation site (published)
