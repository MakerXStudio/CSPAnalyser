# setup

Install the Playwright Chromium browser and verify it can launch on your system.

## Usage

```bash
csp-analyser setup
```

This command takes no options or arguments.

## What it does

The setup command runs two steps:

1. **Install browser binary**: downloads Playwright's bundled Chromium using `npx playwright install chromium`. This does not require root/sudo.
2. **Verify launch**: attempts to launch the browser headlessly and immediately close it, confirming that all required system libraries are present.

If step 2 fails, the CLI detects your platform and prints targeted instructions for installing the missing system dependencies.

## Platform-specific handling

The setup command detects your OS and Linux distribution to provide the right fix commands when system dependencies are missing.

::: details Debian / Ubuntu
```bash
npx playwright install-deps chromium
```
This installs all required shared libraries automatically (requires sudo).
:::

::: details Arch Linux
Playwright does not officially support Arch, so `install-deps` is not available. Install dependencies manually:
```bash
# Common Chromium deps
sudo pacman -S nss alsa-lib at-spi2-core cups libdrm mesa libxkbcommon

# Or use the AUR package
yay -S playwright

# Find which package provides a specific missing library
pacman -F libXmissing.so
```
:::

::: details Fedora / RHEL
```bash
npx playwright install-deps chromium
```
:::

::: details macOS / Windows
No additional system dependencies are typically needed. The browser binary from step 1 is self-contained.
:::

## When to re-run

Run `csp-analyser setup` again if:

- You see errors about a missing browser or missing shared libraries when running `crawl` or `interactive`
- You upgraded Node.js or Playwright to a new major version
- You moved to a different machine or container

The CLI also checks for a working browser before every `crawl` and `interactive` command. If the check fails, it prints a message directing you to run `setup`.
