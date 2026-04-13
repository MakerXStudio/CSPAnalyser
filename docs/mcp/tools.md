---
title: MCP Tools Reference
description: Complete reference for all CSP Analyser MCP tools
---

# MCP Tools

CSP Analyser exposes 10 tools through its MCP server. This page documents each tool with its parameters, types, and example usage.

## start_session

Start a new CSP analysis session: crawl a website with a deny-all report-only CSP and capture all violations.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `targetUrl` | `string` (URL) | Yes | -- | The URL to analyse |
| `depth` | `integer` (0-10) | No | 1 | Crawl depth |
| `maxPages` | `integer` (1-1000) | No | 10 | Maximum pages to crawl |
| `settlementDelay` | `integer` (0-10000) | No | 500 | Milliseconds to wait after page load for late violations |
| `storageStatePath` | `string` | No | -- | Path to Playwright storageState JSON for authenticated sessions |
| `strictness` | `"strict" \| "moderate" \| "permissive"` | No | `"moderate"` | Policy strictness level |
| `violationLimit` | `integer` (0+) | No | 10000 | Maximum violations to accept per session (0 for unlimited) |

**Example:**

```json
{
  "targetUrl": "https://example.com",
  "depth": 2,
  "maxPages": 20,
  "strictness": "strict"
}
```

**Response includes:** `sessionId`, `targetUrl`, `pagesVisited`, `violationsFound`, `errors`

---

## crawl_url

Analyse a single page for CSP violations. Convenience wrapper that sets `depth=0` and `maxPages=1`.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `url` | `string` (URL) | Yes | -- | The URL to analyse |
| `storageStatePath` | `string` | No | -- | Path to Playwright storageState JSON |
| `strictness` | `"strict" \| "moderate" \| "permissive"` | No | `"moderate"` | Policy strictness level |

**Example:**

```json
{
  "url": "https://example.com/login"
}
```

**Response includes:** `sessionId`, `targetUrl`, `pagesVisited`, `violationsFound`, `errors`

---

## get_violations

Get CSP violations captured during a session, optionally filtered by directive, page URL, or origin.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` (UUID) | Yes | -- | The session ID |
| `directive` | `string` | No | -- | Filter by CSP directive (e.g., `script-src`) |
| `pageUrl` | `string` | No | -- | Filter by page URL |
| `origin` | `string` | No | -- | Filter by blocked resource origin |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "directive": "script-src"
}
```

**Response includes:** `sessionId`, `count`, and a `violations` array with `id`, `documentUri`, `blockedUri`, `effectiveDirective`, `violatedDirective`, `sourceFile`, `lineNumber`, `sample`, `capturedVia`

---

## generate_policy

Generate an optimised CSP policy from violations captured in a session.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` (UUID) | Yes | -- | The session ID |
| `strictness` | `"strict" \| "moderate" \| "permissive"` | No | `"moderate"` | Policy strictness |
| `includeHashes` | `boolean` | No | `false` | Include SHA-256 hashes for inline scripts/styles (from violation samples and full DOM extraction) |
| `useHashes` | `boolean` | No | `false` | Remove `'unsafe-inline'` from directives that have hash sources (implies `includeHashes`) |
| `stripUnsafeEval` | `boolean` | No | `false` | Remove `'unsafe-eval'` from the generated policy |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "strictness": "strict",
  "useHashes": true
}
```

**Response includes:** `sessionId`, `strictness`, `directives` (map), `policyString`

---

## export_policy

Export a CSP policy in a deployment-ready format.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` (UUID) | Yes | -- | The session ID |
| `format` | `"header" \| "meta" \| "nginx" \| "apache" \| "cloudflare" \| "cloudflare-pages" \| "azure-frontdoor" \| "helmet" \| "json"` | Yes | -- | Output format |
| `strictness` | `"strict" \| "moderate" \| "permissive"` | No | `"moderate"` | Policy strictness |
| `isReportOnly` | `boolean` | No | `false` | Use `Content-Security-Policy-Report-Only` header |
| `useHashes` | `boolean` | No | `false` | Remove `'unsafe-inline'` from directives that have hash sources |
| `stripUnsafeEval` | `boolean` | No | `false` | Remove `'unsafe-eval'` from the generated policy |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "format": "nginx",
  "useHashes": true
}
```

**Response includes:** `sessionId`, `format`, `isReportOnly`, `policy` (formatted string)

---

## score_policy

Score a CSP policy against best practices on a 0-100 scale with A-F grading.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` (UUID) | Yes | -- | The session ID |
| `strictness` | `"strict" \| "moderate" \| "permissive"` | No | `"moderate"` | Policy strictness |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-..."
}
```

**Response includes:** `overall` (score), `grade`, `findings` (array of issues and strengths), `formatted` (human-readable summary)

---

## compare_sessions

Compare two CSP analysis sessions and show policy/violation differences.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionIdA` | `string` (UUID) | Yes | -- | First session ID (baseline) |
| `sessionIdB` | `string` (UUID) | Yes | -- | Second session ID (comparison) |
| `strictness` | `"strict" \| "moderate" \| "permissive"` | No | `"moderate"` | Policy strictness |

**Example:**

```json
{
  "sessionIdA": "a1b2c3d4-...",
  "sessionIdB": "e5f6g7h8-...",
  "strictness": "moderate"
}
```

**Response includes:** Diff of added, removed, and changed directives, plus a `formatted` human-readable summary

---

## get_session

Get details and violation summary for a CSP analysis session.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` (UUID) | Yes | -- | The session ID |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-..."
}
```

**Response includes:** `session` (id, targetUrl, status, mode, createdAt, updatedAt), `pagesVisited`, `pages` (array of url + statusCode), `violationSummary`

---

## list_sessions

List all CSP analysis sessions. Takes no parameters.

**Example:**

```json
{}
```

**Response includes:** `count`, `sessions` (array of id, targetUrl, status, mode, createdAt)

---

## get_permissions_policy

Get Permissions-Policy and Feature-Policy headers captured during a session.

| Parameter | Type | Required | Default | Description |
|-----------|------|:--------:|---------|-------------|
| `sessionId` | `string` (UUID) | Yes | -- | The session ID |
| `directive` | `string` | No | -- | Filter by directive name (e.g., `camera`, `geolocation`) |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "directive": "camera"
}
```

**Response includes:** `sessionId`, `count`, `policies` (array of id, directive, allowlist, headerType, sourceUrl)

## Error handling

All tools return errors in a consistent format:

```json
{
  "content": [{ "type": "text", "text": "Failed to start session: ..." }],
  "isError": true
}
```

Error messages are sanitized to remove internal file paths. Session IDs are validated as UUIDs. Target URLs are validated before crawling.
