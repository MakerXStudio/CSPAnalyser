# CLI Reference

The `csp-analyser` CLI generates production-ready Content Security Policy headers by crawling websites, capturing violations, and building a minimal policy.

## Help text

```
csp-analyser - Generate Content Security Policy headers by crawling websites

Usage:
  csp-analyser setup                     Install Playwright browser + dependencies
  csp-analyser crawl <url>               Headless auto-crawl
  csp-analyser interactive <url>         Headed manual browsing
  csp-analyser generate <session-id>     Regenerate policy from session
  csp-analyser export <session-id>       Export policy in a format
  csp-analyser diff <id-a> <id-b>        Compare two sessions
  csp-analyser score <session-id>        Score policy against best practices
  csp-analyser sessions                  List all analysis sessions
  csp-analyser permissions <session-id>  Show Permissions-Policy headers

Options:
  --depth <n>            Crawl depth (default: 1, crawl only)
  --max-pages <n>        Max pages to visit (default: 10, crawl only)
  --strictness <level>   strict | moderate | permissive (default: moderate)
  --format <fmt>         header | meta | nginx | apache | cloudflare
                         | cloudflare-pages | json (default: header)
  --storage-state <path> Playwright storage state file for auth
  --save-storage-state <path>  Export session state after interactive browsing
  --violation-limit <n>  Max violations per session (default: 10000, 0 for unlimited)
  --report-only          Generate report-only policy
  --no-color             Disable colored output (also respects NO_COLOR env)
  --help, -h             Show this help
  --version, -v          Show version
```

## Commands

| Command | Argument | Description |
|---|---|---|
| [`setup`](./setup) | -- | Install the Playwright browser and verify it launches |
| [`crawl`](./crawl) | `<url>` | Headlessly crawl a site and generate a CSP policy |
| [`interactive`](./interactive) | `<url>` | Open a headed browser for manual navigation |
| [`generate`](./generate) | `<session-id>` | Regenerate a policy from an existing session |
| [`export`](./export) | `<session-id>` | Export a policy in a specific format |
| [`diff`](./diff) | `<id-a> <id-b>` | Compare policies and violations between two sessions |
| [`score`](./score) | `<session-id>` | Score a policy against security best practices |
| [`sessions`](./sessions) | -- | List all analysis sessions with ID, status, timestamp, and violation count |
| [`permissions`](./permissions) | `<session-id>` | Show Permissions-Policy headers captured during crawling |

## Global options

| Option | Description |
|---|---|
| `--no-color` | Disable colored terminal output. Also respects the `NO_COLOR` environment variable. |
| `--help`, `-h` | Show the help text and exit. |
| `--version`, `-v` | Print the version number and exit. |

## Output design: stdout vs stderr

The CLI separates machine-readable output from human-readable progress:

- **stdout**: the generated policy, score, diff, or export output. This is the data you want to capture.
- **stderr**: progress messages, crawl status, summary tables, and errors. This is informational and can be safely discarded.

This makes piping and redirection work naturally:

```bash
# Save the policy to a file, progress still visible in terminal
csp-analyser crawl https://example.com > policy.txt

# Pipe the policy into another tool
csp-analyser crawl https://example.com | pbcopy

# Suppress progress, keep only the policy
csp-analyser crawl https://example.com 2>/dev/null
```
