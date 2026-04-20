---
title: Install CSP Analyser
description: Install CSP Analyser, set up Playwright Chromium, and verify the CLI on macOS, Linux, and Windows.
---

# Installation & Setup

## Prerequisites

- **Node.js 20 or later** --- CSP Analyser uses modern Node.js APIs (`node:util parseArgs`, top-level await in ESM) that require v20+.
- A Chromium-compatible browser is installed automatically by the `setup` command (see below).

## Install

### Global install (recommended)

Install once and use `csp-analyser` from any directory:

```bash
npm install -g @makerx/csp-analyser
```

### Local install as a dev dependency

If you prefer to pin the version per-project:

```bash
npm install -D @makerx/csp-analyser
```

Then run via `npx`:

```bash
npx @makerx/csp-analyser crawl https://example.com
```

## Run setup

After installing, run the `setup` command to download Chromium and any OS-level dependencies Playwright needs:

```bash
csp-analyser setup
```

This calls `npx playwright install --with-deps chromium` under the hood. It only needs to run once per machine (or after a major Playwright version bump).

::: tip
If you already have Playwright browsers installed from another project, `setup` will detect and reuse them.
:::

## Platform-specific notes

::: code-group

```bash [Debian / Ubuntu]
# setup handles this automatically, but if you need to install
# Playwright dependencies manually:
npx playwright install-deps chromium
```

```bash [Arch Linux]
# Install the system dependencies Playwright needs:
sudo pacman -S --needed nss alsa-lib atk at-spi2-core cups \
  libdrm libxcomposite libxdamage libxrandr mesa pango

# Alternatively, install playwright-chromium from the AUR:
# yay -S playwright-chromium
```

```bash [macOS]
# No extra dependencies required. setup handles everything.
csp-analyser setup
```

```bash [Windows]
# Run from PowerShell or CMD. No extra dependencies required.
csp-analyser setup
```

:::

## Data directory

CSP Analyser stores its SQLite database and session data in a platform-appropriate directory:

| Platform | Location |
|----------|----------|
| Linux | `$XDG_CONFIG_HOME/csp-analyser` (defaults to `~/.config/csp-analyser`) |
| macOS | `~/Library/Application Support/csp-analyser` |
| Windows | `%LOCALAPPDATA%\csp-analyser` |

```
csp-analyser/
  data.db     # SQLite database (sessions, violations, policies)
```

The directory is created automatically on first run.

## Verify the installation

```bash
csp-analyser --version
```

You should see the installed version number (e.g. `0.1.0`). If you installed locally, use `npx @makerx/csp-analyser --version`.

## Next steps

Head to the [Quick Start](/getting-started/quick-start) guide to generate your first CSP policy in under five minutes.

## FAQ

### Do I need to install Chromium separately?

No. The `csp-analyser setup` command downloads a compatible Chromium binary automatically via Playwright. If you already have Playwright browsers from another project, they are reused.

### Can I use CSP Analyser without a browser?

Yes. The [`hash-static`](/cli/hash-static) command generates a CSP by scanning static HTML files on disk — no browser, network, or setup step required.

### Does CSP Analyser send data to external services?

No. Everything runs locally. The tool launches a local browser, captures violations locally, and stores results in a local SQLite database.

### What Node.js version do I need?

Node.js 20 or later. CSP Analyser uses `node:util parseArgs` and top-level `await` in ESM, both of which require v20+.
