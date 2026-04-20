---
title: csp-analyser sessions — List Analysis Sessions
description: List CSP Analyser sessions stored in the local database, showing ID, status, timestamp, violation count, and target URL.
---

# sessions

List analysis sessions stored in the local database, showing their ID, status, timestamp, violation count, and target URL.

## Usage

```bash
csp-analyser sessions [options]
```

By default, only sessions belonging to the current project are shown. The project is auto-detected from the nearest `package.json` name, falling back to the current directory name, then to `default`. Use `--all` to show sessions from every project, or `--project` to query a specific project.

## Options

| Option             | Default       | Description                                                                                                 |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `--all`            | `false`       | Show sessions from all projects instead of only the current one.                                            |
| `--project <name>` | auto-detected | Override the auto-detected project name. Also settable via the `CSP_ANALYSER_PROJECT` environment variable. |

## Project detection

Sessions are tagged with a project name when they are created. The project name is resolved in this order:

1. `--project <name>` flag (highest priority)
2. `CSP_ANALYSER_PROJECT` environment variable
3. The `name` field from the nearest `package.json`
4. The basename of the current working directory
5. `default` (final fallback)

This means running `csp-analyser sessions` in different directories shows different sessions --- each project only sees its own data.

## Output

Each line shows:

```
<session-id>  <status>    <timestamp>               <violations>  <target-url>
```

Example:

```
a1b2c3d4-...  complete    4/12/2026, 10:30:15 AM       47 violations  https://app.example.com
e5f6g7h8-...  complete    4/12/2026, 9:15:42 AM        12 violations  https://example.com
i9j0k1l2-...  failed      4/11/2026, 3:22:08 PM         0 violations  https://broken.example.com
```

Sessions are listed newest first. Status is color-coded: completed sessions in cyan, failed sessions in red.

## Examples

### List sessions for the current project

```bash
csp-analyser sessions
```

### List sessions from all projects

```bash
csp-analyser sessions --all
```

### List sessions for a specific project

```bash
csp-analyser sessions --project my-other-app
```

## Use cases

- Find a session ID to pass to `generate`, `export`, `score`, `diff`, or `permissions`
- Check whether a previous crawl completed successfully
- Review how many violations were captured across different runs
- Use `--all` to find sessions created from a different working directory

## When to use this command

Use `sessions` to find session IDs for use with other commands like [`diff`](/cli/diff), [`export`](/cli/export), [`generate`](/cli/generate), and [`score`](/cli/score). It lists all sessions stored in your local database, filtered to the current project by default. Pass `--all` to see sessions across all projects.

## Related commands

- [`diff`](/cli/diff) — Compare two sessions from the list
- [`export`](/cli/export) — Export a specific session's policy
- [`score`](/cli/score) — Score a specific session's policy
- [`generate`](/cli/generate) — Regenerate a policy from a session
