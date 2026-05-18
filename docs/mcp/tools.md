---
title: MCP Tools Reference
description: Complete reference for all CSP Analyser MCP tools
---

# MCP Tools

CSP Analyser exposes 12 tools through its MCP server. This page documents each tool with its parameters, types, and example usage.

## start_session

Start a new CSP analysis session: crawl a website with a deny-all report-only CSP and capture all violations.

| Parameter          | Type                | Required | Default | Description                                                     |
| ------------------ | ------------------- | :------: | ------- | --------------------------------------------------------------- |
| `targetUrl`        | `string` (URL)      |   Yes    | --      | The URL to analyse                                              |
| `depth`            | `integer` (0-10)    |    No    | 1       | Crawl depth                                                     |
| `maxPages`         | `integer` (1-1000)  |    No    | 10      | Maximum pages to crawl                                          |
| `settlementDelay`  | `integer` (0-10000) |    No    | 2000    | Milliseconds to wait after page load for late violations        |
| `storageStatePath` | `string`            |    No    | --      | Path to Playwright storageState JSON for authenticated sessions |
| `cookies`          | `CookieParam[]`     |    No    | --      | Cookies to inject before crawling                               |
| `violationLimit`   | `integer` (0+)      |    No    | 10000   | Maximum violations to accept per session (0 for unlimited)      |

**Example:**

```json
{
  "targetUrl": "https://example.com",
  "depth": 2,
  "maxPages": 20
}
```

**Response includes:** `sessionId`, `targetUrl`, `pagesVisited`, `violationsFound`, `errors`

---

## crawl_url

Analyse a single page for CSP violations. Convenience wrapper that sets `depth=0` and `maxPages=1`.

| Parameter          | Type            | Required | Default | Description                          |
| ------------------ | --------------- | :------: | ------- | ------------------------------------ |
| `url`              | `string` (URL)  |   Yes    | --      | The URL to analyse                   |
| `storageStatePath` | `string`        |    No    | --      | Path to Playwright storageState JSON |
| `cookies`          | `CookieParam[]` |    No    | --      | Cookies to inject before crawling    |

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

| Parameter   | Type            | Required | Default | Description                                  |
| ----------- | --------------- | :------: | ------- | -------------------------------------------- |
| `sessionId` | `string` (UUID) |   Yes    | --      | The session ID                               |
| `directive` | `string`        |    No    | --      | Filter by CSP directive (e.g., `script-src`) |
| `pageUrl`   | `string`        |    No    | --      | Filter by page URL                           |
| `origin`    | `string`        |    No    | --      | Filter by blocked resource origin            |

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

| Parameter               | Type                                     | Required | Default      | Description                                                                                                   |
| ----------------------- | ---------------------------------------- | :------: | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `sessionId`             | `string` (UUID)                          |   Yes    | --           | The session ID                                                                                                |
| `strictness`            | `"strict" \| "moderate" \| "permissive"` |    No    | `"moderate"` | Policy strictness                                                                                             |
| `includeHashes`         | `boolean`                                |    No    | `false`      | Include SHA-256 hashes for inline scripts/styles (from violation samples and full DOM extraction)             |
| `useHashes`             | `boolean`                                |    No    | `false`      | Remove `'unsafe-inline'` from directives that have hash sources (implies `includeHashes`)                     |
| `stripUnsafeEval`       | `boolean`                                |    No    | `false`      | Remove `'unsafe-eval'` from the generated policy                                                              |
| `useNonces`             | `boolean`                                |    No    | `false`      | Replace `'unsafe-inline'` in script/style directives with `'nonce-{{CSP_NONCE}}'` placeholders                |
| `useStrictDynamic`      | `boolean`                                |    No    | `false`      | Add `'strict-dynamic'` alongside script nonces; implies nonce mode when `useNonces` is not set                |
| `collapseHashThreshold` | `integer` (0+)                           |    No    | disabled     | Collapse hashes to `'unsafe-inline'` when a directive exceeds this many hashes                                |
| `staticSiteMode`        | `boolean`                                |    No    | `false`      | Target is a static site — skips nonce suggestions and enables hash collapsing recommendations                 |
| `staticProfile`         | `"react-expo"`                           |    No    | --           | Keep script hashes strict while collapsing excessive `style-src-attr` hashes for static React/Expo-style apps |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "strictness": "strict",
  "useHashes": true,
  "useStrictDynamic": true
}
```

**Response includes:** `sessionId`, `strictness`, `directives` (map), `policyString`. May also include:

- `evalSources` — when `'unsafe-eval'` is in the policy, lists the source files and line numbers that triggered it (for identifying which dependencies call `eval()`)
- `hashStability` — warnings when hashes are likely build-specific and impractical to maintain (high count, large content, bundler patterns like webpack/Expo/Next.js)
- `staticSiteAnalysis` — when the site is detected as static, includes confidence level, reasons, and whether nonces are feasible

---

## export_policy

Export a CSP policy in a deployment-ready format.

| Parameter               | Type                                                                                                                         | Required | Default      | Description                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | :------: | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `sessionId`             | `string` (UUID)                                                                                                              |   Yes    | --           | The session ID                                                                                                |
| `format`                | `"header" \| "meta" \| "nginx" \| "apache" \| "cloudflare" \| "cloudflare-pages" \| "azure-frontdoor" \| "helmet" \| "json"` |   Yes    | --           | Output format                                                                                                 |
| `strictness`            | `"strict" \| "moderate" \| "permissive"`                                                                                     |    No    | `"moderate"` | Policy strictness                                                                                             |
| `isReportOnly`          | `boolean`                                                                                                                    |    No    | `false`      | Use `Content-Security-Policy-Report-Only` header                                                              |
| `useHashes`             | `boolean`                                                                                                                    |    No    | `false`      | Remove `'unsafe-inline'` from directives that have hash sources                                               |
| `stripUnsafeEval`       | `boolean`                                                                                                                    |    No    | `false`      | Remove `'unsafe-eval'` from the generated policy                                                              |
| `useNonces`             | `boolean`                                                                                                                    |    No    | `false`      | Replace `'unsafe-inline'` in script/style directives with `'nonce-{{CSP_NONCE}}'` placeholders                |
| `useStrictDynamic`      | `boolean`                                                                                                                    |    No    | `false`      | Add `'strict-dynamic'` alongside script nonces; implies nonce mode when `useNonces` is not set                |
| `collapseHashThreshold` | `integer` (0+)                                                                                                               |    No    | disabled     | Collapse hashes to `'unsafe-inline'` when a directive exceeds this many hashes                                |
| `staticSiteMode`        | `boolean`                                                                                                                    |    No    | `false`      | Target is a static site — skips nonce suggestions                                                             |
| `staticProfile`         | `"react-expo"`                                                                                                               |    No    | --           | Keep script hashes strict while collapsing excessive `style-src-attr` hashes for static React/Expo-style apps |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "format": "nginx",
  "useHashes": true,
  "useNonces": true
}
```

**Response includes:** `sessionId`, `format`, `isReportOnly`, `policy` (formatted string)

---

## hash_static

Generate a CSP by scanning project-local static HTML files without launching a browser. This mirrors the CLI `hash-static` pipeline and can optionally inject the generated policy into each scanned HTML file as a CSP `<meta>` tag.

All `paths` and `mergeJsonPaths` entries must resolve under the MCP server's current working directory; paths outside the project are rejected.

| Parameter               | Type                                                                                                                         | Required | Default  | Description                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | :------: | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `paths`                 | `string[]`                                                                                                                   |   Yes    | --       | Project-local HTML files or directories to scan. Directories are walked recursively for `*.html` files                  |
| `format`                | `"header" \| "meta" \| "nginx" \| "apache" \| "cloudflare" \| "cloudflare-pages" \| "azure-frontdoor" \| "helmet" \| "json"` |    No    | `"meta"` | Output format                                                                                                           |
| `isReportOnly`          | `boolean`                                                                                                                    |    No    | `false`  | Use `Content-Security-Policy-Report-Only` where the selected format supports it                                         |
| `inject`                | `boolean`                                                                                                                    |    No    | `false`  | Write the CSP into scanned HTML files as a `<meta http-equiv="Content-Security-Policy">` tag                            |
| `extraDirectives`       | `Record<string, string[]>`                                                                                                   |    No    | --       | Additional sources for known CSP fetch/navigation directives                                                            |
| `mergeJsonPaths`        | `string[]`                                                                                                                   |    No    | --       | Project-local JSON policy files exported by this tool or the CLI. Accepts `{ directives: ... }` or a bare directive map |
| `policyDirectives`      | `Record<string, string[]>`                                                                                                   |    No    | --       | Document directives appended verbatim, such as `report-uri`, `sandbox`, or `upgrade-insecure-requests`                  |
| `collapseHashThreshold` | `integer` (0+)                                                                                                               |    No    | disabled | Collapse hashes to `'unsafe-inline'` when an eligible directive exceeds this count                                      |
| `staticProfile`         | `"react-expo"`                                                                                                               |    No    | --       | Keep scripts hash-strict while allowing scoped `style-src-attr` fallback for hash-heavy React/Expo exports              |

**Example:**

```json
{
  "paths": ["dist"],
  "inject": true,
  "extraDirectives": {
    "connect-src": ["https://api.example.com"]
  },
  "policyDirectives": {
    "report-uri": ["/csp-report"]
  }
}
```

**Response includes:** `format`, `isReportOnly`, `policy` (formatted string), `directives` (map), `filesScanned`, `counts` (`scriptElemHashes`, `styleElemHashes`, `styleAttrHashes`, `scriptAttrHashes`), and `injected`.

When `inject` is true, `report-uri` and `report-to` are stripped from the injected meta policy because browsers ignore reporting directives delivered via CSP meta tags. They remain present in the returned `directives` and formatted `policy` unless the selected format strips them.

---

## score_policy

Score a CSP policy against best practices on a 0-100 scale with A-F grading.

| Parameter               | Type                                     | Required | Default      | Description                                                                     |
| ----------------------- | ---------------------------------------- | :------: | ------------ | ------------------------------------------------------------------------------- |
| `sessionId`             | `string` (UUID)                          |   Yes    | --           | The session ID                                                                  |
| `strictness`            | `"strict" \| "moderate" \| "permissive"` |    No    | `"moderate"` | Policy strictness                                                               |
| `useHashes`             | `boolean`                                |    No    | `false`      | Score the hash-optimized policy                                                 |
| `stripUnsafeEval`       | `boolean`                                |    No    | `false`      | Score with `'unsafe-eval'` removed                                              |
| `useNonces`             | `boolean`                                |    No    | `false`      | Score the nonce-optimized policy                                                |
| `useStrictDynamic`      | `boolean`                                |    No    | `false`      | Score the strict-dynamic policy; implies nonce mode when `useNonces` is not set |
| `collapseHashThreshold` | `integer` (0+)                           |    No    | disabled     | Collapse hashes before scoring when a directive exceeds this many hashes        |
| `staticSiteMode`        | `boolean`                                |    No    | `false`      | Score with static-site nonce skipping behavior                                  |
| `staticProfile`         | `"react-expo"`                           |    No    | --           | Score with the static React/Expo style-attribute collapse profile               |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "useStrictDynamic": true
}
```

**Response includes:** `overall` (score), `grade`, `findings` (array of issues and strengths), `formatted` (human-readable summary)

---

## compare_sessions

Compare two CSP analysis sessions and show policy/violation differences.

| Parameter     | Type                                     | Required | Default      | Description                                                               |
| ------------- | ---------------------------------------- | :------: | ------------ | ------------------------------------------------------------------------- |
| `sessionIdA`  | `string` (UUID)                          |   Yes    | --           | First session ID (baseline)                                               |
| `sessionIdB`  | `string` (UUID)                          |   Yes    | --           | Second session ID (comparison)                                            |
| `strictness`  | `"strict" \| "moderate" \| "permissive"` |    No    | `"moderate"` | Policy strictness                                                         |
| `allProjects` | `boolean`                                |    No    | `false`      | Allow comparing sessions from any project instead of only the current one |

**Example:**

```json
{
  "sessionIdA": "a1b2c3d4-...",
  "sessionIdB": "e5f6g7h8-...",
  "strictness": "moderate",
  "allProjects": true
}
```

**Response includes:** Diff of added, removed, and changed directives, plus a `formatted` human-readable summary

---

## get_session

Get details and violation summary for a CSP analysis session. By default, only sessions belonging to the current project, plus legacy unscoped sessions, are accessible.

| Parameter     | Type            | Required | Default | Description                                                               |
| ------------- | --------------- | :------: | ------- | ------------------------------------------------------------------------- |
| `sessionId`   | `string` (UUID) |   Yes    | --      | The session ID                                                            |
| `allProjects` | `boolean`       |    No    | `false` | Allow accessing sessions from any project instead of only the current one |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "allProjects": true
}
```

**Response includes:** `session` (id, targetUrl, status, createdAt, updatedAt, project), `pagesVisited`, `pages` (array of url + statusCode), `violationSummary`

---

## list_sessions

List CSP analysis sessions. By default, only sessions for the current project are returned.

| Parameter     | Type      | Required | Default | Description                                                       |
| ------------- | --------- | :------: | ------- | ----------------------------------------------------------------- |
| `allProjects` | `boolean` |    No    | `false` | Return sessions from all projects instead of only the current one |

**Example:**

```json
{
  "allProjects": true
}
```

**Response includes:** `count`, `sessions` (array of id, targetUrl, status, createdAt, project)

---

## get_permissions_policy

Get Permissions-Policy and Feature-Policy headers captured during a session.

| Parameter   | Type            | Required | Default | Description                                              |
| ----------- | --------------- | :------: | ------- | -------------------------------------------------------- |
| `sessionId` | `string` (UUID) |   Yes    | --      | The session ID                                           |
| `directive` | `string`        |    No    | --      | Filter by directive name (e.g., `camera`, `geolocation`) |

**Example:**

```json
{
  "sessionId": "a1b2c3d4-...",
  "directive": "camera"
}
```

**Response includes:** `sessionId`, `count`, `policies` (array of id, directive, allowlist, headerType, sourceUrl)

## CookieParam

Cookie injection is supported by `start_session`, `crawl_url`, and `audit_policy`. Cookie values are used only for the browser context and are not persisted in session configuration.

| Field      | Type                          | Required | Default         | Description                                              |
| ---------- | ----------------------------- | :------: | --------------- | -------------------------------------------------------- |
| `name`     | `string`                      |   Yes    | --              | Cookie name                                              |
| `value`    | `string`                      |   Yes    | --              | Cookie value                                             |
| `domain`   | `string`                      |    No    | Target hostname | Cookie domain                                            |
| `path`     | `string`                      |    No    | `/`             | Cookie path                                              |
| `httpOnly` | `boolean`                     |    No    | --              | Whether the cookie is HTTP-only                          |
| `secure`   | `boolean`                     |    No    | --              | Whether the cookie is restricted to secure requests      |
| `sameSite` | `"Strict" \| "Lax" \| "None"` |    No    | --              | SameSite policy, matching Playwright cookie option names |

## audit_policy

Audit an existing CSP: crawl a website preserving its current CSP, capture violations, and produce a diff plus merged policy. In strict mode, `'unsafe-inline'` is stripped and replaced with hashes.

| Parameter          | Type                                     | Required | Default      | Description                                                                   |
| ------------------ | ---------------------------------------- | :------: | ------------ | ----------------------------------------------------------------------------- |
| `targetUrl`        | `string` (URL)                           |   Yes    | --           | The URL to audit                                                              |
| `depth`            | `integer` (0-10)                         |    No    | 1            | Crawl depth                                                                   |
| `maxPages`         | `integer` (1-1000)                       |    No    | 10           | Maximum pages to crawl                                                        |
| `settlementDelay`  | `integer` (0-10000)                      |    No    | 2000         | Milliseconds to wait after page load for late violations                      |
| `storageStatePath` | `string`                                 |    No    | --           | Path to Playwright storageState JSON for authenticated sessions               |
| `cookies`          | `CookieParam[]`                          |    No    | --           | Cookies to inject before crawling                                             |
| `strictness`       | `"strict" \| "moderate" \| "permissive"` |    No    | `"moderate"` | Policy strictness. Strict mode strips `'unsafe-inline'` and generates hashes. |
| `violationLimit`   | `integer` (0+)                           |    No    | 10000        | Maximum violations to accept per session (0 for unlimited)                    |

**Example:**

```json
{
  "targetUrl": "https://example.com",
  "depth": 2,
  "strictness": "strict"
}
```

**Response includes:** `sessionId`, `pagesVisited`, `violationsFound`, `errors` (array of `{ url, error }` entries for pages that failed to load), `enforced` (existing + merged directives, diff, violation count), `reportOnly` (same structure), `formatted` (human-readable summary). `enforced` and `reportOnly` are `null` when the site has no corresponding CSP header.

---

## Error handling

All tools return errors in a consistent format:

```json
{
  "content": [{ "type": "text", "text": "Failed to start session: ..." }],
  "isError": true
}
```

Error messages are sanitized to remove internal file paths. Session IDs are validated as UUIDs. Target URLs are validated before crawling.
