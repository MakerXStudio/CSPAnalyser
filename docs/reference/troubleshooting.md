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

### Settlement delay too short

Some violations fire after dynamic content loads (e.g., lazy-loaded images, deferred scripts, frameworks that inject inline `<style>` blocks on route navigation). The default 2000ms settlement delay is tuned for typical SPA frameworks (Vue/Vite, React) but apps with heavy lazy-loading may need more:

```json
// MCP: increase settlementDelay
{
  "tool": "start_session",
  "targetUrl": "https://example.com",
  "settlementDelay": 5000
}
```

::: tip
The `settlementDelay` option is available through the MCP `start_session` tool. For the CLI, the default is 2000ms.
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
csp-analyser sessions
```

If the session was created from a different working directory (different project), use `--all` to see sessions across all projects:

```bash
csp-analyser sessions --all
```

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

## FAQ

### Why does my policy still show `unsafe-inline`?

By default, CSP Analyser generates a policy that reflects what the browser observed. If your site uses inline scripts or styles without nonces or hashes, the generator includes `'unsafe-inline'` to avoid breaking the page. Use `--nonce`, `--hash`, or `--strict-dynamic` to replace `'unsafe-inline'` with safer alternatives.

### Can I run CSP Analyser in Docker?

Yes, but you need to install Chromium's system dependencies inside the container. Use `npx playwright install-deps chromium` in your Dockerfile after installing CSP Analyser. See the [Installation](/getting-started/) page for platform-specific notes.

### How do I reset the database?

Delete the SQLite database file from your [data directory](/getting-started/#data-directory). CSP Analyser recreates it automatically on the next run.

### The crawl finishes instantly with 0 pages — what's wrong?

The target URL is likely returning a redirect (e.g., to a login page) that CSP Analyser does not follow. Use the [`interactive`](/cli/interactive) command to log in manually, or pass a `--storage-state` file. See the [Authentication guide](/guides/authentication) for details.
