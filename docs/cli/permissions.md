# permissions

Display the Permissions-Policy (and legacy Feature-Policy) headers captured during a crawl session.

## Usage

```bash
csp-analyser permissions <session-id>
```

This command takes no additional options.

## What it shows

During crawling, the CSP Analyser captures `Permissions-Policy` and `Feature-Policy` headers from every HTTP response. The `permissions` command groups these by directive and shows:

- The **directive name** (e.g., `camera`, `geolocation`, `microphone`)
- The **allowlist** for each occurrence (e.g., `self`, specific origins, or `(none)` if the feature is disabled)
- The **header type** (`permissions-policy` or `feature-policy`)
- The **source URL** where the header was observed

## Example output

```
Permissions-Policy for session abc123

  camera
    (none)  [permissions-policy] from https://example.com/
  geolocation
    self  [permissions-policy] from https://example.com/
    self https://maps.example.com  [permissions-policy] from https://example.com/map
  microphone
    (none)  [permissions-policy] from https://example.com/
```

## When to use

- **Audit third-party permissions** -- see which browser features (camera, geolocation, payment, etc.) the site enables and for which origins
- **Complement your CSP** -- Permissions-Policy controls browser features while CSP controls resource loading; together they form a complete security header strategy
- **Detect legacy headers** -- identify sites still using the deprecated `Feature-Policy` header so you can recommend migrating to `Permissions-Policy`

## Examples

### View permissions after a crawl

```bash
csp-analyser crawl https://example.com
# Session ID: abc123

csp-analyser permissions abc123
```

### Check if no permissions were captured

If the target site does not send `Permissions-Policy` or `Feature-Policy` headers, the command prints:

```
No Permissions-Policy headers captured for this session.
```
