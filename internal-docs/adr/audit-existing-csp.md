# Audit Existing CSP with Disposition-Based Violation Filtering

## Status

Accepted (April 2026).

## Context

The tool was originally designed for a single workflow: inject a deny-all CSP, capture all violations, and generate a complete policy from scratch. This works well for greenfield CSP deployment, but teams that already have a CSP in production face a different problem: they need to know what changed, what their current policy is missing, and what can be tightened — without regenerating everything from zero.

Two gaps motivated this feature:

1. **No way to audit an existing CSP.** Running `crawl` on a site with a deployed CSP replaces the real headers with deny-all, so every resource triggers a violation. The output is a full policy, not a diff against what's already deployed. Users had to manually compare the generated policy against their existing one.
2. **No path from `'unsafe-inline'` to hashes.** Many production CSPs use `'unsafe-inline'` as a pragmatic starting point. There was no automated way to strip it and generate the exact hashes needed to replace it.

## Principles

- **Preserve the site's real behaviour** — audit mode must not change what the browser blocks or reports, only add our report endpoints
- **Separate enforced from report-only** — a site may have both header types with different policies; violations from each must feed their own diff
- **Reuse existing infrastructure** — violation capture, inline hash extraction, policy generation, and diff logic already exist; audit mode should compose them, not rewrite them
- **Strict mode should be opinionated** — when a user asks for strict, unconditionally strip `'unsafe-inline'` and provide hashes, even if the existing policy has it

## Requirements, Constraints, and Considerations

- Must capture the site's existing CSP headers (both `Content-Security-Policy` and `Content-Security-Policy-Report-Only`) from HTTP responses before any modification
- Must NOT inject a deny-all CSP — violations should only come from the site's own policy
- Must append `report-uri` and `report-to` directives to the existing CSP so violations report to our local capture server
- Must store captured CSP headers in the database, per page, since different pages may return different CSP headers
- Must split violations by `disposition` field (`enforce` vs `report`) to produce per-header-type diffs
- Must produce both a diff (what changed) and a complete merged policy (ready to deploy) for each header type
- Must support strict mode: unconditionally strip `'unsafe-inline'` and include inline content hashes
- Must work as both a CLI command and an MCP tool
- The existing `crawl`, `interactive`, and all other commands must remain completely unchanged

## Options

### Option A: Flag on existing `crawl` command (`--audit`)

Add a `--audit` flag to the `crawl` command that switches the CSP injection strategy.

- Pros: No new command to learn, reuses all crawl infrastructure
- Cons: The data flow is fundamentally different (preserve headers vs inject deny-all), requiring conditional logic throughout `csp-injector`, `session-manager`, and the output path. The crawl command's options (`--format`, `--nonce`, `--hash`, `--report-only`) don't apply to audit output, creating confusion about which flags are valid in which mode.

### Option B: New `audit` CLI command and `audit_policy` MCP tool

A separate command with its own entry point, using a new `setupCspPassthrough` module instead of `setupCspInjection`.

- Pros: Clean separation — no conditional branches in existing code paths. The audit command has its own option set that makes sense for its output (no `--format`, `--nonce` etc.). Each code path is testable independently.
- Cons: Some structural duplication between `runSession` and `runAuditSession` in the session manager (browser setup, auth, crawl orchestration).

### Option C: Post-hoc comparison against a user-provided CSP

Instead of capturing headers from the site, accept a CSP string as input and compare it against the deny-all-generated policy.

- Pros: Simpler implementation — no new Playwright interception needed
- Cons: Requires the user to extract and provide their current CSP manually. Doesn't capture per-page CSP variations. Doesn't capture violations from the real policy. Loses the "what is my CSP actually blocking right now?" signal.

### Comparison

| Criterion | A: Flag on crawl | B: New command | C: User-provided CSP |
|-----------|-------------------|----------------|----------------------|
| Existing code unchanged | No | Yes | Yes |
| Captures real violations | Yes | Yes | No |
| Per-page CSP variation | Yes | Yes | No |
| Clean option set | No (mixed flags) | Yes | Yes |
| Implementation complexity | Medium (conditionals) | Medium (new files) | Low |
| User experience | Good | Good | Requires manual CSP extraction |

## Decision

**Option B: New `audit` command and `audit_policy` MCP tool.**

The implementation introduces:

- **`csp-passthrough.ts`** — a Playwright route handler that preserves existing CSP headers and appends report endpoints, modelled after `csp-injector.ts` but without stripping headers. Pure `transformResponseHeadersForAudit` function for testability.
- **`utils/csp-parser.ts`** — pure functions to parse CSP header strings into `Record<string, string[]>`, union multiple parsed headers, and merge additions into a base policy respecting the CSP fallback hierarchy.
- **`audit.ts`** — orchestrates the audit result: reads captured headers from DB, filters violations by disposition, generates per-header-type additions using `generatePolicyFromViolations`, merges with existing policy, optimizes, diffs, and formats output.
- **`existing_csp_headers` table** — stores captured CSP headers per session and page, with a `header_type` column (`'enforced'` or `'report-only'`).
- **`stripUnsafeInline` optimizer option** — unconditionally removes `'unsafe-inline'` from script/style directives, used in strict audit mode.
- **`disposition` filter on `getViolations`** — allows filtering violations by `'enforce'` or `'report'` disposition, used to split violations for per-header-type audit results.

The `runAuditSession` function in `session-manager.ts` follows the same structure as `runSession` but calls `setupCspPassthrough` instead of `setupCspInjection`. The structural similarity is intentional — it keeps the two paths independent and avoids mode-switching conditionals in the hot path.

Non-target-origin navigation (OAuth redirects, etc.) is delegated to `handleNonTargetOriginRequest` in `utils/route-redirect-rewriter.ts`, shared with `setupCspInjection`. See [Redirect Chain CSP Injection](./redirect-chain-csp-injection.md) — audit mode relies on the same JS-redirect rewrite to ensure CSP headers are captured on post-OAuth callback pages.

## Consequences

- Sites with an existing CSP can be audited without regenerating from scratch — the output shows exactly what needs to change
- Enforced and report-only headers are handled independently, with violations correctly attributed to the header that triggered them via the `disposition` field
- Strict audit mode provides an automated migration path from `'unsafe-inline'` to hash-based policies
- The `crawl`, `interactive`, and all other commands are completely unaffected — no existing behaviour changes
- The `existing_csp_headers` table is created with `CREATE TABLE IF NOT EXISTS`, so existing databases gain it automatically on next use
- Sites with no CSP headers produce an empty audit result with guidance to use `crawl` instead

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Site delivers CSP via `<meta>` tags instead of HTTP headers | Medium | Medium | The route interception only sees HTTP headers. Meta-tag CSP is not captured. Document this limitation; consider DOM extraction in a future enhancement. |
| Browser collapses multiple CSP headers before reporting violations | Low | Low | The `disposition` field comes from the violation report itself, which the browser sets based on which header triggered it. Tested against Chromium's reporting behaviour. |
| Pages return different CSP headers; union may be overly permissive | Medium | Low | The union approach is conservative — it shows the broadest existing policy. Per-page audit results could be a future enhancement. |
| `report-uri` appending interacts badly with CSP3 `report-to` preference | Low | Low | We replace both `report-uri` and `report-to` with our endpoints. Browsers that prefer `report-to` will use ours; older browsers fall back to `report-uri`. |
| Inline hash extraction captures hashes for content that isn't blocked | Low | Low | Extra hashes in the policy are harmless — they allow content that would already be allowed. The optimizer deduplicates. |
