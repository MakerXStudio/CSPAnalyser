# Redirect Chain CSP Injection — Playwright Route Handler Workaround

## Status

Accepted

## Context

CSP Analyser has two route-handler modes that intercept requests via Playwright's `page.route('**/*')` API:

- **Injection mode** (`setupCspInjection` in `csp-injector.ts`) — used by `start_session` / `crawl_url`. Strips any existing CSP and injects a deny-all `Content-Security-Policy-Report-Only` header onto every response from the target origin.
- **Audit mode** (`setupCspPassthrough` in `csp-passthrough.ts`) — used by `audit_policy`. Preserves the site's existing CSP headers, appends our report endpoints, and captures the original directives for later diffing.

Both modes share the same underlying limitation.

### The Playwright Limitation

Playwright's `page.route()` does **not** re-intercept requests that result from HTTP 3xx redirects. When the handler calls `route.continue()` or `route.fulfill()` with a redirect response, the browser follows the redirect internally — subsequent requests in the chain bypass the route handler entirely.

This is a problem for OAuth/OIDC auth flows where an external identity provider (IdP) redirects back to the application's callback URL via HTTP 302:

```
App → IdP login page → IdP processes auth → 302 to app/callback
```

The request to the IdP is intercepted (non-target origin → `route.continue()`). The 302 redirect to `app/callback` is **not** intercepted. The callback page loads without the injected CSP (or without CSP capture, in audit mode), so no violations fire for any `fetch()`, image, or script loads on the post-auth page.

## Decision

### Shared helper: `route-redirect-rewriter.ts`

The non-target-origin navigation logic lives in `src/utils/route-redirect-rewriter.ts` as `handleNonTargetOriginRequest(route, targetOrigin)`. Both `setupCspInjection` and `setupCspPassthrough` delegate to it when they see a request on an origin other than the target. This keeps the two route-handler modes in sync — the audit-mode equivalent previously used a plain `route.continue()` for non-target origins, which silently dropped CSP capture on post-redirect pages.

### Core mechanism: rewrite 3xx redirects as JS navigations

For non-target-origin **document** navigation requests, the helper fetches the response with `maxRedirects: 0` to inspect the raw 3xx response. If the response is a redirect, it replaces the HTTP redirect with a synthetic HTML page containing `window.location.href = "<target-url>"`. The browser renders this page (processing any `Set-Cookie` headers from the original response) and then performs a fresh top-level navigation to the target URL. This new navigation re-enters the route handler, where CSP can be injected or captured normally.

### Multi-hop chains

Each redirect hop is handled individually. When the first hop redirects to another non-target origin (e.g., `auth → intermediate → app`), the handler rewrites that hop as a JS redirect too. The browser navigates to the intermediate URL, which re-enters the route handler, and the process repeats. This means the browser's full cookie jar and auth state are available at every hop — no need to follow the chain from Node.js.

### Header forwarding

All original response headers from the 3xx response are forwarded to the browser, with three exceptions:

1. **Redirect framing headers** (`Location`, `Content-Length`, `Content-Encoding`, `Transfer-Encoding`) are stripped because the synthetic page replaces the original body.
2. **CSP headers** (`Content-Security-Policy`, `Content-Security-Policy-Report-Only`, `Report-To`) are stripped because the synthetic page contains an inline `<script>` that a strict CSP would block, stalling the redirect.
3. `Set-Cookie` headers are preserved — this is critical for auth flows where the IdP sets session cookies on the redirect response.

### Status code handling

| Status | Behavior | Rationale |
|--------|----------|-----------|
| 301, 302, 303 | Always rewrite to JS redirect | These status codes convert the follow-up request to GET per the HTTP spec, which matches `window.location.href` semantics exactly. |
| 307, 308 to **target** origin | Rewrite to JS redirect | Converts POST→GET, dropping the request body. See tradeoff below. |
| 307, 308 to **non-target** origin | Pass through | Preserves method and body for intermediate auth hops (e.g., IdP internal processing). |
| Non-redirect (200, 4xx, etc.) | Fulfill with the already-fetched response | No redirect to rewrite. Response is passed through without re-fetching. |

### 307/308 tradeoff

Rewriting 307/308 redirects to the target origin changes the request method from POST to GET and drops the body. This is an accepted tradeoff because:

1. **No alternative exists** within Playwright's constraints — we cannot both preserve POST semantics and inject CSP headers.
2. **307/308 on the auth return leg is essentially non-existent in practice** — OAuth 2.0 (RFC 6749 §4.1.2) and OIDC specify 302 for authorization responses. Azure AD B2C, Okta, Auth0, and Google all use 302.
3. **SPA callback endpoints typically accept GET** — the authorization code is in the URL query string regardless of method.
4. **The alternative (passing through) silently produces zero CSP violations** on the post-redirect page, which defeats the tool's purpose.

### Violation listener target

The DOM violation event listener uses `window.addEventListener('securitypolicyviolation', ...)` instead of `document.addEventListener(...)`. The CSP Level 3 spec fires the event at the "violation's global object" — for `connect-src` violations from `fetch()`, this is `window`. After cross-origin navigations, Chromium may only dispatch `connect-src` events on `window`.

## Consequences

### Positive

- CSP violations are captured reliably after OAuth/OIDC redirect chains (the primary use case) — in both injection and audit modes
- Audit mode captures the deployed CSP on post-redirect pages (e.g. `/auth/callback`), not just the initial shell
- Multi-hop redirect chains work naturally with the browser's cookie jar
- Auth state (cookies, session tokens) is preserved across redirects
- No dependency on Node.js HTTP client for following redirect chains
- One shared implementation — a fix applied once benefits both modes

### Negative

- 307/308 redirects to the target origin lose POST method and body
- Each redirect hop renders a brief synthetic HTML page (imperceptible to users in practice)
- Non-target document navigations that are not redirects incur one extra `route.fetch()` call (with `maxRedirects: 0`) compared to a plain `route.continue()`

### Neutral

- Violations from both the route-handler CSP (via headers) and the DOM event listener are deduplicated at the database level via the `UNIQUE` index on `violations`
