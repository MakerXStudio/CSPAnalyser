# sessions

List all analysis sessions stored in the local database, showing their ID, status, timestamp, violation count, and target URL.

## Usage

```bash
csp-analyser sessions
```

No arguments required. Lists all sessions from the `.csp-analyser/data.db` database in the current directory.

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

## Use cases

- Find a session ID to pass to `generate`, `export`, `score`, `diff`, or `permissions`
- Check whether a previous crawl completed successfully
- Review how many violations were captured across different runs
