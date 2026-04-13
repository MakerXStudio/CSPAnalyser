---
title: CLI Options Reference
description: Complete reference of all CLI flags and commands
---

# CLI Options Reference

## Commands

| Command | Syntax | Description |
|---------|--------|-------------|
| `setup` | `csp-analyser setup` | Install Playwright Chromium browser and verify system dependencies |
| `crawl` | `csp-analyser crawl <url>` | Headless auto-crawl with violation capture |
| `interactive` | `csp-analyser interactive <url>` | Headed manual browsing with violation capture |
| `generate` | `csp-analyser generate <session-id>` | Regenerate policy from an existing session |
| `export` | `csp-analyser export <session-id>` | Export policy in a deployment-ready format |
| `diff` | `csp-analyser diff <id-a> <id-b>` | Compare policies from two sessions |
| `score` | `csp-analyser score <session-id>` | Score policy against best practices |
| `permissions` | `csp-analyser permissions <session-id>` | Show captured Permissions-Policy headers |

## Options

| Flag | Type | Default | Commands | Description |
|------|------|---------|----------|-------------|
| `--depth <n>` | integer (0+) | `1` | `crawl` | Crawl depth. `0` = single page, `1` = target + linked pages, etc. |
| `--max-pages <n>` | integer (1+) | `10` | `crawl` | Maximum number of pages to visit during crawl |
| `--strictness <level>` | `strict` \| `moderate` \| `permissive` | `moderate` | `crawl`, `generate`, `export`, `diff`, `score` | Controls how specific source expressions are. See [strictness levels](/guides/strictness). |
| `--format <fmt>` | `header` \| `meta` \| `nginx` \| `apache` \| `cloudflare` \| `cloudflare-pages` \| `json` | `header` | `crawl`, `generate`, `export` | Output format for the generated policy. See [export formats](/guides/export-formats). |
| `--storage-state <path>` | string (file path) | -- | `crawl`, `interactive` | Path to a Playwright storage state JSON file for authenticated sessions. Must have `.json` extension. |
| `--save-storage-state <path>` | string (file path) | -- | `interactive` | Export browser cookies and storage state to a JSON file when the session ends. See [authentication guide](/guides/authentication). |
| `--violation-limit <n>` | integer (0+) | `10000` | `crawl`, `interactive` | Maximum violations to accept per session. `0` for unlimited. |
| `--report-only` | boolean | `false` | `crawl`, `generate`, `export` | Generate `Content-Security-Policy-Report-Only` instead of `Content-Security-Policy` |
| `--no-color` | boolean | `false` | all | Disable coloured terminal output. Also respects the `NO_COLOR` environment variable. |
| `--help`, `-h` | -- | -- | all | Show help text |
| `--version`, `-v` | -- | -- | all | Show version number |

## Output behaviour

- **Policy output** goes to **stdout** (pipeable to files or other tools)
- **Progress messages** and **errors** go to **stderr**
- Exit code `0` on success, `1` on error

This means you can pipe policy output directly:

```bash
# Save nginx config
csp-analyser crawl https://example.com --format nginx > csp.conf

# Pipe JSON to jq
csp-analyser export <session-id> --format json | jq '.directives'
```
