---
title: Authentication
description: How to analyse sites that require login
---

# Authentication

Many websites require authentication before they serve real content. CSP Analyser supports three authentication patterns, each suited to a different workflow.

## Storage State File

The recommended approach for repeatable, automated analysis. A storage state file is a JSON snapshot of cookies, localStorage, and sessionStorage exported by Playwright.

### Generating a storage state file

Use the `interactive` command with `--save-storage-state` to log in manually and export the session:

```bash
# Open a headed browser, log in, browse around, then close the browser
csp-analyser interactive https://app.example.com --save-storage-state auth.json
```

When you close the browser, the session's cookies, localStorage, and sessionStorage are saved to `auth.json` with secure file permissions (0600). Permissions are enforced even when overwriting an existing file, and symlink targets are rejected. You can then reuse this file for headless crawls.

::: tip Workflow: interactive login → headless crawl

```bash
# Step 1: Log in interactively and save the session
csp-analyser interactive https://app.example.com --save-storage-state auth.json

# Step 2: Use the saved session for a deep headless crawl
csp-analyser crawl https://app.example.com --storage-state auth.json --depth 3 --max-pages 50
```

This is the recommended workflow for authenticated sites. Log in once interactively, then run repeatable headless crawls with the saved state.
:::

You can also generate a storage state file with Playwright directly:

```bash
npx playwright codegen --save-storage=auth.json https://app.example.com
```

### Using a storage state file

::: code-group

```bash [CLI]
csp-analyser crawl https://app.example.com --storage-state auth.json
```

```json [MCP]
// start_session or crawl_url tool
{
  "targetUrl": "https://app.example.com",
  "storageStatePath": "/absolute/path/to/auth.json"
}
```

:::

The file must have a `.json` extension and must exist on disk. Symlinks are resolved to prevent path traversal. The real target must also end in `.json`.

## Cookie Injection

Available through the MCP tools when you already have session cookies (e.g., extracted from browser DevTools or a login API response). Cookies are injected into a fresh browser context before navigation.

```json
// MCP start_session tool - cookies parameter
{
  "targetUrl": "https://app.example.com",
  "cookies": [
    {
      "name": "session_id",
      "value": "abc123",
      "domain": "app.example.com",
      "path": "/",
      "httpOnly": true,
      "secure": true,
      "sameSite": "Lax"
    }
  ]
}
```

Only `name` and `value` are required. If `domain` is omitted, it defaults to the target URL's hostname. If `path` is omitted, it defaults to `/`.

Cookie names and values are validated against RFC 6265:

- Names must be valid HTTP tokens (no control characters, spaces, or separators)
- Values must not contain control characters, semicolons, spaces, double quotes, commas, or backslashes

## Manual Login (Interactive Mode)

For sites with complex login flows (MFA, CAPTCHA, SSO redirects) that cannot be captured as cookies or storage state.

```bash
csp-analyser interactive https://app.example.com
```

This opens a **headed** (visible) Chromium browser. You log in manually, browse the pages you want to analyse, and close the browser tab when done. CSP Analyser captures violations in real time while you browse.

::: warning
Manual login requires headed mode. It cannot be used in headless environments (CI, SSH without X11, containers). Use a storage state file for those environments.
:::

## Choosing an auth pattern

| Pattern          | Best for                                | Repeatable | CI-friendly |
| ---------------- | --------------------------------------- | :--------: | :---------: |
| Storage state    | Automated crawls, CI pipelines          |    Yes     |     Yes     |
| Cookie injection | MCP agent workflows                     |    Yes     |     Yes     |
| Manual login     | Complex auth flows, initial exploration |     No     |     No      |

## sessionStorage and token-based auth (MSAL / Azure AD B2C)

Many modern SPAs use token-based authentication (MSAL, Auth0, Firebase Auth) where tokens are stored in `sessionStorage` rather than cookies. Playwright's built-in `storageState()` only captures cookies and localStorage — sessionStorage is normally lost.

CSP Analyser extends the storage state format to also capture and restore `sessionStorage`. When you use `--save-storage-state`, sessionStorage is captured through multiple mechanisms to ensure no tokens are lost:

- **`beforeunload` handler** (via `addInitScript`) — captures the final state right before each page closes, surviving all navigations during the auth flow
- **`load` + 1s delay** — catches async MSAL token writes after auth redirects
- **5-second periodic snapshots** — catches silent token refreshes between page loads

The captured entries are written into the JSON file alongside cookies and localStorage.

When you later use `--storage-state` to load the file, CSP Analyser:

1. Passes the file to Playwright (restoring cookies + localStorage as normal)
2. Reads the `sessionStorage` extension from the file
3. Registers an `addInitScript` that calls `sessionStorage.setItem()` for each entry — this runs **before any page JavaScript**, so tokens are available when frameworks like MSAL initialize

This means MSAL access tokens, ID tokens, and refresh tokens are restored correctly:

```bash
# Step 1: Log in via Azure AD B2C and save everything
csp-analyser interactive https://app.example.com --save-storage-state auth.json

# Step 2: Headless crawl with full auth state (including sessionStorage tokens)
csp-analyser crawl https://app.example.com --storage-state auth.json
```

::: tip
If the crawl still redirects to login, the tokens have likely expired. MSAL access tokens typically expire after 1 hour. Re-run the interactive login to generate a fresh storage state file.
:::

::: warning Cross-origin sessionStorage
Only sessionStorage entries for the **target origin** are restored. Cross-origin sessionStorage (e.g. from the identity provider domain) cannot be injected and is not useful for CSP crawling.
:::

## Security notes

::: danger
Storage state files and cookies contain session secrets. Never commit them to version control.
:::

- Add `auth.json` and `*.storage-state.json` to your `.gitignore`
- Storage state files can contain localStorage and sessionStorage data, which may include auth tokens, user data, or API keys
- The `--storage-state` path is resolved through symlinks using `fs.realpathSync()` to prevent symlink-based path traversal attacks
- Cookie values are validated against RFC 6265 to prevent header injection

## FAQ

### How long does a storage state file stay valid?

It depends on the site's session expiry. Most session cookies expire after hours or days. If a crawl fails with authentication errors, regenerate the storage state by logging in again with `csp-analyser interactive --save-storage-state auth.json`.

### Can I use OAuth / SSO / MFA?

Yes — use the [`interactive`](/cli/interactive) command to log in through any browser-based flow (OAuth redirects, SAML SSO, TOTP/MFA). Once logged in, save the session with `--save-storage-state` for reuse in headless crawls.

### Does cookie injection work with the CLI?

Cookie injection is currently only available through the [MCP tools](/mcp/tools). The CLI supports storage state files (`--storage-state`) and interactive login. For CLI workflows, generate a storage state file first, then pass it to `crawl` or `audit`.

### Can I analyse multiple authenticated sites in one session?

No. Each session targets a single URL origin. Run separate crawls for each site, each with its own storage state file or cookie set.
