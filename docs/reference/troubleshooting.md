---
title: Troubleshooting
description: Common issues and how to resolve them
---

# Troubleshooting

## Browser not installed

**Error:**

```
Error: Playwright browser is not installed.

Run the following command to set up:

  csp-analyser setup
```

**Cause:** Playwright's Chromium browser binary has not been downloaded yet.

**Fix:** Run the setup command:

```bash
csp-analyser setup
```

This downloads Chromium (~400MB on first install) and verifies it can launch.

## Missing system dependencies

**Error:**

```
Browser installed but cannot launch. Missing system dependencies.

Missing libraries: libnss3.so, libasound2.so, libatk-bridge-2.0.so
```

**Cause:** Chromium requires system libraries that are not installed on your OS.

**Fix depends on your platform:**

::: code-group

```bash [Debian / Ubuntu]
npx playwright install-deps chromium
```

```bash [Arch Linux]
# Option 1: Install common Chromium dependencies
sudo pacman -S nss alsa-lib at-spi2-core cups libdrm mesa libxkbcommon

# Option 2: Use the AUR package
yay -S playwright

# Option 3: Find which package provides a specific library
pacman -F libXmissing.so
```

```bash [Fedora / RHEL]
npx playwright install-deps chromium
```

:::

On **macOS** and **Windows**, no additional system dependencies are typically needed.

After installing dependencies, run `csp-analyser setup` again to verify.

## Empty violations

**Symptom:** The crawl completes but reports 0 violations.

**Possible causes and fixes:**

### The site serves no external resources

If the site only loads resources from its own origin and uses no inline scripts, there are genuinely no violations. Verify by opening the site in a browser and checking the Network tab.

### Authentication required

The site may be redirecting to a login page. The login page likely has few or no external resources. Use authentication:

```bash
# Generate storage state by logging in manually
csp-analyser interactive https://app.example.com

# Or pass an existing storage state file
csp-analyser crawl https://app.example.com --storage-state auth.json
```

### Wrong mode

If analysing a remote HTTPS site that already has a CSP header, the existing header may take precedence in local mode. Try forcing MITM mode:

```bash
csp-analyser crawl https://remote-site.com --mode mitm
```

### Settlement delay too short

Some violations fire after dynamic content loads (e.g., lazy-loaded images, deferred scripts). The default 500ms settlement delay may not be enough:

```json
// MCP: increase settlementDelay
{
  "tool": "start_session",
  "targetUrl": "https://example.com",
  "settlementDelay": 3000
}
```

::: tip
The `settlementDelay` option is available through the MCP `start_session` tool. For the CLI, the default is 500ms.
:::

## Session not found

**Error:**

```
Session not found: a1b2c3d4-...
```

**Cause:** The session ID does not exist in the database. This can happen if:

- The session ID was copied incorrectly
- The `.csp-analyser/data.db` file was deleted or the working directory changed
- The crawl failed before creating the session

**Fix:** List available sessions:

```bash
# Via MCP
# Use the list_sessions tool

# The database is stored at .csp-analyser/data.db relative to the working directory
```

## MITM proxy certificate errors

**Symptom:** Pages fail to load in MITM mode with TLS/certificate errors.

**Cause:** The MITM proxy generates a CA certificate on first use. If this certificate is corrupted or the proxy cannot write to the certificate directory, connections fail.

**Fix:**

1. Delete the certificate directory and let it regenerate:

```bash
rm -rf .csp-analyser/certs/
csp-analyser crawl https://remote-site.com --mode mitm
```

2. Ensure the `.csp-analyser/` directory is writable

## Database locked

**Error:**

```
SQLITE_BUSY: database is locked
```

**Cause:** Another process has the SQLite database open. Only one CSP Analyser instance can use the database at a time.

**Fix:** Ensure no other `csp-analyser` process is running (including MCP server instances started by AI agents). Check for zombie processes:

```bash
ps aux | grep csp-analyser
```

## High memory usage during large crawls

**Symptom:** Memory usage grows significantly when crawling with `--max-pages` set to a high value.

**Cause:** Each page keeps a browser context with DOM state. Chromium is inherently memory-intensive.

**Fix:**

- Reduce `--max-pages` to limit the scope of the crawl
- Use `--depth 0` or `--depth 1` to limit crawl depth
- Set `--violation-limit` to cap the number of stored violations (default: 10,000)

## Port conflicts

**Symptom:** The report collector fails to start with an `EADDRINUSE` error.

**Cause:** Another process is using the port that the report collector is trying to bind to. The report collector uses a random available port, so this is rare.

**Fix:** If this happens consistently, check for lingering processes from a previous run:

```bash
# Find processes on common ports
lsof -i :8080
lsof -i :3000
```

## Getting help

If none of the above solve your issue:

1. Run with debug logging: `LOG_LEVEL=debug csp-analyser crawl <url>`
2. Check the database: the `.csp-analyser/data.db` SQLite file can be inspected with any SQLite client
3. File an issue with the debug output and your OS/Node.js version
