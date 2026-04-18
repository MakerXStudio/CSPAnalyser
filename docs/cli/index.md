# CLI Reference

The `csp-analyser` CLI generates production-ready Content Security Policy headers by crawling websites, capturing violations, and building a minimal policy.

## Help text

```
csp-analyser - Generate Content Security Policy headers by crawling websites

Usage:
  csp-analyser setup                     Install Playwright browser + dependencies
  csp-analyser start                     Run the MCP server over stdio (for AI agents)
  csp-analyser crawl <url>               Headless auto-crawl
  csp-analyser interactive <url>         Headed manual browsing
  csp-analyser audit <url>               Audit existing CSP (diff + merged policy)
  csp-analyser generate [session-id]     Regenerate policy (defaults to latest session)
  csp-analyser export [session-id]       Export policy in a format (defaults to latest)
  csp-analyser diff <id-a> <id-b>        Compare two sessions
  csp-analyser score [session-id]        Score policy (defaults to latest session)
  csp-analyser sessions                  List sessions for the current project
  csp-analyser permissions [session-id]  Show Permissions-Policy headers (defaults to latest)
  csp-analyser hash-static <path>...     Hash inline content in static HTML files
                                         and emit a CSP (no browser required)

Options:
  --depth <n>            Crawl depth (default: 1, crawl only)
  --max-pages <n>        Max pages to visit (default: 10, crawl only)
  --strictness <level>   strict | moderate | permissive (default: moderate)
  --format <fmt>         header | meta | nginx | apache | cloudflare
                         | cloudflare-pages | azure-frontdoor | helmet | json (default: header)
  --storage-state <path> Playwright storage state file for auth
  --save-storage-state <path>  Export session state after interactive browsing
  --violation-limit <n>  Max violations per session (default: 10000, 0 for unlimited)
  --nonce                Replace 'unsafe-inline' with nonce placeholders
  --strict-dynamic       Add 'strict-dynamic' with nonces (implies --nonce)
  --hash                 Remove 'unsafe-inline' when hash sources are available
  --strip-unsafe-eval    Remove 'unsafe-eval' from the generated policy
  --report-only          Generate report-only policy
  --project <name>       Override auto-detected project name
  --all                  Show sessions from all projects (sessions command)
  --no-color             Disable colored output (also respects NO_COLOR env)
  --help, -h             Show this help
  --version, -v          Show version
```

## Commands

| Command                        | Argument        | Description                                                                             |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------------- |
| [`setup`](./setup)             | --              | Install the Playwright browser and verify it launches                                   |
| [`start`](./start)             | --              | Run the MCP server over stdio (for AI coding agents)                                    |
| [`crawl`](./crawl)             | `<url>`         | Headlessly crawl a site and generate a CSP policy                                       |
| [`interactive`](./interactive) | `<url>`         | Open a headed browser for manual navigation                                             |
| [`audit`](./audit)             | `<url>`         | Audit an existing CSP: diff + updated policy for enforced and report-only headers       |
| [`generate`](./generate)       | `[session-id]`  | Regenerate a policy from an existing session                                            |
| [`export`](./export)           | `[session-id]`  | Export a policy in a specific format                                                    |
| [`diff`](./diff)               | `<id-a> <id-b>` | Compare policies and violations between two sessions                                    |
| [`score`](./score)             | `[session-id]`  | Score a policy against security best practices                                          |
| [`sessions`](./sessions)       | --              | List analysis sessions for the current project (use `--all` for all projects)           |
| [`permissions`](./permissions) | `[session-id]`  | Show Permissions-Policy headers captured during crawling                                |
| [`hash-static`](./hash-static) | `<path>...`     | Hash inline content in static HTML files and emit or inject a CSP (no browser required) |

## Global options

| Option             | Description                                                                            |
| ------------------ | -------------------------------------------------------------------------------------- |
| `--project <name>` | Override auto-detected project name. Also settable via `CSP_ANALYSER_PROJECT` env var. |
| `--all`            | Show sessions from all projects (`sessions` command only).                             |
| `--no-color`       | Disable colored terminal output. Also respects the `NO_COLOR` environment variable.    |
| `--help`, `-h`     | Show the help text and exit.                                                           |
| `--version`, `-v`  | Print the version number and exit.                                                     |

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
