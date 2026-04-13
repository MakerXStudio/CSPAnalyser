# Single-Mode CSP Injection

## Status

Accepted. Supersedes [CSP Injection Strategy — Dual Mode](csp-injection-strategy.md) (commit `ee4fbdb`, April 2026).

## Context

The original injection architecture ran two parallel code paths:

1. **Local mode** — Playwright `page.route()` rewrote the CSP header in the response before the browser processed it. Used for `localhost`, `127.0.0.1`, and HTTP targets.
2. **MITM mode** — An `http-mitm-proxy` instance sat between Playwright and the network. It generated a local CA certificate, configured Playwright to trust it, intercepted TLS, stripped existing `Content-Security-Policy` headers at the network layer, and injected the deny-all CSP. Used for remote HTTPS targets that shipped their own CSP.

Mode was auto-detected from the target URL, with a `--mode` override.

Dual-mode was motivated by an assumption that `page.route()` could not reliably rewrite response headers on remote HTTPS origins whose servers already set CSP — specifically, that the browser might observe the original header before Playwright's handler ran. In practice, once we wired `page.route()` to use `route.fetch()` + `route.fulfill()` (rather than letting the original response continue and patching it), Playwright gave us full control of the response headers regardless of scheme, origin, or origin-sent CSP. A focused test campaign against a set of CSP-hardened production sites (all with strict `Content-Security-Policy` response headers) showed no cases where the rewrite was bypassed.

The MITM mode carried significant cost:

- ~260 LOC of proxy and certificate-manager code plus ~400 LOC of tests
- A dedicated dependency (`http-mitm-proxy`) whose last release predated our integration and which had known compatibility concerns with modern TLS stacks
- A locally trusted CA certificate persisted under `.csp-analyser/certs/`, plus Playwright trust configuration
- Background Chrome service noise (safe-browsing, OCSP, crash reporting) routed through the proxy and cluttering logs
- Two implementations of the same deny-all CSP that had to be kept in sync
- First-run latency while the CA certificate was generated
- A non-trivial security surface — users were trusting locally generated CA keys

## Principles

- **One correct path** — a single injection code path is simpler to reason about, test, and secure than two paths kept in sync
- **Fewer dependencies** — every dependency is a supply-chain risk; removing one that is no longer needed is strictly better
- **No unnecessary local trust anchors** — avoid installing or managing CA certificates on the developer's machine if we do not have to
- **Auto-detection is overhead when there is only one mode** — if we can always pick the same path, we should

## Requirements, Constraints, and Considerations

- Must rewrite the CSP response header for every navigation and every subresource on the page, including for remote HTTPS sites that ship their own CSP
- Must strip `Content-Security-Policy` and `Content-Security-Policy-Report-Only` headers from the origin before the browser sees them
- Must include a `report-uri` and `report-to` pointing at the local report collector
- Must preserve the rest of the response (status, body, other headers) unchanged
- Must not rely on HTTP/2 server push or early hints (we do not currently observe those in any tested flow)
- Must work with all three auth modes (storage state, manual login, raw cookies)

## Options

### Keep Dual Mode

- Retain local mode and MITM mode with auto-detection
- Status quo; no change required

### Single Local Mode via `page.route()` + `route.fetch()` + `route.fulfill()`

- All responses flow through a Playwright route handler which fetches the upstream response itself, removes any CSP-related headers, adds our deny-all CSP + `Report-To`, and fulfills the response to the browser
- Works identically for HTTP, HTTPS, localhost, and remote targets
- Removes the `http-mitm-proxy` dependency and the `cert-manager` module
- Removes the `--mode` flag and the `shouldUseMitmMode()` URL classifier
- `SessionMode` becomes a single value (`'local'`) and is a candidate for removal in a future cleanup

### Single MITM Mode

- Route everything through the MITM proxy, even for localhost
- Rejected: adds the proxy overhead and CA trust surface to the common case for no benefit

### Comparison

| Criterion | Dual mode | Single local mode | Single MITM mode |
|-----------|-----------|-------------------|------------------|
| Remote HTTPS with existing CSP | MITM path | Works | Works |
| Local HTTP / localhost | Local path | Works | Overkill |
| Dependencies | `http-mitm-proxy` + Playwright | Playwright only | `http-mitm-proxy` + Playwright |
| Local trust anchors | CA certificate required | None | CA certificate required |
| First-run latency | Certificate generation | None | Certificate generation |
| Code paths to keep in sync | 2 | 1 | 1 |
| Test surface (MITM-specific) | ~400 LOC | 0 | ~400 LOC |
| Background service noise | Visible in proxy logs | None | Visible in proxy logs |

## Decision

Use **single local mode** — all CSP injection goes through Playwright `page.route()` with `route.fetch()` + `route.fulfill()`, for every target.

This was chosen because:

1. The empirical premise for MITM mode (that `page.route()` could not reliably rewrite CSP headers on remote HTTPS) did not hold up in testing
2. Removing ~1,100 LOC (including tests) and an aging dependency is a material reduction in maintenance and supply-chain surface
3. Users no longer need to trust a locally generated CA certificate for normal operation
4. The downstream pipeline (report server, violation capture, policy generator) is unchanged — only the injection site differs

## Consequences

- `SessionMode` is currently always `'local'`; the type and related plumbing can be removed in a follow-up cleanup
- The `--mode` CLI flag and the `mode` MCP tool parameter are removed (breaking change for any caller that set them explicitly; they were optional)
- `src/mitm-proxy.ts`, `src/cert-manager.ts`, and their tests are deleted; `http-mitm-proxy` is removed from `package.json`
- The `.csp-analyser/certs/` directory is no longer created or used; existing directories from prior installs can be deleted by users at leisure (we do not auto-clean)
- Test count dropped from 792 → 743 after removing MITM-specific tests

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| A future Playwright change weakens `page.route()` header rewriting | Low | High | Integration tests crawl a set of CSP-hardened remote sites; a regression would surface as zero-violation sessions on previously-working targets. We can reintroduce a narrowly-scoped proxy if needed, but we do not need to restore the full dual-mode architecture |
| HTTP/2 server push or early hints carry a CSP header that bypasses `page.route()` | Very low | Medium | Not observed in any tested flow; modern browsers and Playwright treat these uniformly. Revisit only if a real case appears |
| A target site detects and reacts to our header rewrite | Low | Low | Same risk as before — the browser already processes the rewritten headers identically to origin-sent ones |
| Users with stale `.csp-analyser/certs/` directories assume they are still needed | Low | Low | Documented in release notes; the directory is harmless if left in place |
